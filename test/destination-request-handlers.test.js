/**
 * Tests for Destination.registerRequestHandler with ALLOW_NONE / ALLOW_ALL /
 * ALLOW_LIST policies, and Link.identify() for remote identity establishment.
 */

import { describe, it, expect } from 'vitest';
import { Link, LINK_ACTIVE } from '../src/Link.js';
import { Transport } from '../src/Transport.js';
import { Identity } from '../src/Identity.js';
import { Destination, ALLOW_NONE, ALLOW_ALL, ALLOW_LIST } from '../src/Destination.js';
import { EventEmitter } from '../src/utils/events.js';
import { toHex, fromUtf8, equal, randomBytes } from '../src/utils/bytes.js';
import { DEST_SINGLE, DEST_IN } from '../src/constants.js';

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

async function setupLinkedPair() {
  const responderIdentity = Identity.generate();
  const responderDest = new Destination(responderIdentity, DEST_IN, DEST_SINGLE, 'test', 'req');

  const responderIface = new WiredInterface('responder');
  const responderTransport = new Transport();
  responderTransport.registerInterface(responderIface);
  responderTransport.registerDestination(responderDest);
  responderDest.setLinkCallback(() => true);

  const initiatorIface = new WiredInterface('initiator');
  const initiatorTransport = new Transport();
  initiatorTransport.registerInterface(initiatorIface);

  initiatorIface.peer = responderIface;
  responderIface.peer = initiatorIface;

  initiatorTransport.announceTable.set(toHex(responderDest.hash), {
    identity: Identity.fromPublicKey(responderIdentity.publicKey),
    appData: null, hops: 1, timestamp: Date.now() / 1000,
  });

  const initiatorLink = Link.init(responderDest, initiatorTransport);
  initiatorTransport.registerPendingLink(initiatorLink);

  await new Promise(r => initiatorLink.on('established', r));
  await new Promise(r => setImmediate(r));

  let responderLink = null;
  for (const [, link] of responderTransport.linkTable) {
    if (link !== initiatorLink) { responderLink = link; break; }
  }

  return { initiatorLink, responderLink, responderDest, responderIdentity };
}

/**
 * Identify the initiator and wait until the responder has processed the
 * CONTEXT_LINKIDENTIFY packet (async due to decrypt). Polls the
 * responderLink._remoteIdentity for up to 500ms.
 */
async function identifyAndWait(initiatorLink, responderLink, identity) {
  await initiatorLink.identify(identity);
  const deadline = Date.now() + 500;
  while (responderLink._remoteIdentity == null && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10));
  }
}

describe('Destination.registerRequestHandler', () => {
  it('registers a handler keyed by truncated path hash', () => {
    const id = Identity.generate();
    const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'test', 'req');
    let called = false;
    dest.registerRequestHandler('/echo', async () => { called = true; });
    expect(dest.requestHandlers.size).toBe(1);
    expect(called).toBe(false);
  });

  it('rejects invalid parameters', () => {
    const id = Identity.generate();
    const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'test', 'req');
    expect(() => dest.registerRequestHandler('', () => {})).toThrow();
    expect(() => dest.registerRequestHandler('/x', null)).toThrow();
    expect(() => dest.registerRequestHandler('/x', () => {}, { allow: 0xFF })).toThrow();
  });

  it('deregisterRequestHandler removes the handler', () => {
    const id = Identity.generate();
    const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'test', 'req');
    dest.registerRequestHandler('/x', () => {});
    expect(dest.deregisterRequestHandler('/x')).toBe(true);
    expect(dest.requestHandlers.size).toBe(0);
    expect(dest.deregisterRequestHandler('/x')).toBe(false);
  });
});

describe('Destination handlers over Link dispatch', () => {
  it('ALLOW_NONE rejects the request silently', async () => {
    const { initiatorLink, responderDest } = await setupLinkedPair();

    let called = false;
    responderDest.registerRequestHandler('/secret',
      async () => { called = true; return fromUtf8('ok'); },
      { allow: ALLOW_NONE });

    const response = await initiatorLink.request('/secret', null, 300);
    expect(response).toBeNull();
    expect(called).toBe(false);
  });

  it('ALLOW_ALL dispatches to the handler and returns data', async () => {
    const { initiatorLink, responderDest } = await setupLinkedPair();

    let receivedPath = null;
    let receivedData = null;
    responderDest.registerRequestHandler('/echo',
      async (path, data, requestId, remoteIdentity, ts) => {
        receivedPath = path;
        receivedData = data;
        return fromUtf8('pong');
      },
      { allow: ALLOW_ALL });

    const response = await initiatorLink.request('/echo', fromUtf8('ping'));
    expect(response).not.toBeNull();
    expect(equal(response, fromUtf8('pong'))).toBe(true);
    expect(receivedPath).toBe('/echo');
    expect(equal(receivedData, fromUtf8('ping'))).toBe(true);
  });

  it('ALLOW_LIST denies when remoteIdentity is null', async () => {
    const { initiatorLink, responderDest } = await setupLinkedPair();

    let called = false;
    responderDest.registerRequestHandler('/admin',
      async () => { called = true; return fromUtf8('ok'); },
      { allow: ALLOW_LIST, allowedList: [randomBytes(16)] });

    const response = await initiatorLink.request('/admin', null, 300);
    expect(response).toBeNull();
    expect(called).toBe(false);
  });

  it('ALLOW_LIST denies when remoteIdentity is not in the list', async () => {
    const { initiatorLink, responderLink, responderDest } = await setupLinkedPair();

    // Identify with a random identity
    const someIdentity = Identity.generate();
    await identifyAndWait(initiatorLink, responderLink, someIdentity);

    expect(responderLink._remoteIdentity).not.toBeNull();

    let called = false;
    responderDest.registerRequestHandler('/admin',
      async () => { called = true; return fromUtf8('ok'); },
      { allow: ALLOW_LIST, allowedList: [randomBytes(16)] }); // wrong list

    const response = await initiatorLink.request('/admin', null, 300);
    expect(response).toBeNull();
    expect(called).toBe(false);
  });

  it('ALLOW_LIST accepts when remoteIdentity hash is in the allowedList', async () => {
    const { initiatorLink, responderLink, responderDest } = await setupLinkedPair();

    const adminIdentity = Identity.generate();
    await identifyAndWait(initiatorLink, responderLink, adminIdentity);

    responderDest.registerRequestHandler('/admin',
      async (path, data, requestId, remoteIdentity) => {
        expect(remoteIdentity).not.toBeNull();
        expect(equal(remoteIdentity.hash, adminIdentity.hash)).toBe(true);
        return fromUtf8('welcome');
      },
      { allow: ALLOW_LIST, allowedList: [adminIdentity.hash] });

    const response = await initiatorLink.request('/admin', null, 3000);
    expect(response).not.toBeNull();
    expect(equal(response, fromUtf8('welcome'))).toBe(true);
  });
});

describe('Link.identify()', () => {
  it('sets _remoteIdentity on the responder side', async () => {
    const { initiatorLink, responderLink } = await setupLinkedPair();
    const identity = Identity.generate();

    expect(responderLink._remoteIdentity).toBeNull();

    await identifyAndWait(initiatorLink, responderLink, identity);

    expect(responderLink._remoteIdentity).not.toBeNull();
    expect(equal(responderLink._remoteIdentity.hash, identity.hash)).toBe(true);
    expect(equal(responderLink._remoteIdentity.publicKey, identity.publicKey)).toBe(true);
  });

  it('getRemoteIdentity returns the identified peer', async () => {
    const { initiatorLink, responderLink } = await setupLinkedPair();
    const identity = Identity.generate();
    await identifyAndWait(initiatorLink, responderLink, identity);
    const remote = responderLink.getRemoteIdentity();
    expect(remote).not.toBeNull();
    expect(equal(remote.hash, identity.hash)).toBe(true);
  });

  it('fires the onRemoteIdentified callback', async () => {
    const { initiatorLink, responderLink } = await setupLinkedPair();
    const identity = Identity.generate();
    let callbackIdentity = null;
    responderLink.onRemoteIdentified((link, id) => { callbackIdentity = id; });
    await identifyAndWait(initiatorLink, responderLink, identity);
    expect(callbackIdentity).not.toBeNull();
    expect(equal(callbackIdentity.hash, identity.hash)).toBe(true);
  });

  it('rejects identify from responder side', async () => {
    const { responderLink } = await setupLinkedPair();
    const identity = Identity.generate();
    await expect(responderLink.identify(identity)).rejects.toThrow(/initiator/i);
  });

  it('rejects identify with public-only identity', async () => {
    const { initiatorLink } = await setupLinkedPair();
    const full = Identity.generate();
    const pubOnly = Identity.fromPublicKey(full.publicKey);
    await expect(initiatorLink.identify(pubOnly)).rejects.toThrow();
  });
});
