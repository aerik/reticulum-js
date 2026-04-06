import { describe, it, expect } from 'vitest';
import { Destination } from '../src/Destination.js';
import { Identity } from '../src/Identity.js';
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
});
