import { describe, it, expect } from 'vitest';
import { Link, LINK_ACTIVE } from '../src/Link.js';
import { Transport } from '../src/Transport.js';
import { Identity } from '../src/Identity.js';
import { Destination } from '../src/Destination.js';
import { EventEmitter } from '../src/utils/events.js';
import { toHex, fromUtf8, equal } from '../src/utils/bytes.js';
import { DEST_SINGLE, DEST_IN, CONTEXT_REQUEST, CONTEXT_RESPONSE } from '../src/constants.js';

class MockInterface extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.online = true;
    this.sent = [];
  }
  send(data) {
    this.sent.push(new Uint8Array(data));
  }
}

/**
 * Set up a linked pair with bidirectional packet routing.
 * Returns after both sides are ACTIVE.
 */
async function setupLinkedPairWithRouting() {
  const responderIdentity = Identity.generate();
  const responderDest = new Destination(responderIdentity, DEST_IN, DEST_SINGLE, 'test', 'rpc');

  const responderIface = new MockInterface('responder');
  const responderTransport = new Transport();
  responderTransport.registerInterface(responderIface);
  responderTransport.registerDestination(responderDest);
  responderDest.setLinkCallback(() => true);

  const initiatorIface = new MockInterface('initiator');
  const initiatorTransport = new Transport();
  initiatorTransport.registerInterface(initiatorIface);

  // Cache responder identity
  initiatorTransport.announceTable.set(toHex(responderDest.hash), {
    identity: Identity.fromPublicKey(responderIdentity.publicKey),
    appData: null, hops: 1, timestamp: Date.now() / 1000,
  });

  // Step 1: Link request
  const initiatorLink = Link.init(responderDest, initiatorTransport);
  initiatorTransport.registerPendingLink(initiatorLink);

  // Deliver link request to responder
  responderIface.emit('packet', initiatorIface.sent[0]);

  // Deliver proof to initiator (wait for async handleProof)
  const established = new Promise(resolve => initiatorLink.on('established', resolve));
  initiatorIface.emit('packet', responderIface.sent[0]);
  await established;

  // Deliver RTT to responder
  responderIface.emit('packet', initiatorIface.sent[1]);

  // Get responder's link
  let responderLink = null;
  for (const [, link] of responderTransport.linkTable) {
    if (link !== initiatorLink) { responderLink = link; break; }
  }

  // Now set up bidirectional routing: when one interface "sends", deliver to the other
  const route = (fromIface, toIface, startIdx) => {
    const origSend = fromIface.send.bind(fromIface);
    fromIface.send = (data) => {
      origSend(data);
      // Deliver to the other side
      setTimeout(() => toIface.emit('packet', new Uint8Array(data)), 1);
    };
  };

  route(initiatorIface, responderIface);
  route(responderIface, initiatorIface);

  return { initiatorLink, responderLink, initiatorTransport, responderTransport };
}

describe('Link request/response', () => {
  it('sends a request and receives a response', async () => {
    const { initiatorLink, responderLink } = await setupLinkedPairWithRouting();

    // Register handler on responder
    responderLink.registerRequestHandler('/echo', async (data) => {
      return data; // Echo back
    });

    // Send request from initiator
    const requestData = fromUtf8('Hello RNS!');
    const response = await initiatorLink.request('/echo', requestData, 5000);

    expect(response).not.toBeNull();
    expect(equal(response, requestData)).toBe(true);
  });

  it('handles null request data', async () => {
    const { initiatorLink, responderLink } = await setupLinkedPairWithRouting();

    responderLink.registerRequestHandler('/ping', async () => {
      return fromUtf8('pong');
    });

    const response = await initiatorLink.request('/ping', null, 5000);
    expect(response).not.toBeNull();
    expect(new TextDecoder().decode(response)).toBe('pong');
  });

  it('handler returning null sends no response (matches Python)', async () => {
    // Python's Link.handle_request (RNS/Link.py:889) only sends a
    // RESPONSE packet when the handler returns non-None. A null response
    // means "don't respond at all", which the initiator observes as a
    // timeout.
    const { initiatorLink, responderLink } = await setupLinkedPairWithRouting();

    responderLink.registerRequestHandler('/void', async () => {
      return null;
    });

    const response = await initiatorLink.request('/void', fromUtf8('data'), 500);
    expect(response).toBeNull();
  });

  it('times out when no handler is registered', async () => {
    const { initiatorLink } = await setupLinkedPairWithRouting();

    const response = await initiatorLink.request('/nonexistent', null, 200);
    expect(response).toBeNull(); // timeout
  });

  it('handles multiple concurrent requests', async () => {
    const { initiatorLink, responderLink } = await setupLinkedPairWithRouting();

    responderLink.registerRequestHandler('/upper', async (data) => {
      const text = new TextDecoder().decode(data);
      return new TextEncoder().encode(text.toUpperCase());
    });

    const results = await Promise.all([
      initiatorLink.request('/upper', fromUtf8('hello'), 5000),
      initiatorLink.request('/upper', fromUtf8('world'), 5000),
      initiatorLink.request('/upper', fromUtf8('rns'), 5000),
    ]);

    expect(new TextDecoder().decode(results[0])).toBe('HELLO');
    expect(new TextDecoder().decode(results[1])).toBe('WORLD');
    expect(new TextDecoder().decode(results[2])).toBe('RNS');
  });
});
