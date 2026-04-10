import { describe, it, expect } from 'vitest';
import { ResourceSender, ResourceReceiver, RESOURCE_COMPLETE } from '../src/Resource.js';
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
});
