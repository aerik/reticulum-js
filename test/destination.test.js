import { describe, it, expect } from 'vitest';
import { Destination, RATCHET_INTERVAL, RATCHET_COUNT } from '../src/Destination.js';
import { Identity } from '../src/Identity.js';
import { Storage } from '../src/utils/storage.js';
import { MemoryBackend } from '../src/utils/storage-backend.js';
import { truncatedHash } from '../src/utils/crypto.js';
import { concat, fromUtf8, toHex, equal } from '../src/utils/bytes.js';
import {
  DEST_SINGLE, DEST_PLAIN, DEST_GROUP,
  DEST_IN, DEST_OUT,
  IDENTITY_NAME_HASH_LENGTH, IDENTITY_HASH_LENGTH,
} from '../src/constants.js';

describe('Destination', () => {
  describe('name construction', () => {
    it('builds dotted name from app + aspects', () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'myapp', 'service', 'endpoint');
      expect(dest.name).toBe('myapp.service.endpoint');
    });

    it('includes identity hexhash in fullName for SINGLE', () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'myapp', 'svc');
      expect(dest.fullName).toBe(`myapp.svc.${id.hexHash}`);
    });

    it('fullName has no hexhash for PLAIN (no identity)', () => {
      const dest = new Destination(null, DEST_IN, DEST_PLAIN, 'broadcast', 'channel');
      expect(dest.fullName).toBe('broadcast.channel');
    });
  });

  describe('name hash', () => {
    it('is 10 bytes (80 bits)', () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'test_app', 'service');
      expect(dest.nameHash).toHaveLength(10);
    });

    it('is SHA-256 of name string truncated to 10 bytes', () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'test_app', 'service');
      const expected = truncatedHash(fromUtf8('test_app.service'), IDENTITY_NAME_HASH_LENGTH);
      expect(equal(dest.nameHash, expected)).toBe(true);
    });

    it('does NOT include identity hexhash in name hash input', () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'myapp');
      // Name hash should be hash of "myapp", not "myapp.<hexhash>"
      const expected = truncatedHash(fromUtf8('myapp'), IDENTITY_NAME_HASH_LENGTH);
      expect(equal(dest.nameHash, expected)).toBe(true);
    });
  });

  describe('destination hash', () => {
    it('SINGLE: hash = SHA-256(name_hash + identity_hash)[:16]', () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'test_app', 'service');

      // Manually compute expected
      const nameHash = truncatedHash(fromUtf8('test_app.service'), 10);
      const expectedHash = truncatedHash(concat(nameHash, id.hash), 16);

      expect(dest.hash).toHaveLength(16);
      expect(equal(dest.hash, expectedHash)).toBe(true);
    });

    it('PLAIN: hash = SHA-256(name_hash)[:16]', () => {
      const dest = new Destination(null, DEST_IN, DEST_PLAIN, 'broadcast', 'channel');

      const nameHash = truncatedHash(fromUtf8('broadcast.channel'), 10);
      const expectedHash = truncatedHash(nameHash, 16);

      expect(dest.hash).toHaveLength(16);
      expect(equal(dest.hash, expectedHash)).toBe(true);
    });

    it('same name + same identity = same hash', () => {
      const id = Identity.generate();
      const d1 = new Destination(id, DEST_IN, DEST_SINGLE, 'app', 'svc');
      const d2 = new Destination(id, DEST_OUT, DEST_SINGLE, 'app', 'svc');
      expect(equal(d1.hash, d2.hash)).toBe(true);
    });

    it('same name + different identity = different hash', () => {
      const id1 = Identity.generate();
      const id2 = Identity.generate();
      const d1 = new Destination(id1, DEST_IN, DEST_SINGLE, 'app', 'svc');
      const d2 = new Destination(id2, DEST_IN, DEST_SINGLE, 'app', 'svc');
      expect(equal(d1.hash, d2.hash)).toBe(false);
    });

    it('different name + same identity = different hash', () => {
      const id = Identity.generate();
      const d1 = new Destination(id, DEST_IN, DEST_SINGLE, 'app', 'svc1');
      const d2 = new Destination(id, DEST_IN, DEST_SINGLE, 'app', 'svc2');
      expect(equal(d1.hash, d2.hash)).toBe(false);
    });
  });

  describe('static computeHash', () => {
    it('matches instance hash', () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'myapp', 'endpoint');
      const computed = Destination.computeHash(dest.nameHash, id.hash);
      expect(equal(computed, dest.hash)).toBe(true);
    });
  });

  describe('ratchets', () => {
    async function makeStorage() {
      const storage = new Storage(new MemoryBackend());
      await storage.init();
      return storage;
    }

    it('RATCHET_INTERVAL and RATCHET_COUNT match Python defaults', () => {
      expect(RATCHET_INTERVAL).toBe(30 * 60);
      expect(RATCHET_COUNT).toBe(512);
    });

    it('enableRatchets initializes an empty ratchet list on first use', async () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'myapp', 'endpoint');
      const storage = await makeStorage();
      await dest.enableRatchets(`storage/ratchets/${dest.hexHash}`, storage);
      expect(dest.ratchets).toEqual([]);
      expect(dest.currentRatchetPub()).toBeNull();
    });

    it('rotateRatchets generates a new ratchet on first call', async () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'myapp', 'endpoint');
      const storage = await makeStorage();
      await dest.enableRatchets(`storage/ratchets/${dest.hexHash}`, storage);

      const pub = await dest.rotateRatchets();
      expect(pub).toBeInstanceOf(Uint8Array);
      expect(pub).toHaveLength(32);
      expect(dest.ratchets).toHaveLength(1);
    });

    it('rotateRatchets skips rotation within the interval', async () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'myapp', 'endpoint');
      const storage = await makeStorage();
      await dest.enableRatchets(`storage/ratchets/${dest.hexHash}`, storage);

      const pub1 = await dest.rotateRatchets();
      const pub2 = await dest.rotateRatchets();
      expect(equal(pub1, pub2)).toBe(true);
      expect(dest.ratchets).toHaveLength(1);
    });

    it('rotateRatchets rotates once the interval elapses', async () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'myapp', 'endpoint');
      const storage = await makeStorage();
      await dest.enableRatchets(`storage/ratchets/${dest.hexHash}`, storage);
      dest.setRatchetInterval(1); // 1 second

      const pub1 = await dest.rotateRatchets();
      // Fake the interval by rewinding latestRatchetTime
      dest._latestRatchetTime -= 2;
      const pub2 = await dest.rotateRatchets();
      expect(equal(pub1, pub2)).toBe(false);
      expect(dest.ratchets).toHaveLength(2);
      // Newest entry sits at the front
      expect(equal(Identity.ratchetPublicBytes(dest.ratchets[0]), pub2)).toBe(true);
    });

    it('persists and reloads the ratchet list across instances', async () => {
      const id = Identity.generate();
      const d1 = new Destination(id, DEST_IN, DEST_SINGLE, 'myapp', 'endpoint');
      const storage = await makeStorage();
      const key = `storage/ratchets/${d1.hexHash}`;
      await d1.enableRatchets(key, storage);
      await d1.rotateRatchets();
      d1._latestRatchetTime -= 10000; // allow immediate re-rotation
      await d1.rotateRatchets();
      const originalRatchets = d1.ratchets.map((r) => new Uint8Array(r));

      // Fresh instance with same identity should reload the same list
      const d2 = new Destination(id, DEST_IN, DEST_SINGLE, 'myapp', 'endpoint');
      await d2.enableRatchets(key, storage);
      expect(d2.ratchets).toHaveLength(originalRatchets.length);
      for (let i = 0; i < originalRatchets.length; i++) {
        expect(equal(d2.ratchets[i], originalRatchets[i])).toBe(true);
      }
    });

    it('setRetainedRatchets trims excess ratchets', async () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'myapp', 'endpoint');
      const storage = await makeStorage();
      await dest.enableRatchets(`storage/ratchets/${dest.hexHash}`, storage);
      // Manually stuff the list
      dest.ratchets = [
        Identity.generateRatchet(), Identity.generateRatchet(), Identity.generateRatchet(),
      ];
      dest.setRetainedRatchets(2);
      expect(dest.ratchets).toHaveLength(2);
    });

    it('end-to-end: encrypt to current ratchet pub, decrypt via enabled ratchets', async () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'myapp', 'endpoint');
      const storage = await makeStorage();
      await dest.enableRatchets(`storage/ratchets/${dest.hexHash}`, storage);
      const pub = await dest.rotateRatchets();

      // A sender encrypts to that ratchet public key.
      const ct = await id.encrypt(fromUtf8('secret'), pub);
      // The destination's identity decrypts with the list of private ratchets.
      const pt = await id.decrypt(ct, { ratchets: dest.ratchets });
      expect(equal(pt, fromUtf8('secret'))).toBe(true);
    });

    it('rejects a ratchet file whose signature does not verify', async () => {
      const id = Identity.generate();
      const other = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'myapp', 'endpoint');
      const storage = await makeStorage();
      const key = `storage/ratchets/${dest.hexHash}`;

      // Persist under `other` so the signature is wrong for `id`
      await storage.saveDestinationRatchets(key, [Identity.generateRatchet()], other);

      await expect(dest.enableRatchets(key, storage)).rejects.toThrow(/signature/);
    });
  });
});
