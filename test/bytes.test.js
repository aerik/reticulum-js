import { describe, it, expect } from 'vitest';
import { concat, equal, fromHex, toHex, fromUtf8, toUtf8, randomBytes, truncate } from '../src/utils/bytes.js';

describe('bytes utilities', () => {
  describe('concat', () => {
    it('concatenates two arrays', () => {
      const a = new Uint8Array([1, 2, 3]);
      const b = new Uint8Array([4, 5]);
      const result = concat(a, b);
      expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    });

    it('concatenates multiple arrays', () => {
      const result = concat(
        new Uint8Array([1]),
        new Uint8Array([2, 3]),
        new Uint8Array([4, 5, 6])
      );
      expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    });

    it('handles empty arrays', () => {
      const a = new Uint8Array([1, 2]);
      const result = concat(a, new Uint8Array(0));
      expect(result).toEqual(a);
    });
  });

  describe('equal', () => {
    it('returns true for identical arrays', () => {
      expect(equal(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    });

    it('returns false for different arrays', () => {
      expect(equal(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    });

    it('returns false for different lengths', () => {
      expect(equal(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
    });
  });

  describe('hex conversion', () => {
    it('round-trips correctly', () => {
      const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      expect(toHex(bytes)).toBe('deadbeef');
      expect(fromHex('deadbeef')).toEqual(bytes);
    });

    it('handles all-zero bytes', () => {
      expect(toHex(new Uint8Array([0, 0, 0]))).toBe('000000');
      expect(fromHex('000000')).toEqual(new Uint8Array([0, 0, 0]));
    });

    it('throws on odd-length hex', () => {
      expect(() => fromHex('abc')).toThrow();
    });
  });

  describe('UTF-8 conversion', () => {
    it('round-trips ASCII', () => {
      expect(toUtf8(fromUtf8('hello'))).toBe('hello');
    });

    it('round-trips Unicode', () => {
      expect(toUtf8(fromUtf8('Reticulum 🌐'))).toBe('Reticulum 🌐');
    });
  });

  describe('randomBytes', () => {
    it('returns correct length', () => {
      expect(randomBytes(32).length).toBe(32);
    });

    it('returns different values each time', () => {
      const a = randomBytes(16);
      const b = randomBytes(16);
      expect(equal(a, b)).toBe(false);
    });
  });

  describe('truncate', () => {
    it('truncates to specified length', () => {
      const bytes = new Uint8Array([1, 2, 3, 4, 5]);
      expect(truncate(bytes, 3)).toEqual(new Uint8Array([1, 2, 3]));
    });
  });
});
