/**
 * Integration tests for the outbound peer sync state machine.
 *
 * These tests set up two LXMRouters with wired transports, have one store
 * a message, and verify the sync flow moves it to the other peer.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Transport } from '../src/Transport.js';
import { Identity } from '../src/Identity.js';
import { Destination } from '../src/Destination.js';
import { LXMRouter } from '../src/lxmf/LXMRouter.js';
import { LXMPeer } from '../src/lxmf/LXMPeer.js';
import { createAnnounce } from '../src/Announce.js';
import { EventEmitter } from '../src/utils/events.js';
import { toHex, randomBytes, equal } from '../src/utils/bytes.js';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import {
  PEER_IDLE, PEER_LINK_ESTABLISHING, PEER_LINK_READY,
  PEER_REQUEST_SENT, PEER_RESOURCE_TRANSFERRING,
} from '../src/lxmf/constants.js';
import { DEST_IN, DEST_SINGLE } from '../src/constants.js';

class WiredInterface extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.online = true;
    this.peer = null;
    this.sent = [];
  }
  send(data) {
    this.sent.push(new Uint8Array(data));
    if (this.peer) {
      setImmediate(() => this.peer.emit('packet', new Uint8Array(data)));
    }
  }
}

function makeWiredPair() {
  // Node A
  const ifaceA = new WiredInterface('A');
  const transportA = new Transport();
  transportA.registerInterface(ifaceA);
  const routerA = new LXMRouter(transportA, { autoStart: false });
  const idA = Identity.generate();
  routerA.enablePropagation(idA);

  // Node B
  const ifaceB = new WiredInterface('B');
  const transportB = new Transport();
  transportB.registerInterface(ifaceB);
  const routerB = new LXMRouter(transportB, { autoStart: false });
  const idB = Identity.generate();
  routerB.enablePropagation(idB);

  // Wire the two transports together
  ifaceA.peer = ifaceB;
  ifaceB.peer = ifaceA;

  return { routerA, routerB, transportA, transportB, ifaceA, ifaceB, idA, idB };
}

function addPropagationEntry(router, tidHex, data) {
  router.propagationEntries.set(tidHex, {
    destinationHash: randomBytes(16),
    data: data || randomBytes(200),
    received: Date.now() / 1000,
    size: data ? data.length : 200,
    stampValue: 0,
    handledPeers: new Set(),
    unhandledPeers: new Set(),
  });
}

describe('LXMF peer sync', () => {
  describe('LXMPeer.sync preconditions', () => {
    it('sync skips when peer is not IDLE', async () => {
      const { routerA } = makeWiredPair();
      const peer = new LXMPeer(routerA, randomBytes(16));
      peer.state = PEER_LINK_ESTABLISHING;
      const result = await peer.sync();
      expect(result).toBe(false);
    });

    it('sync skips when nextSyncAttempt is in the future', async () => {
      const { routerA } = makeWiredPair();
      const peer = new LXMPeer(routerA, randomBytes(16));
      peer.nextSyncAttempt = Date.now() / 1000 + 3600;
      peer.propagationStampCost = 0;
      peer.propagationStampCostFlexibility = 0;
      peer.peeringCost = 0;
      const result = await peer.sync();
      expect(result).toBe(false);
    });

    it('sync skips when stamp costs are unknown', async () => {
      const { routerA } = makeWiredPair();
      const peer = new LXMPeer(routerA, randomBytes(16));
      // stamp costs not set
      addPropagationEntry(routerA, 'msg1');
      peer.addUnhandledMessage('msg1');
      const result = await peer.sync();
      expect(result).toBe(false);
    });

    it('sync skips when no unhandled messages', async () => {
      const { routerA } = makeWiredPair();
      const peer = new LXMPeer(routerA, randomBytes(16));
      peer.propagationStampCost = 0;
      peer.propagationStampCostFlexibility = 0;
      peer.peeringCost = 0;
      const result = await peer.sync();
      expect(result).toBe(false);
    });

    it('sync skips when peer destination cannot be resolved', async () => {
      const { routerA } = makeWiredPair();
      const peer = new LXMPeer(routerA, randomBytes(16));
      peer.propagationStampCost = 0;
      peer.propagationStampCostFlexibility = 0;
      peer.peeringCost = 0;
      addPropagationEntry(routerA, 'msg1');
      peer.addUnhandledMessage('msg1');
      // No identity cached → can't resolve destination
      const result = await peer.sync();
      expect(result).toBe(false);
    });
  });

  describe('LXMRouter.syncPeers selection', () => {
    it('returns null when no peers have pending work', () => {
      const { routerA } = makeWiredPair();
      expect(routerA.syncPeers()).toBeNull();
    });

    it('picks an alive IDLE peer with unhandled messages', () => {
      const { routerA } = makeWiredPair();
      const destHash = randomBytes(16);
      routerA.peer(destHash, 100, 256, null, 0, 0, 0, {});
      const peer = routerA.peers.get(toHex(destHash));
      addPropagationEntry(routerA, 'msg1');
      peer.addUnhandledMessage('msg1');
      // Intercept sync() so the test doesn't try to open a real link
      let syncCalled = false;
      peer.sync = async () => { syncCalled = true; return false; };
      const selected = routerA.syncPeers();
      expect(selected).toBe(peer);
      expect(syncCalled).toBe(true);
    });

    it('skips non-alive peers', () => {
      const { routerA } = makeWiredPair();
      const destHash = randomBytes(16);
      routerA.peer(destHash, 100, 256, null, 0, 0, 0, {});
      const peer = routerA.peers.get(toHex(destHash));
      addPropagationEntry(routerA, 'msg1');
      peer.addUnhandledMessage('msg1');
      peer.alive = false;
      expect(routerA.syncPeers()).toBeNull();
    });

    it('picks fastest peer by transfer rate', () => {
      const { routerA } = makeWiredPair();
      addPropagationEntry(routerA, 'msg1');
      const h1 = randomBytes(16);
      const h2 = randomBytes(16);
      routerA.peer(h1, 100, 256, null, 0, 0, 0, {});
      routerA.peer(h2, 100, 256, null, 0, 0, 0, {});
      const p1 = routerA.peers.get(toHex(h1));
      const p2 = routerA.peers.get(toHex(h2));
      p1.addUnhandledMessage('msg1');
      p2.addUnhandledMessage('msg1');
      p1.syncTransferRate = 1000;
      p2.syncTransferRate = 10000;
      p1.sync = async () => false;
      p2.sync = async () => false;
      const selected = routerA.syncPeers();
      expect(selected).toBe(p2);
    });
  });

  describe('end-to-end peer sync (wired pair)', () => {
    it('routerA pushes a stored message to routerB via peer sync', async () => {
      const { routerA, routerB, transportA, transportB, idA, idB } = makeWiredPair();

      // Exchange announces so each side learns the other's identity + path
      const announceA = createAnnounce(routerA.propagationDestination, new Uint8Array(msgpackEncode([
        false, Math.floor(Date.now() / 1000), true, 256, 10240, [0, 0, 0], {},
      ])));
      const announceB = createAnnounce(routerB.propagationDestination, new Uint8Array(msgpackEncode([
        false, Math.floor(Date.now() / 1000), true, 256, 10240, [0, 0, 0], {},
      ])));

      // Deliver announces to the opposite transports directly
      transportA._handleAnnounce(announceB);
      transportB._handleAnnounce(announceA);

      // Verify that both sides now have each other as peers
      expect(routerA.peers.has(toHex(routerB.propagationDestination.hash))).toBe(true);
      expect(routerB.peers.has(toHex(routerA.propagationDestination.hash))).toBe(true);

      // Store a message on A and queue it for distribution.
      // Note: _lxmfPropagation computes the transient ID on the data
      // WITHOUT the trailing 32-byte propagation stamp, so both sides
      // must hash the same way for the entry to be recognised.
      const STAMP_SIZE = 32;
      const lxmfData = new Uint8Array(300);
      for (let i = 0; i < 300; i++) lxmfData[i] = i & 0xff;
      const { sha256Hash } = await import('../src/utils/crypto.js');
      const dataWithoutStamp = lxmfData.slice(0, -STAMP_SIZE);
      const transientId = sha256Hash(dataWithoutStamp);
      const tidHex = toHex(transientId);

      routerA.propagationEntries.set(tidHex, {
        destinationHash: randomBytes(16),
        data: lxmfData,
        received: Date.now() / 1000,
        size: lxmfData.length,
        stampValue: 0,
        handledPeers: new Set(),
        unhandledPeers: new Set(),
      });
      routerA.enqueuePeerDistribution(tidHex, null);
      routerA.flushPeerDistributionQueue();

      const peerB = routerA.peers.get(toHex(routerB.propagationDestination.hash));
      expect(peerB.unhandledMessageCount).toBe(1);

      // Kick off sync from A
      const syncResult = await peerB.sync();
      expect(syncResult).toBe(true);

      // After sync, the message should be handled on A's peer and
      // stored in B's propagationEntries.
      expect(peerB.handledMessageCount).toBe(1);
      expect(peerB.unhandledMessageCount).toBe(0);
      expect(routerB.propagationEntries.has(tidHex)).toBe(true);
    }, 30000);
  });
});
