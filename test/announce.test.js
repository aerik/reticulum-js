import { describe, it, expect } from 'vitest';
import { createAnnounce, validateAnnounce, makeRandomBlob, extractTimestamp } from '../src/Announce.js';
import { Transport } from '../src/Transport.js';
import { EventEmitter } from '../src/utils/events.js';
import { Identity } from '../src/Identity.js';
import { Destination } from '../src/Destination.js';
import { Packet } from '../src/Packet.js';
import { fromUtf8, equal, toHex, randomBytes } from '../src/utils/bytes.js';
import {
  DEST_SINGLE, DEST_PLAIN, DEST_IN, DEST_OUT,
  PACKET_ANNOUNCE, FLAG_UNSET,
  IDENTITY_KEYSIZE, IDENTITY_NAME_HASH_LENGTH, IDENTITY_SIGLENGTH,
} from '../src/constants.js';

describe('Announce', () => {
  describe('makeRandomBlob', () => {
    it('returns 10 bytes', () => {
      expect(makeRandomBlob()).toHaveLength(10);
    });

    it('embeds a timestamp close to now', () => {
      const blob = makeRandomBlob();
      const ts = extractTimestamp(blob);
      const now = Math.floor(Date.now() / 1000);
      expect(Math.abs(ts - now)).toBeLessThan(5);
    });

    it('produces unique blobs', () => {
      const a = makeRandomBlob();
      const b = makeRandomBlob();
      expect(equal(a, b)).toBe(false);
    });
  });

  describe('createAnnounce', () => {
    it('creates a valid announce packet', () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'test_app', 'service');
      const pkt = createAnnounce(dest);

      expect(pkt.packetType).toBe(PACKET_ANNOUNCE);
      expect(pkt.destType).toBe(DEST_SINGLE);
      expect(pkt.contextFlag).toBe(FLAG_UNSET);
      expect(equal(pkt.destinationHash, dest.hash)).toBe(true);
      expect(pkt.hops).toBe(0);

      // Data should be at least 148 bytes (64 key + 10 name + 10 random + 64 sig)
      expect(pkt.data.length).toBeGreaterThanOrEqual(148);
    });

    it('includes app data when provided', () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'myapp');
      const appData = fromUtf8('Hello Reticulum');
      const pkt = createAnnounce(dest, appData);

      expect(pkt.data.length).toBe(148 + appData.length);
    });

    it('throws for non-SINGLE destinations', () => {
      const dest = new Destination(null, DEST_IN, DEST_PLAIN, 'broadcast');
      expect(() => createAnnounce(dest)).toThrow();
    });

    it('throws for public-only identity', () => {
      const full = Identity.generate();
      const pubOnly = Identity.fromPublicKey(full.publicKey);
      // Can't create a Destination with public-only identity that matches
      // But we can test the guard in createAnnounce
      const dest = new Destination(pubOnly, DEST_IN, DEST_SINGLE, 'app');
      expect(() => createAnnounce(dest)).toThrow();
    });
  });

  describe('validateAnnounce', () => {
    it('validates a self-created announce', () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'test_app', 'endpoint');
      const pkt = createAnnounce(dest);

      // Pack and re-parse to simulate network transmission
      const raw = pkt.pack();
      const parsed = Packet.parse(raw);

      const result = validateAnnounce(parsed);
      expect(result).not.toBeNull();
      expect(equal(result.identity.publicKey, id.publicKey)).toBe(true);
      expect(equal(result.destinationHash, dest.hash)).toBe(true);
      expect(equal(result.nameHash, dest.nameHash)).toBe(true);
      expect(result.ratchet).toBeNull();
      expect(result.appData).toBeNull();
    });

    it('validates announce with app data', () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'app', 'svc');
      const appData = fromUtf8('node-js-rns');
      const pkt = createAnnounce(dest, appData);

      const parsed = Packet.parse(pkt.pack());
      const result = validateAnnounce(parsed);

      expect(result).not.toBeNull();
      expect(result.appData).not.toBeNull();
      expect(equal(result.appData, appData)).toBe(true);
    });

    it('round-trips a ratcheted announce and remembers the ratchet', async () => {
      // Simulates: destination with rotated ratchet → announce out → peer
      // validates → Transport-style rememberRatchet → getRatchet recalls.
      Identity._resetKnownRatchets();
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'app', 'svc');

      // Generate a ratchet keypair manually (like Destination.rotateRatchets
      // would, but inline so the test doesn't need a Storage setup)
      const ratchetPriv = Identity.generateRatchet();
      const ratchetPub = Identity.ratchetPublicBytes(ratchetPriv);

      const pkt = createAnnounce(dest, null, { ratchet: ratchetPub });
      const parsed = Packet.parse(pkt.pack());
      const result = validateAnnounce(parsed);

      expect(result).not.toBeNull();
      expect(result.ratchet).not.toBeNull();
      expect(equal(result.ratchet, ratchetPub)).toBe(true);

      // Transport-equivalent remember step
      await Identity.rememberRatchet(result.destinationHash, result.ratchet);

      // Later, when we want to encrypt *to* that destination, we look up
      // the remembered ratchet and pass it to `identity.encrypt`.
      const recalled = await Identity.getRatchet(dest.hash);
      expect(recalled).not.toBeNull();
      expect(equal(recalled, ratchetPub)).toBe(true);

      // Full E2E: encrypt with recalled ratchet, decrypt with the private ratchet
      const ct = await id.encrypt(fromUtf8('hi'), recalled);
      const pt = await id.decrypt(ct, { ratchets: [ratchetPriv] });
      expect(equal(pt, fromUtf8('hi'))).toBe(true);
    });

    it('timestamp is close to creation time', () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'app');
      const before = Math.floor(Date.now() / 1000);
      const pkt = createAnnounce(dest);
      const after = Math.floor(Date.now() / 1000);

      const result = validateAnnounce(Packet.parse(pkt.pack()));
      expect(result.timestamp).toBeGreaterThanOrEqual(before);
      expect(result.timestamp).toBeLessThanOrEqual(after + 1);
    });

    it('rejects tampered destination hash', () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'app');
      const pkt = createAnnounce(dest);
      const raw = pkt.pack();

      // Tamper with destination hash (bytes 2-17)
      raw[3] ^= 0xFF;

      const parsed = Packet.parse(raw);
      expect(validateAnnounce(parsed)).toBeNull();
    });

    it('rejects tampered signature', () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'app');
      const pkt = createAnnounce(dest);
      const raw = pkt.pack();

      // Tamper with signature (near the end of data)
      raw[raw.length - 10] ^= 0xFF;

      const parsed = Packet.parse(raw);
      expect(validateAnnounce(parsed)).toBeNull();
    });

    it('rejects data that is too short', () => {
      const pkt = new Packet();
      pkt.packetType = PACKET_ANNOUNCE;
      pkt.destType = DEST_SINGLE;
      pkt.destinationHash = randomBytes(16);
      pkt.data = randomBytes(50); // way too short for an announce
      pkt.pack();

      expect(validateAnnounce(pkt)).toBeNull();
    });

    it('rejects non-announce packets', () => {
      const pkt = new Packet();
      pkt.packetType = 0x00; // DATA
      pkt.destType = DEST_SINGLE;
      pkt.destinationHash = randomBytes(16);
      pkt.data = randomBytes(200);
      pkt.pack();

      expect(validateAnnounce(pkt)).toBeNull();
    });
  });

  describe('round-trip through pack/parse', () => {
    it('announce survives serialization', () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'lxmf', 'delivery');
      const appData = fromUtf8('Test announce from Node.js RNS');
      const pkt = createAnnounce(dest, appData);

      // Simulate network: pack → raw bytes → parse
      const raw = pkt.pack();
      const received = Packet.parse(raw);
      const validated = validateAnnounce(received);

      expect(validated).not.toBeNull();
      expect(equal(validated.identity.hash, id.hash)).toBe(true);
      expect(equal(validated.destinationHash, dest.hash)).toBe(true);
      expect(equal(validated.appData, appData)).toBe(true);
    });
  });

  describe('Transport random_blob replay detection', () => {
    class MockIface extends EventEmitter {
      constructor(name) { super(); this.name = name; this.online = true; this.sent = []; }
      send(data) { this.sent.push(new Uint8Array(data)); }
    }

    it('accepts first announce and records randomBlobs', () => {
      const transport = new Transport();
      const iface = new MockIface('test');
      transport.registerInterface(iface);

      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'app', 'svc');
      const pkt = createAnnounce(dest);
      const raw = pkt.pack();

      iface.emit('packet', raw);

      const destHex = toHex(dest.hash);
      expect(transport.pathTable.has(destHex)).toBe(true);
      const entry = transport.pathTable.get(destHex);
      expect(entry.randomBlobs).toBeInstanceOf(Array);
      expect(entry.randomBlobs).toHaveLength(1);
    });

    it('rejects replayed announce with same random_blob', () => {
      const transport = new Transport();
      const iface = new MockIface('test');
      transport.registerInterface(iface);

      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'app', 'svc');
      const pkt = createAnnounce(dest);
      const raw = pkt.pack();

      // First announce
      iface.emit('packet', new Uint8Array(raw));
      const destHex = toHex(dest.hash);
      expect(transport.announceTable.has(destHex)).toBe(true);
      const firstTimestamp = transport.pathTable.get(destHex).timestamp;

      // Wait a tick, then replay the exact same packet
      transport.pathTable.get(destHex).timestamp = firstTimestamp - 10; // rewind so we detect no update

      iface.emit('packet', new Uint8Array(raw));
      // Path table timestamp should NOT have been updated — announce was a replay
      expect(transport.pathTable.get(destHex).timestamp).toBe(firstTimestamp - 10);
    });

    it('accepts a new announce with a different random_blob', () => {
      const transport = new Transport();
      const iface = new MockIface('test');
      transport.registerInterface(iface);

      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'app', 'svc');

      const pkt1 = createAnnounce(dest);
      iface.emit('packet', pkt1.pack());
      const destHex = toHex(dest.hash);
      expect(transport.pathTable.get(destHex).randomBlobs).toHaveLength(1);

      // Second announce with a fresh random_blob (different announce call)
      const pkt2 = createAnnounce(dest);
      iface.emit('packet', pkt2.pack());
      expect(transport.pathTable.get(destHex).randomBlobs).toHaveLength(2);
    });
  });
});
