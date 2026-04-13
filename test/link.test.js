import { describe, it, expect, beforeEach } from 'vitest';
import {
  Link, LINK_PENDING, LINK_HANDSHAKE, LINK_ACTIVE, LINK_CLOSED,
  ACCEPT_NONE, ACCEPT_APP, ACCEPT_ALL,
  RequestReceipt, REQUEST_SENT, REQUEST_READY, REQUEST_FAILED,
} from '../src/Link.js';
import { Transport } from '../src/Transport.js';
import { Identity } from '../src/Identity.js';
import { Destination } from '../src/Destination.js';
import { Packet } from '../src/Packet.js';
import { createAnnounce } from '../src/Announce.js';
import { EventEmitter } from '../src/utils/events.js';
import { toHex, fromUtf8, equal, randomBytes } from '../src/utils/bytes.js';
import {
  DEST_SINGLE, DEST_IN, DEST_OUT,
  PACKET_LINK_REQUEST, PACKET_PROOF, PACKET_DATA,
  DEST_LINK, HEADER_1, TRANSPORT_BROADCAST,
  CONTEXT_LRPROOF, CONTEXT_LRRTT, CONTEXT_NONE, CONTEXT_KEEPALIVE, CONTEXT_LINKCLOSE,
} from '../src/constants.js';

// Mock interface that captures sent packets and allows injecting received packets
class MockInterface extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.online = true;
    this.sent = [];
  }
  send(data) {
    this.sent.push(new Uint8Array(data));
    if (this.peer) {
      setImmediate(() => this.peer.emit('packet', new Uint8Array(data)));
    }
  }
}

/**
 * Simulate a full link establishment between two local transport instances.
 * Returns { initiatorLink, responderLink, initiatorTransport, responderTransport }
 */
async function setupLinkedPair() {
  // Responder side: identity, destination, transport
  const responderIdentity = Identity.generate();
  const responderDest = new Destination(responderIdentity, DEST_IN, DEST_SINGLE, 'test', 'link');

  const responderIface = new MockInterface('responder');
  const responderTransport = new Transport();
  responderTransport.registerInterface(responderIface);
  responderTransport.registerDestination(responderDest);

  // Accept all links
  responderDest.setLinkCallback(() => true);

  // Initiator side
  const initiatorIface = new MockInterface('initiator');
  const initiatorTransport = new Transport();
  initiatorTransport.registerInterface(initiatorIface);

  // Cache the responder's identity so the initiator can verify proofs
  initiatorTransport.announceTable.set(toHex(responderDest.hash), {
    identity: Identity.fromPublicKey(responderIdentity.publicKey),
    appData: null,
    hops: 1,
    timestamp: Date.now() / 1000,
  });

  // Step 1: Initiator sends link request
  const initiatorLink = Link.init(responderDest, initiatorTransport);
  initiatorTransport.registerPendingLink(initiatorLink);

  expect(initiatorLink.status).toBe(LINK_PENDING);
  expect(initiatorIface.sent).toHaveLength(1);

  // Step 2: Deliver the link request to the responder
  const linkRequestRaw = initiatorIface.sent[0];
  responderIface.emit('packet', linkRequestRaw);

  // Responder should have created a link and sent a proof
  expect(responderIface.sent).toHaveLength(1); // proof packet

  // Step 3: Deliver the proof to the initiator
  // handleProof is async (sends encrypted RTT), so wait for the 'established' event
  const proofRaw = responderIface.sent[0];
  const established = new Promise((resolve) => {
    initiatorLink.on('established', resolve);
  });
  initiatorIface.emit('packet', proofRaw);
  await established;

  // Initiator should now be ACTIVE and have sent an RTT packet
  expect(initiatorLink.status).toBe(LINK_ACTIVE);
  expect(initiatorIface.sent).toHaveLength(2); // link request + RTT

  // Step 4: Deliver the RTT packet to the responder
  const rttRaw = initiatorIface.sent[1];
  responderIface.emit('packet', rttRaw);

  // Find the responder's link
  let responderLink = null;
  for (const [, link] of responderTransport.linkTable) {
    if (link !== initiatorLink) {
      responderLink = link;
      break;
    }
  }

  expect(responderLink).not.toBeNull();
  expect(responderLink.status).toBe(LINK_ACTIVE);

  return {
    initiatorLink,
    responderLink,
    initiatorTransport,
    responderTransport,
    initiatorIface,
    responderIface,
  };
}

/**
 * Like setupLinkedPair but with auto-piped interfaces so resource transfers
 * can flow end-to-end without manual packet relay.
 */
async function setupLinkedPairWired() {
  const responderIdentity = Identity.generate();
  const responderDest = new Destination(responderIdentity, DEST_IN, DEST_SINGLE, 'test', 'link');

  const responderIface = new MockInterface('responder');
  const responderTransport = new Transport();
  responderTransport.registerInterface(responderIface);
  responderTransport.registerDestination(responderDest);
  responderDest.setLinkCallback(() => true);

  const initiatorIface = new MockInterface('initiator');
  const initiatorTransport = new Transport();
  initiatorTransport.registerInterface(initiatorIface);

  // Wire the two interfaces so packets flow bidirectionally
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

  return { initiatorLink, responderLink, initiatorTransport, responderTransport };
}

describe('Link', () => {
  describe('linkIdFromPacket', () => {
    it('computes a 16-byte link ID', () => {
      const pkt = new Packet();
      pkt.packetType = PACKET_LINK_REQUEST;
      pkt.destType = DEST_SINGLE;
      pkt.destinationHash = randomBytes(16);
      pkt.data = randomBytes(64); // enc pub + sig pub
      pkt.pack();

      const linkId = Link.linkIdFromPacket(pkt);
      expect(linkId).toHaveLength(16);
    });

    it('strips signalling bytes from hash input', () => {
      const destHash = randomBytes(16);
      const keyData = randomBytes(64);

      // Without signalling
      const pkt1 = new Packet();
      pkt1.packetType = PACKET_LINK_REQUEST;
      pkt1.destType = DEST_SINGLE;
      pkt1.destinationHash = destHash;
      pkt1.data = keyData;
      pkt1.pack();

      // With signalling
      const pkt2 = new Packet();
      pkt2.packetType = PACKET_LINK_REQUEST;
      pkt2.destType = DEST_SINGLE;
      pkt2.destinationHash = new Uint8Array(destHash);
      const concat = new Uint8Array(64 + 3);
      concat.set(keyData);
      concat.set(new Uint8Array([0x01, 0x02, 0x03]), 64);
      pkt2.data = concat;
      pkt2.pack();

      const id1 = Link.linkIdFromPacket(pkt1);
      const id2 = Link.linkIdFromPacket(pkt2);
      expect(equal(id1, id2)).toBe(true);
    });
  });

  describe('full handshake', () => {
    it('establishes a link between two transports', async () => {
      const { initiatorLink, responderLink } = await setupLinkedPair();

      expect(initiatorLink.status).toBe(LINK_ACTIVE);
      expect(responderLink.status).toBe(LINK_ACTIVE);

      // Both should have the same link ID
      expect(equal(initiatorLink.linkId, responderLink.linkId)).toBe(true);

      // Both should have session keys
      expect(initiatorLink._encryptionKey).not.toBeNull();
      expect(responderLink._encryptionKey).not.toBeNull();
    });

    it('derives matching session keys', async () => {
      const { initiatorLink, responderLink } = await setupLinkedPair();

      // Both sides should derive the same keys
      expect(equal(initiatorLink._signingKey, responderLink._signingKey)).toBe(true);
      expect(equal(initiatorLink._encryptionKey, responderLink._encryptionKey)).toBe(true);
    });
  });

  describe('encrypt/decrypt', () => {
    it('encrypts and decrypts data', async () => {
      const { initiatorLink } = await setupLinkedPair();

      const plaintext = fromUtf8('Hello over encrypted link!');
      const encrypted = await initiatorLink.encrypt(plaintext);

      // Encrypted should be larger (IV + ciphertext + HMAC)
      expect(encrypted.length).toBeGreaterThan(plaintext.length);

      const decrypted = await initiatorLink.decrypt(encrypted);
      expect(equal(decrypted, plaintext)).toBe(true);
    });

    it('cross-decrypts between initiator and responder', async () => {
      const { initiatorLink, responderLink } = await setupLinkedPair();

      // Initiator encrypts, responder decrypts
      const msg1 = fromUtf8('From initiator');
      const enc1 = await initiatorLink.encrypt(msg1);
      const dec1 = await responderLink.decrypt(enc1);
      expect(equal(dec1, msg1)).toBe(true);

      // Responder encrypts, initiator decrypts
      const msg2 = fromUtf8('From responder');
      const enc2 = await responderLink.encrypt(msg2);
      const dec2 = await initiatorLink.decrypt(enc2);
      expect(equal(dec2, msg2)).toBe(true);
    });

    it('rejects tampered ciphertext', async () => {
      const { initiatorLink, responderLink } = await setupLinkedPair();

      const encrypted = await initiatorLink.encrypt(fromUtf8('secret'));
      // Tamper with ciphertext
      encrypted[20] ^= 0xFF;

      await expect(responderLink.decrypt(encrypted)).rejects.toThrow(/HMAC/);
    });
  });

  describe('keepalive', () => {
    it('responder replies to keepalive request', async () => {
      const { responderLink, responderIface } = await setupLinkedPair();

      const sentBefore = responderIface.sent.length;
      responderLink.handleKeepalive(new Uint8Array([0xFF])); // request

      // Should have sent a response
      expect(responderIface.sent.length).toBe(sentBefore + 1);
    });
  });

  describe('close', () => {
    it('closes and zeroes keys', async () => {
      const { initiatorLink } = await setupLinkedPair();

      expect(initiatorLink._encryptionKey).not.toBeNull();

      await initiatorLink.close();

      expect(initiatorLink.status).toBe(LINK_CLOSED);
      expect(initiatorLink._encryptionKey).toBeNull();
      expect(initiatorLink._signingKey).toBeNull();
      expect(initiatorLink._sharedKey).toBeNull();
    });

    it('emits closed event', async () => {
      const { initiatorLink } = await setupLinkedPair();

      let closedReason = null;
      initiatorLink.on('closed', (reason) => { closedReason = reason; });

      await initiatorLink.close();
      expect(closedReason).not.toBeNull();
    });
  });

  describe('resource_strategy', () => {
    it('defaults to ACCEPT_NONE', async () => {
      const { responderLink } = await setupLinkedPair();
      expect(responderLink.resourceStrategy).toBe(ACCEPT_NONE);
    });

    it('setResourceStrategy validates input', async () => {
      const { responderLink } = await setupLinkedPair();
      expect(() => responderLink.setResourceStrategy(0xFF)).toThrow(/Unsupported/);
      responderLink.setResourceStrategy(ACCEPT_ALL);
      expect(responderLink.resourceStrategy).toBe(ACCEPT_ALL);
    });

    it('ACCEPT_NONE silently ignores resource ADV', async () => {
      const { initiatorLink, responderLink } = await setupLinkedPairWired();
      responderLink.setResourceStrategy(ACCEPT_NONE);

      let completed = false;
      responderLink.on('resource_complete', () => { completed = true; });

      // Send a resource — it should be silently ignored on the responder
      const sendPromise = initiatorLink.sendResource(randomBytes(100), { timeoutMs: 500 });
      await expect(sendPromise).rejects.toThrow(/timeout/i);
      expect(completed).toBe(false);
    });

    it('ACCEPT_ALL auto-accepts resources', async () => {
      const { initiatorLink, responderLink } = await setupLinkedPairWired();
      responderLink.setResourceStrategy(ACCEPT_ALL);

      const data = randomBytes(500);
      const receivePromise = new Promise((resolve) => {
        responderLink.on('resource_complete', (d) => resolve(d));
      });

      const bytes = await initiatorLink.sendResource(data, { timeoutMs: 5000 });
      expect(bytes).toBe(500);

      const received = await receivePromise;
      expect(equal(received, data)).toBe(true);
    });

    it('ACCEPT_APP calls callback and rejects when it returns false', async () => {
      const { initiatorLink, responderLink } = await setupLinkedPairWired();
      responderLink.setResourceStrategy(ACCEPT_APP);

      let callbackCalled = false;
      responderLink.setResourceCallback((adv) => {
        callbackCalled = true;
        expect(adv.dataSize).toBeGreaterThan(0);
        expect(adv.link).toBe(responderLink);
        return false; // reject
      });

      const sendPromise = initiatorLink.sendResource(randomBytes(100), { timeoutMs: 2000 });
      await expect(sendPromise).rejects.toThrow(/reject/i);
      expect(callbackCalled).toBe(true);
    });

    it('ACCEPT_APP accepts when callback returns true', async () => {
      const { initiatorLink, responderLink } = await setupLinkedPairWired();
      responderLink.setResourceStrategy(ACCEPT_APP);
      responderLink.setResourceCallback((adv) => adv.dataSize <= 1000);

      const data = randomBytes(500);
      const receivePromise = new Promise((resolve) => {
        responderLink.on('resource_complete', (d) => resolve(d));
      });
      const bytes = await initiatorLink.sendResource(data, { timeoutMs: 5000 });
      expect(bytes).toBe(500);
      const received = await receivePromise;
      expect(equal(received, data)).toBe(true);
    });
  });

  describe('RequestReceipt', () => {
    it('request() returns a Promise with .receipt accessor', async () => {
      const { initiatorLink, responderLink } = await setupLinkedPairWired();
      responderLink.registerRequestHandler('/test', async (data) => fromUtf8('pong'));

      const promise = initiatorLink.request('/test', fromUtf8('ping'));
      expect(promise.receipt).toBeInstanceOf(RequestReceipt);
      expect(promise.receipt.getStatus()).toBe(REQUEST_SENT);
      await promise; // let it complete
    });

    it('await resolves to response data (backward compat)', async () => {
      const { initiatorLink, responderLink } = await setupLinkedPairWired();
      responderLink.registerRequestHandler('/echo', async (data) => data);

      const response = await initiatorLink.request('/echo', fromUtf8('hello'));
      expect(equal(response, fromUtf8('hello'))).toBe(true);
    });

    it('receipt reaches READY status after response', async () => {
      const { initiatorLink, responderLink } = await setupLinkedPairWired();
      responderLink.registerRequestHandler('/echo', async (data) => data);

      const promise = initiatorLink.request('/echo', fromUtf8('data'));
      const receipt = promise.receipt;

      await promise; // wait for response

      expect(receipt.getStatus()).toBe(REQUEST_READY);
      expect(receipt.getResponse()).not.toBeNull();
      expect(equal(receipt.getResponse(), fromUtf8('data'))).toBe(true);
    });

    it('fires onResponse callback when response arrives', async () => {
      const { initiatorLink, responderLink } = await setupLinkedPairWired();
      responderLink.registerRequestHandler('/test', async () => fromUtf8('ok'));

      let callbackReceipt = null;
      const promise = initiatorLink.request('/test', null, {
        onResponse: (r) => { callbackReceipt = r; },
      });
      const receipt = promise.receipt;

      await promise;

      expect(callbackReceipt).toBe(receipt);
      expect(callbackReceipt.getStatus()).toBe(REQUEST_READY);
    });

    it('times out and resolves to null with FAILED status', async () => {
      const { initiatorLink } = await setupLinkedPairWired();

      let failedReceipt = null;
      const promise = initiatorLink.request('/missing', null, {
        timeout: 200,
        onFailed: (r) => { failedReceipt = r; },
      });
      const receipt = promise.receipt;

      const result = await promise;
      expect(result).toBeNull();
      expect(receipt.getStatus()).toBe(REQUEST_FAILED);
      expect(failedReceipt).toBe(receipt);
    });

    it('legacy numeric timeout argument still works', async () => {
      const { initiatorLink } = await setupLinkedPairWired();
      const response = await initiatorLink.request('/missing', null, 200);
      expect(response).toBeNull();
    });

    it('receipt is failed when link closes before response', async () => {
      const { initiatorLink, responderLink } = await setupLinkedPairWired();
      responderLink.registerRequestHandler('/slow', async () => {
        await new Promise(r => setTimeout(r, 60000));
        return fromUtf8('too late');
      });

      const promise = initiatorLink.request('/slow', null, {
        timeout: 5000,
        onFailed: () => {},
      });
      const receipt = promise.receipt;

      // Wait for the async send to complete
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));

      await initiatorLink.close();
      await new Promise(r => setImmediate(r));

      expect(receipt.getStatus()).toBe(REQUEST_FAILED);
    });
  });

  describe('watchdog STALE state machine', () => {
    it('transitions to STALE after silence exceeds staleTime', async () => {
      const { initiatorLink } = await setupLinkedPairWired();
      // Collapse thresholds so the test runs fast
      initiatorLink.keepalive = 0.1;   // 100ms
      initiatorLink.staleTime = 0.2;   // 200ms

      // Force the link to appear silent by rewinding lastInbound far into the past
      initiatorLink.lastInbound = Date.now() - 1000;

      let staleEmitted = false;
      initiatorLink.on('stale', () => { staleEmitted = true; });

      initiatorLink._watchdogCheck();
      expect(initiatorLink.status).toBe(0x03); // LINK_STALE
      expect(staleEmitted).toBe(true);
    });

    it('recovers from STALE when fresh inbound arrives', async () => {
      const { initiatorLink } = await setupLinkedPairWired();
      initiatorLink.keepalive = 0.1;
      initiatorLink.staleTime = 0.2;

      // Force into STALE
      initiatorLink.lastInbound = Date.now() - 1000;
      initiatorLink._watchdogCheck();
      expect(initiatorLink.status).toBe(0x03); // STALE

      // Simulate a packet arriving (resets lastInbound)
      initiatorLink.lastInbound = Date.now();
      initiatorLink._watchdogCheck();
      expect(initiatorLink.status).toBe(LINK_ACTIVE);
    });

    it('_teardown(TIMEOUT) moves link to CLOSED and emits closed', async () => {
      const { initiatorLink } = await setupLinkedPairWired();
      let reason = null;
      initiatorLink.on('closed', (r) => { reason = r; });
      // STALE_GRACE is hardcoded to 5s so we can't cheaply wait out the real
      // stale timeout. Verify the teardown path directly instead.
      initiatorLink._teardown(0x01 /* TIMEOUT */);
      expect(initiatorLink.status).toBe(LINK_CLOSED);
      expect(reason).not.toBeNull();
    });

    it('initiator sends keepalive after keepalive period', async () => {
      const { initiatorLink, initiatorTransport } = await setupLinkedPairWired();
      initiatorLink.keepalive = 0.1;
      initiatorLink.staleTime = 10; // avoid STALE

      // Force the initiator's keepalive threshold to fire
      initiatorLink.lastInbound = Date.now() - 500;
      initiatorLink._lastKeepalive = 0;

      // Capture the transmit to verify a keepalive packet was sent
      const sent = [];
      const origTransmit = initiatorTransport.transmit.bind(initiatorTransport);
      initiatorTransport.transmit = (pkt) => {
        sent.push(pkt);
        return origTransmit(pkt);
      };

      initiatorLink._watchdogCheck();

      const keepalives = sent.filter((p) => p.context === CONTEXT_KEEPALIVE);
      expect(keepalives.length).toBeGreaterThan(0);
    });

    it('_watchdogCheck is a no-op when link is closed', async () => {
      const { initiatorLink } = await setupLinkedPairWired();
      await initiatorLink.close();
      expect(initiatorLink.status).toBe(LINK_CLOSED);
      // Should return without throwing and not change state
      expect(() => initiatorLink._watchdogCheck()).not.toThrow();
      expect(initiatorLink.status).toBe(LINK_CLOSED);
    });
  });

  describe('sendWithProof', () => {
    it('rejects on timeout when no proof arrives', async () => {
      const { initiatorLink } = await setupLinkedPair();
      // Use a standalone initiator (responder won't echo proofs for arbitrary packets)
      await expect(
        initiatorLink.sendWithProof(fromUtf8('hello'), 200)
      ).rejects.toThrow(/timeout/i);
    });

    it('rejects when link is not active', async () => {
      const { initiatorLink } = await setupLinkedPair();
      await initiatorLink.close();
      await expect(
        initiatorLink.sendWithProof(fromUtf8('hello'), 1000)
      ).rejects.toThrow(/not active/i);
    });

    it('pending proofs are rejected on link teardown', async () => {
      const { initiatorLink } = await setupLinkedPair();
      const p = initiatorLink.sendWithProof(fromUtf8('hello'), 60_000);
      // Close the link mid-flight
      await new Promise(r => setImmediate(r));
      await initiatorLink.close();
      await expect(p).rejects.toThrow(/closed/i);
    });
  });

  describe('_handlePacketProof error paths', () => {
    it('ignores short proof packets', async () => {
      const { initiatorLink } = await setupLinkedPair();
      const shortPkt = { data: new Uint8Array(10), context: CONTEXT_NONE };
      // Should not throw or crash
      expect(() => initiatorLink._handlePacketProof(shortPkt)).not.toThrow();
    });

    it('ignores proof for unknown packet hash', async () => {
      const { initiatorLink } = await setupLinkedPair();
      const pkt = { data: randomBytes(96), context: CONTEXT_NONE };
      expect(() => initiatorLink._handlePacketProof(pkt)).not.toThrow();
    });

    it('rejects pending proof on invalid signature', async () => {
      const { initiatorLink } = await setupLinkedPair();
      const hashHex = toHex(randomBytes(32));
      let rejected = null;
      initiatorLink._pendingProofs.set(hashHex, {
        resolve: () => {},
        reject: (err) => { rejected = err; },
      });

      // Build a proof packet with the matching packet hash but a random signature
      const packetHash = new Uint8Array(Buffer.from(hashHex, 'hex'));
      const fakeSig = randomBytes(64);
      const pkt = {
        data: new Uint8Array([...packetHash, ...fakeSig]),
        context: CONTEXT_NONE,
      };
      initiatorLink._handlePacketProof(pkt);
      expect(rejected).not.toBeNull();
      expect(rejected.message).toMatch(/signature/i);
    });
  });

  describe('close()', () => {
    it('sets status to CLOSED and emits the event', async () => {
      const { initiatorLink } = await setupLinkedPair();
      let reason = null;
      initiatorLink.on('closed', (r) => { reason = r; });
      await initiatorLink.close();
      expect(initiatorLink.status).toBe(LINK_CLOSED);
      expect(reason).not.toBeNull();
    });

    it('is idempotent', async () => {
      const { initiatorLink } = await setupLinkedPair();
      await initiatorLink.close();
      expect(initiatorLink.status).toBe(LINK_CLOSED);
      // A second close should not throw
      await expect(initiatorLink.close()).resolves.not.toThrow();
    });

    it('zeroes session keys', async () => {
      const { initiatorLink } = await setupLinkedPair();
      expect(initiatorLink._encryptionKey).not.toBeNull();
      await initiatorLink.close();
      expect(initiatorLink._encryptionKey).toBeNull();
      expect(initiatorLink._signingKey).toBeNull();
      expect(initiatorLink._derivedKey).toBeNull();
    });
  });

  describe('_handleLinkIdentify validation', () => {
    it('rejects wrong-size plaintext silently', async () => {
      const { responderLink } = await setupLinkedPair();
      // Too short
      expect(() => responderLink._handleLinkIdentify(new Uint8Array(50))).not.toThrow();
      expect(responderLink._remoteIdentity).toBeNull();
      // Too long
      expect(() => responderLink._handleLinkIdentify(new Uint8Array(200))).not.toThrow();
      expect(responderLink._remoteIdentity).toBeNull();
    });

    it('rejects invalid signature', async () => {
      const { responderLink } = await setupLinkedPair();
      // Build a plaintext with a valid-looking public key but a random signature
      const id = Identity.generate();
      const fakeProof = new Uint8Array([...id.publicKey, ...randomBytes(64)]);
      responderLink._handleLinkIdentify(fakeProof);
      expect(responderLink._remoteIdentity).toBeNull();
    });

    it('initiator side silently ignores LINKIDENTIFY', async () => {
      const { initiatorLink } = await setupLinkedPair();
      const id = Identity.generate();
      const signedData = new Uint8Array([...initiatorLink.linkId, ...id.publicKey]);
      const signature = id.sign(signedData);
      const proof = new Uint8Array([...id.publicKey, ...signature]);
      initiatorLink._handleLinkIdentify(proof);
      expect(initiatorLink._remoteIdentity).toBeNull(); // never sets on initiator
    });
  });

  describe('setResourceStrategy validation', () => {
    it('accepts ACCEPT_NONE / ACCEPT_APP / ACCEPT_ALL', async () => {
      const { initiatorLink } = await setupLinkedPair();
      expect(() => initiatorLink.setResourceStrategy(ACCEPT_NONE)).not.toThrow();
      expect(() => initiatorLink.setResourceStrategy(ACCEPT_APP)).not.toThrow();
      expect(() => initiatorLink.setResourceStrategy(ACCEPT_ALL)).not.toThrow();
    });

    it('throws on invalid strategy', async () => {
      const { initiatorLink } = await setupLinkedPair();
      expect(() => initiatorLink.setResourceStrategy(0xFF)).toThrow(/unsupported/i);
    });
  });
});
