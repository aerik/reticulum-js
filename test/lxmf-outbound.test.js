/**
 * Tests for LXMRouter.handleOutbound() and the outbound delivery state
 * machine. Covers method selection, path-wait retry, terminal FAILED state,
 * and a JS↔JS opportunistic round-trip over MockInterface.
 */

import { describe, it, expect, vi } from 'vitest';
import { Transport } from '../src/Transport.js';
import { Identity } from '../src/Identity.js';
import { Destination } from '../src/Destination.js';
import { LXMRouter } from '../src/lxmf/LXMRouter.js';
import {
  LXMessage,
  OPPORTUNISTIC, DIRECT, PROPAGATED,
  OUTBOUND, SENT, DELIVERED, FAILED,
} from '../src/lxmf/LXMessage.js';
import { EventEmitter } from '../src/utils/events.js';
import { toHex } from '../src/utils/bytes.js';
import { DEST_IN, DEST_SINGLE } from '../src/constants.js';

class MockInterface extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.online = true;
    this.sent = [];
  }
  send(data) { this.sent.push(new Uint8Array(data)); }
}

function makeRouter({ withReceiver = false } = {}) {
  const iface = new MockInterface('mock');
  const transport = new Transport();
  transport.registerInterface(iface);

  const myIdentity = Identity.generate();
  const router = new LXMRouter(transport, { autoStart: false });
  const deliveryDest = router.registerDeliveryIdentity(myIdentity, { displayName: 'Test' });

  if (withReceiver) {
    // Register a second identity for receiving (simulates remote peer)
    const peerIdentity = Identity.generate();
    const peerDest = new Destination(peerIdentity, DEST_IN, DEST_SINGLE, 'lxmf', 'delivery');
    transport.announceTable.set(toHex(peerDest.hash), {
      identity: Identity.fromPublicKey(peerIdentity.publicKey),
      appData: null, hops: 1, timestamp: Date.now() / 1000,
    });
    transport.pathTable.set(toHex(peerDest.hash), {
      timestamp: Date.now() / 1000,
      nextHop: peerDest.hash,
      hops: 1,
      interface: iface,
      expires: Date.now() / 1000 + 60,
    });
    return { router, transport, iface, myIdentity, deliveryDest, peerIdentity, peerDest };
  }

  return { router, transport, iface, myIdentity, deliveryDest };
}

describe('LXMRouter.handleOutbound — method selection', () => {
  it('auto-selects OPPORTUNISTIC for a small message with known path', async () => {
    const { router, peerDest } = makeRouter({ withReceiver: true });

    const msg = new LXMessage({
      destinationHash: peerDest.hash,
      title: 'hi',
      content: 'hello',
    });

    router.handleOutbound(msg);

    // Let the immediate dispatch (fire-and-forget) resolve
    await new Promise(r => setTimeout(r, 20));

    expect(msg.method).toBe(OPPORTUNISTIC);
    expect(msg.state).toBe(SENT);
    router.stop();
  });

  it('honors explicit desiredMethod = DIRECT for a small message', async () => {
    const { router, peerDest } = makeRouter({ withReceiver: true });

    const msg = new LXMessage({
      destinationHash: peerDest.hash,
      title: 'hi',
      content: 'hello',
      desiredMethod: DIRECT,
    });

    router.handleOutbound(msg);
    expect(msg.method).toBe(DIRECT);
    // State starts OUTBOUND — direct needs a link that won't establish in this
    // mock, so we don't wait for DELIVERED here. Just confirm it's queued.
    expect(router.pendingOutbound.size).toBe(1);
    router.stop();
  });

  it('auto-selects DIRECT for a large message', async () => {
    const { router, peerDest } = makeRouter({ withReceiver: true });

    const big = 'x'.repeat(2000);
    const msg = new LXMessage({
      destinationHash: peerDest.hash,
      content: big,
    });

    router.handleOutbound(msg);
    expect(msg.method).toBe(DIRECT);
    router.stop();
  });

  it('rejects PROPAGATED without a propagationNodeHash', () => {
    const { router, peerDest } = makeRouter({ withReceiver: true });
    const msg = new LXMessage({
      destinationHash: peerDest.hash,
      content: 'x',
      desiredMethod: PROPAGATED,
    });

    expect(() => router.handleOutbound(msg)).toThrow(/propagationNodeHash/);
    expect(msg.state).toBe(FAILED);
    router.stop();
  });
});

describe('LXMRouter.handleOutbound — path resolution', () => {
  it('calls transport.requestPath when destination identity is unknown', async () => {
    const { router, transport } = makeRouter();
    const unknownHash = new Uint8Array(16).fill(0xab);
    const requestPathSpy = vi.spyOn(transport, 'requestPath').mockImplementation(() => {});

    const msg = new LXMessage({
      destinationHash: unknownHash,
      title: 't',
      content: 'c',
      desiredMethod: OPPORTUNISTIC,
    });

    router.handleOutbound(msg);
    await new Promise(r => setTimeout(r, 20));

    expect(requestPathSpy).toHaveBeenCalled();
    expect(msg.state).toBe(OUTBOUND); // still queued, waiting for path
    expect(router.pendingOutbound.size).toBe(1);
    router.stop();
  });

  it('marks message FAILED after MAX_DELIVERY_ATTEMPTS', async () => {
    const { router, transport } = makeRouter();
    vi.spyOn(transport, 'requestPath').mockImplementation(() => {});

    router.DELIVERY_RETRY_WAIT = 1; // basically immediate
    router.MAX_DELIVERY_ATTEMPTS = 2;

    const unknownHash = new Uint8Array(16).fill(0xcd);
    const failedSpy = vi.fn();
    const msg = new LXMessage({
      destinationHash: unknownHash,
      content: 'c',
      desiredMethod: OPPORTUNISTIC,
      failedCallback: failedSpy,
    });

    router.handleOutbound(msg);

    // Tick the processor a few times to exhaust attempts
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 5));
      router._processOutbound();
    }

    expect(msg.state).toBe(FAILED);
    expect(failedSpy).toHaveBeenCalledWith(msg);
    router.stop();
  });
});

describe('LXMRouter.handleOutbound — opportunistic end-to-end', () => {
  it('delivers a small message between two routers over a mock transport', async () => {
    // --- Receiver ---
    const recvIface = new MockInterface('recv');
    const recvTransport = new Transport();
    recvTransport.registerInterface(recvIface);
    const recvIdentity = Identity.generate();
    const recvRouter = new LXMRouter(recvTransport, { autoStart: false });
    const recvDeliveryDest = recvRouter.registerDeliveryIdentity(
      recvIdentity, { displayName: 'Receiver' }
    );

    // --- Sender ---
    const sendIface = new MockInterface('send');
    const sendTransport = new Transport();
    sendTransport.registerInterface(sendIface);
    const sendIdentity = Identity.generate();
    const sendRouter = new LXMRouter(sendTransport, { autoStart: false });
    sendRouter.registerDeliveryIdentity(sendIdentity, { displayName: 'Sender' });

    // Seed the sender with knowledge of the receiver's identity + path
    sendTransport.announceTable.set(toHex(recvDeliveryDest.hash), {
      identity: Identity.fromPublicKey(recvIdentity.publicKey),
      appData: null, hops: 1, timestamp: Date.now() / 1000,
    });
    sendTransport.pathTable.set(toHex(recvDeliveryDest.hash), {
      timestamp: Date.now() / 1000,
      nextHop: recvDeliveryDest.hash,
      hops: 1,
      interface: sendIface,
      expires: Date.now() / 1000 + 60,
    });

    // Wire the mock transports together: whatever send transmits, deliver to recv
    const origSendSend = sendIface.send.bind(sendIface);
    sendIface.send = (data) => {
      origSendSend(data);
      setTimeout(() => recvIface.emit('packet', new Uint8Array(data)), 1);
    };

    // Collect received messages on the receiver
    const received = [];
    recvRouter.onMessage((m) => received.push(m));

    // Send!
    const msg = new LXMessage({
      destinationHash: recvDeliveryDest.hash,
      title: 'hello',
      content: 'round-trip test',
      desiredMethod: OPPORTUNISTIC,
    });
    sendRouter.handleOutbound(msg);

    // Wait for async encrypt + transmit + receive + decrypt
    await new Promise(r => setTimeout(r, 200));

    expect(msg.state).toBe(SENT);
    expect(received.length).toBe(1);
    expect(received[0].title).toBe('hello');
    expect(received[0].content).toBe('round-trip test');

    sendRouter.stop();
    recvRouter.stop();
  });
});
