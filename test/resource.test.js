import { describe, it, expect } from 'vitest';
import {
  ResourceSender, ResourceReceiver,
  RESOURCE_NONE, RESOURCE_ADVERTISED, RESOURCE_TRANSFERRING,
  RESOURCE_AWAITING_PROOF, RESOURCE_COMPLETE, RESOURCE_FAILED, RESOURCE_REJECTED,
} from '../src/Resource.js';
import { Link, LINK_ACTIVE } from '../src/Link.js';
import { Transport } from '../src/Transport.js';
import { Identity } from '../src/Identity.js';
import { Destination } from '../src/Destination.js';
import { EventEmitter } from '../src/utils/events.js';
import { toHex, fromUtf8, equal, randomBytes } from '../src/utils/bytes.js';
import { sha256Hash } from '../src/utils/crypto.js';
import { DEST_SINGLE, DEST_IN } from '../src/constants.js';

class MockInterface extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.online = true;
    this.sent = [];
  }
  send(data) { this.sent.push(new Uint8Array(data)); }
}

async function setupLinkedPair() {
  const responderIdentity = Identity.generate();
  const responderDest = new Destination(responderIdentity, DEST_IN, DEST_SINGLE, 'test', 'res');

  const responderIface = new MockInterface('responder');
  const responderTransport = new Transport();
  responderTransport.registerInterface(responderIface);
  responderTransport.registerDestination(responderDest);
  responderDest.setLinkCallback(() => true);

  const initiatorIface = new MockInterface('initiator');
  const initiatorTransport = new Transport();
  initiatorTransport.registerInterface(initiatorIface);

  initiatorTransport.announceTable.set(toHex(responderDest.hash), {
    identity: Identity.fromPublicKey(responderIdentity.publicKey),
    appData: null, hops: 1, timestamp: Date.now() / 1000,
  });

  const initiatorLink = Link.init(responderDest, initiatorTransport);
  initiatorTransport.registerPendingLink(initiatorLink);

  responderIface.emit('packet', initiatorIface.sent[0]);
  const established = new Promise(resolve => initiatorLink.on('established', resolve));
  initiatorIface.emit('packet', responderIface.sent[0]);
  await established;
  responderIface.emit('packet', initiatorIface.sent[1]);

  let responderLink = null;
  for (const [, link] of responderTransport.linkTable) {
    if (link !== initiatorLink) { responderLink = link; break; }
  }

  return { initiatorLink, responderLink };
}

describe('Resource', () => {
  describe('ResourceSender', () => {
    it('segments data correctly', async () => {
      const { initiatorLink } = await setupLinkedPair();
      const data = randomBytes(1000);
      const sender = new ResourceSender(initiatorLink, data);
      await sender._prepareParts();

      // Stream is encrypted (4-byte prefix + 1000 bytes data, then AES-CBC
      // padded to 16-byte block + 16-byte IV + 32-byte HMAC + 32-byte ephemeral
      // pub) → ~1100 bytes on the wire, split into 431-byte SDUs.
      expect(sender.parts.length).toBe(sender.totalParts);
      expect(sender.mapHashes.length).toBe(sender.totalParts);
      expect(sender.hash).toHaveLength(32);
      expect(sender.randomHash).toHaveLength(4);
      expect(sender.streamData.length).toBeGreaterThan(data.length);
    });

    it('handles small data (single part)', async () => {
      const { initiatorLink } = await setupLinkedPair();
      const data = fromUtf8('small');
      const sender = new ResourceSender(initiatorLink, data);
      await sender._prepareParts();

      expect(sender.totalParts).toBe(1);
    });
  });

  describe('ResourceReceiver', () => {
    it('can be created from a sender advertisement', async () => {
      const { initiatorLink, responderLink } = await setupLinkedPair();
      const data = randomBytes(500);
      const sender = new ResourceSender(initiatorLink, data);

      // Manually serialize the advertisement
      const { encode: msgpackEncode } = await import('@msgpack/msgpack');
      const hashmap = new Uint8Array(sender.mapHashes.length * 4);
      for (let i = 0; i < sender.mapHashes.length; i++) {
        hashmap.set(sender.mapHashes[i], i * 4);
      }
      const adv = msgpackEncode({
        t: sender.transferData.length,
        d: sender.originalData.length,
        n: sender.totalParts,
        h: sender.hash,
        r: sender.randomHash,
        o: sender.hash,
        i: 1, l: 1,
        q: null,
        f: 0x01,
        m: hashmap,
      });

      const receiver = new ResourceReceiver(responderLink, new Uint8Array(adv));
      expect(receiver.totalParts).toBe(sender.totalParts);
      expect(receiver.dataSize).toBe(500);
      expect(equal(receiver.hash, sender.hash)).toBe(true);
    });
  });

  describe('end-to-end transfer', () => {
    it('transfers data and verifies with proof', async () => {
      const { initiatorLink, responderLink } = await setupLinkedPair();
      const data = randomBytes(1500); // multiple parts
      const sender = new ResourceSender(initiatorLink, data, { encrypted: false });
      await sender._prepareParts();

      // Simulate: sender creates advertisement, receiver parses it
      const { encode: msgpackEncode } = await import('@msgpack/msgpack');
      const hashmap = new Uint8Array(sender.mapHashes.length * 4);
      for (let i = 0; i < sender.mapHashes.length; i++) {
        hashmap.set(sender.mapHashes[i], i * 4);
      }
      const adv = msgpackEncode({
        t: sender.streamData.length,
        d: sender.originalData.length,
        n: sender.totalParts,
        h: sender.hash,
        r: sender.randomHash,
        o: sender.hash,
        i: 1, l: 1, q: null, f: 0x00,
        m: hashmap,
      });

      const receiver = new ResourceReceiver(responderLink, new Uint8Array(adv));

      // Deliver parts
      for (const part of sender.parts) {
        receiver.receivePart(part);
      }

      expect(receiver.status).toBe(RESOURCE_COMPLETE);
      expect(receiver.data).not.toBeNull();
      expect(equal(receiver.data, data)).toBe(true);

      // Verify proof
      const proof = receiver.generateProof();
      expect(sender.handleProof(proof)).toBe(true);
      expect(sender.status).toBe(RESOURCE_COMPLETE);
    });

    it('transfers small data (single part)', async () => {
      const { initiatorLink, responderLink } = await setupLinkedPair();
      const data = fromUtf8('Hello from Node.js RNS!');
      const sender = new ResourceSender(initiatorLink, data, { encrypted: false });
      await sender._prepareParts();

      const { encode: msgpackEncode } = await import('@msgpack/msgpack');
      const hashmap = new Uint8Array(sender.mapHashes.length * 4);
      for (let i = 0; i < sender.mapHashes.length; i++) {
        hashmap.set(sender.mapHashes[i], i * 4);
      }
      const adv = msgpackEncode({
        t: sender.streamData.length, d: data.length,
        n: sender.totalParts, h: sender.hash, r: sender.randomHash,
        o: sender.hash, i: 1, l: 1, q: null, f: 0x00,
        m: hashmap,
      });

      const receiver = new ResourceReceiver(responderLink, new Uint8Array(adv));

      for (const part of sender.parts) {
        receiver.receivePart(part);
      }

      expect(receiver.status).toBe(RESOURCE_COMPLETE);
      const text = new TextDecoder().decode(receiver.data);
      expect(text).toBe('Hello from Node.js RNS!');
    });

    it('handles out-of-order part delivery', async () => {
      const { initiatorLink, responderLink } = await setupLinkedPair();
      const data = randomBytes(2000); // ~5 parts
      const sender = new ResourceSender(initiatorLink, data, { encrypted: false });
      await sender._prepareParts();

      const { encode: msgpackEncode } = await import('@msgpack/msgpack');
      const hashmap = new Uint8Array(sender.mapHashes.length * 4);
      for (let i = 0; i < sender.mapHashes.length; i++) {
        hashmap.set(sender.mapHashes[i], i * 4);
      }
      const adv = msgpackEncode({
        t: sender.streamData.length, d: data.length,
        n: sender.totalParts, h: sender.hash, r: sender.randomHash,
        o: sender.hash, i: 1, l: 1, q: null, f: 0x00,
        m: hashmap,
      });

      const receiver = new ResourceReceiver(responderLink, new Uint8Array(adv));

      // Deliver parts in reverse order
      const reversed = [...sender.parts].reverse();
      for (const part of reversed) {
        receiver.receivePart(part);
      }

      expect(receiver.status).toBe(RESOURCE_COMPLETE);
      expect(equal(receiver.data, data)).toBe(true);
    });

    it('rejects tampered data', async () => {
      const { initiatorLink, responderLink } = await setupLinkedPair();
      const data = randomBytes(500);
      const sender = new ResourceSender(initiatorLink, data, { encrypted: false });
      await sender._prepareParts();

      const { encode: msgpackEncode } = await import('@msgpack/msgpack');
      const hashmap = new Uint8Array(sender.mapHashes.length * 4);
      for (let i = 0; i < sender.mapHashes.length; i++) {
        hashmap.set(sender.mapHashes[i], i * 4);
      }
      const adv = msgpackEncode({
        t: sender.streamData.length, d: data.length,
        n: sender.totalParts, h: sender.hash, r: sender.randomHash,
        o: sender.hash, i: 1, l: 1, q: null, f: 0x00,
        m: hashmap,
      });

      const receiver = new ResourceReceiver(responderLink, new Uint8Array(adv));

      // Deliver parts but tamper with the last one
      for (let i = 0; i < sender.parts.length; i++) {
        const part = new Uint8Array(sender.parts[i]);
        if (i === sender.parts.length - 1) {
          part[0] ^= 0xFF; // tamper
        }
        receiver.receivePart(part);
      }

      // Tampered part won't match any map hash, so it won't be placed
      // The resource won't complete
      expect(receiver.receivedParts).toBeLessThan(receiver.totalParts);
    });

    it('tracks progress', async () => {
      const { initiatorLink, responderLink } = await setupLinkedPair();
      const data = randomBytes(2000);
      const sender = new ResourceSender(initiatorLink, data, { encrypted: false });
      await sender._prepareParts();

      const { encode: msgpackEncode } = await import('@msgpack/msgpack');
      const hashmap = new Uint8Array(sender.mapHashes.length * 4);
      for (let i = 0; i < sender.mapHashes.length; i++) {
        hashmap.set(sender.mapHashes[i], i * 4);
      }
      const adv = msgpackEncode({
        t: sender.streamData.length, d: data.length,
        n: sender.totalParts, h: sender.hash, r: sender.randomHash,
        o: sender.hash, i: 1, l: 1, q: null, f: 0x00,
        m: hashmap,
      });

      const receiver = new ResourceReceiver(responderLink, new Uint8Array(adv));
      const progressValues = [];
      receiver.onProgress((p) => progressValues.push(p));

      for (const part of sender.parts) {
        receiver.receivePart(part);
      }

      expect(progressValues.length).toBe(sender.totalParts);
      expect(progressValues[progressValues.length - 1]).toBe(1);
      // Progress should be monotonically increasing
      for (let i = 1; i < progressValues.length; i++) {
        expect(progressValues[i]).toBeGreaterThan(progressValues[i - 1]);
      }
    });
  });

  describe('ResourceSender state transitions', () => {
    it('transitions ADVERTISED → TRANSFERRING → AWAITING_PROOF → COMPLETE', async () => {
      const { initiatorLink, responderLink } = await setupLinkedPair();
      const data = randomBytes(1500);
      const sender = new ResourceSender(initiatorLink, data, { encrypted: false });
      await sender._prepareParts();

      expect(sender.status).toBe(RESOURCE_NONE);

      // Advertise
      await sender.advertise();
      expect(sender.status).toBe(RESOURCE_ADVERTISED);
      expect(sender.retriesLeft).toBeGreaterThan(0);
      expect(sender.advSent).toBeGreaterThan(0);

      // Build receiver from adv
      const { encode: msgpackEncode } = await import('@msgpack/msgpack');
      const hashmap = new Uint8Array(sender.mapHashes.length * 4);
      for (let i = 0; i < sender.mapHashes.length; i++) {
        hashmap.set(sender.mapHashes[i], i * 4);
      }
      const adv = msgpackEncode({
        t: sender.streamData.length, d: sender.originalData.length,
        n: sender.totalParts, h: sender.hash, r: sender.randomHash,
        o: sender.hash, i: 1, l: 1, q: null, f: 0x00,
        m: hashmap,
      });
      const receiver = new ResourceReceiver(responderLink, new Uint8Array(adv));

      // Build a request for the first window of parts (simulate receiver accept)
      const reqHashes = [];
      const windowSize = Math.min(4, sender.totalParts);
      for (let i = 0; i < windowSize; i++) {
        reqHashes.push(sender.mapHashes[i]);
      }
      const hashBytes = new Uint8Array(reqHashes.length * 4);
      for (let i = 0; i < reqHashes.length; i++) hashBytes.set(reqHashes[i], i * 4);
      const reqData = new Uint8Array(1 + 32 + hashBytes.length);
      reqData[0] = 0x00; // HASHMAP_IS_NOT_EXHAUSTED
      reqData.set(sender.hash, 1);
      reqData.set(hashBytes, 33);

      // Handle first request → should transition to TRANSFERRING
      await sender.handleRequest(reqData);
      expect(sender.status).toBe(sender.sentParts >= sender.totalParts
        ? RESOURCE_AWAITING_PROOF : RESOURCE_TRANSFERRING);

      // Keep requesting until all parts sent
      while (sender.sentParts < sender.totalParts) {
        const remaining = [];
        for (let i = 0; i < sender.totalParts; i++) {
          if (sender.sentParts <= i) remaining.push(sender.mapHashes[i]);
        }
        const batch = remaining.slice(0, 4);
        const batchBytes = new Uint8Array(batch.length * 4);
        for (let j = 0; j < batch.length; j++) batchBytes.set(batch[j], j * 4);
        const req = new Uint8Array(1 + 32 + batchBytes.length);
        req[0] = 0x00;
        req.set(sender.hash, 1);
        req.set(batchBytes, 33);
        await sender.handleRequest(req);
      }

      expect(sender.status).toBe(RESOURCE_AWAITING_PROOF);

      // Deliver proof
      for (const part of sender.parts) receiver.receivePart(part);
      const proof = receiver.generateProof();
      sender.handleProof(proof);
      expect(sender.status).toBe(RESOURCE_COMPLETE);
      sender._stopWatchdog(); // cleanup
    });
  });

  describe('ResourceSender._rejected', () => {
    it('sets status REJECTED and fires onFailed', async () => {
      const { initiatorLink } = await setupLinkedPair();
      const sender = new ResourceSender(initiatorLink, randomBytes(100));

      let failedWith = null;
      sender.onFailed((err) => { failedWith = err; });

      sender._rejected('test rejection');
      expect(sender.status).toBe(RESOURCE_REJECTED);
      expect(failedWith).toBeInstanceOf(Error);
      expect(failedWith.message).toMatch(/test rejection/);
    });

    it('is a no-op after COMPLETE', async () => {
      const { initiatorLink, responderLink } = await setupLinkedPair();
      const sender = new ResourceSender(initiatorLink, randomBytes(100), { encrypted: false });
      await sender._prepareParts();

      const { encode: msgpackEncode } = await import('@msgpack/msgpack');
      const hashmap = new Uint8Array(sender.mapHashes.length * 4);
      for (let i = 0; i < sender.mapHashes.length; i++) hashmap.set(sender.mapHashes[i], i * 4);
      const adv = msgpackEncode({
        t: sender.streamData.length, d: 100,
        n: sender.totalParts, h: sender.hash, r: sender.randomHash,
        o: sender.hash, i: 1, l: 1, q: null, f: 0x00, m: hashmap,
      });
      const receiver = new ResourceReceiver(responderLink, new Uint8Array(adv));
      for (const part of sender.parts) receiver.receivePart(part);
      sender.handleProof(receiver.generateProof());
      expect(sender.status).toBe(RESOURCE_COMPLETE);

      let failedCalled = false;
      sender.onFailed(() => { failedCalled = true; });
      sender._rejected('should be ignored');
      expect(sender.status).toBe(RESOURCE_COMPLETE);
      expect(failedCalled).toBe(false);
    });
  });

  describe('ResourceSender.cancel', () => {
    it('sets status FAILED and fires onFailed', async () => {
      const { initiatorLink } = await setupLinkedPair();
      const sender = new ResourceSender(initiatorLink, randomBytes(100));
      let failedWith = null;
      sender.onFailed((err) => { failedWith = err; });
      await sender.cancel('cancel test');
      expect(sender.status).toBe(RESOURCE_FAILED);
      expect(failedWith).toBeInstanceOf(Error);
      expect(failedWith.message).toMatch(/cancel test/);
    });
  });

  describe('ResourceReceiver.cancel', () => {
    it('sets status FAILED and fires onFailed', async () => {
      const { initiatorLink, responderLink } = await setupLinkedPair();
      const sender = new ResourceSender(initiatorLink, randomBytes(500), { encrypted: false });
      await sender._prepareParts();

      const { encode: msgpackEncode } = await import('@msgpack/msgpack');
      const hashmap = new Uint8Array(sender.mapHashes.length * 4);
      for (let i = 0; i < sender.mapHashes.length; i++) hashmap.set(sender.mapHashes[i], i * 4);
      const adv = msgpackEncode({
        t: sender.streamData.length, d: 500,
        n: sender.totalParts, h: sender.hash, r: sender.randomHash,
        o: sender.hash, i: 1, l: 1, q: null, f: 0x00, m: hashmap,
      });
      const receiver = new ResourceReceiver(responderLink, new Uint8Array(adv));
      let failedWith = null;
      receiver.onFailed((err) => { failedWith = err; });

      receiver.cancel('rx cancel test');
      expect(receiver.status).toBe(RESOURCE_FAILED);
      expect(failedWith).toBeInstanceOf(Error);
      expect(failedWith.message).toMatch(/rx cancel test/);
    });
  });

  describe('sender watchdog', () => {
    it('ADVERTISED: retries advertisement and eventually rejects on exhaustion', async () => {
      const { initiatorLink } = await setupLinkedPair();
      const sender = new ResourceSender(initiatorLink, randomBytes(100));
      await sender.advertise();
      expect(sender.status).toBe(RESOURCE_ADVERTISED);

      // Fast-forward: set advSent far in the past so each watchdog tick fires
      sender.timeout = 0;
      sender.retriesLeft = 2;

      // Tick → should retry (not reject, still has retries)
      sender.advSent = (Date.now() / 1000) - 100;
      sender.lastActivity = sender.advSent;
      sender._watchdogTick();
      expect(sender.retriesLeft).toBe(1);
      expect(sender.status).toBe(RESOURCE_ADVERTISED);

      // Tick again → last retry
      sender.advSent = (Date.now() / 1000) - 100;
      sender.lastActivity = sender.advSent;
      sender._watchdogTick();
      expect(sender.retriesLeft).toBe(0);

      // Tick when no retries left → should reject
      sender.advSent = (Date.now() / 1000) - 100;
      sender._watchdogTick();
      expect(sender.status).toBe(RESOURCE_REJECTED);

      sender._stopWatchdog();
    });

    it('TRANSFERRING: rejects after max_wait exceeded', async () => {
      const { initiatorLink } = await setupLinkedPair();
      const sender = new ResourceSender(initiatorLink, randomBytes(100));
      sender.status = RESOURCE_TRANSFERRING;
      sender.rtt = 0.01;
      sender.lastActivity = (Date.now() / 1000) - 9999; // way in the past

      let failedWith = null;
      sender.onFailed((err) => { failedWith = err; });

      sender._watchdogTick();
      expect(sender.status).toBe(RESOURCE_REJECTED);
      expect(failedWith).not.toBeNull();
      expect(failedWith.message).toMatch(/stopped requesting/);
    });

    it('AWAITING_PROOF: extends wait on first timeout, rejects after exhaustion', async () => {
      const { initiatorLink } = await setupLinkedPair();
      const sender = new ResourceSender(initiatorLink, randomBytes(100));
      sender.status = RESOURCE_AWAITING_PROOF;
      sender.rtt = 0.01;
      sender.retriesLeft = 1;
      sender.lastPartSent = (Date.now() / 1000) - 9999;

      // First tick → retry extends
      sender._watchdogTick();
      expect(sender.status).toBe(RESOURCE_AWAITING_PROOF);
      expect(sender.retriesLeft).toBe(0);

      // Second tick → no retries left → rejects
      sender.lastPartSent = (Date.now() / 1000) - 9999;
      sender._watchdogTick();
      expect(sender.status).toBe(RESOURCE_REJECTED);
    });
  });

  describe('receiver watchdog', () => {
    async function makeReceiver() {
      const { initiatorLink, responderLink } = await setupLinkedPair();
      const data = randomBytes(2000);
      const sender = new ResourceSender(initiatorLink, data, { encrypted: false });
      await sender._prepareParts();

      const { encode: msgpackEncode } = await import('@msgpack/msgpack');
      const hashmap = new Uint8Array(sender.mapHashes.length * 4);
      for (let i = 0; i < sender.mapHashes.length; i++) hashmap.set(sender.mapHashes[i], i * 4);
      const adv = msgpackEncode({
        t: sender.streamData.length, d: data.length,
        n: sender.totalParts, h: sender.hash, r: sender.randomHash,
        o: sender.hash, i: 1, l: 1, q: null, f: 0x00, m: hashmap,
      });
      const receiver = new ResourceReceiver(responderLink, new Uint8Array(adv));
      return { sender, receiver };
    }

    it('shrinks window and retries on part timeout', async () => {
      const { receiver } = await makeReceiver();
      await receiver.accept();
      const initialWindow = receiver.window;

      // Simulate: parts were requested but never arrived. Fast-forward time.
      receiver.outstandingParts = 3;
      receiver.lastActivity = (Date.now() / 1000) - 9999;
      receiver.retriesLeft = 5;
      const initialRetries = receiver.retriesLeft;

      receiver._watchdogTick();
      expect(receiver.retriesLeft).toBe(initialRetries - 1);
      // Window should have shrunk
      expect(receiver.window).toBeLessThanOrEqual(initialWindow);
      // Should still be transferring (retries remain)
      expect(receiver.status).toBe(RESOURCE_TRANSFERRING);

      receiver._stopWatchdog();
    });

    it('cancels after exhausting retries', async () => {
      const { receiver } = await makeReceiver();
      await receiver.accept();

      receiver.outstandingParts = 3;
      receiver.lastActivity = (Date.now() / 1000) - 9999;
      receiver.retriesLeft = 0;

      let failedWith = null;
      receiver.onFailed((err) => { failedWith = err; });

      receiver._watchdogTick();
      expect(receiver.status).toBe(RESOURCE_FAILED);
      expect(failedWith).not.toBeNull();
      expect(failedWith.message).toMatch(/Timeout/);

      receiver._stopWatchdog();
    });
  });
});
