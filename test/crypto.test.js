import { describe, it, expect } from 'vitest';
import {
  generateX25519Keypair,
  generateEd25519Keypair,
  x25519SharedSecret,
  ed25519Sign,
  ed25519Verify,
  sha256Hash,
  truncatedHash,
  hmacSha256,
  hkdfDerive,
  aes128CbcEncrypt,
  aes128CbcDecrypt,
  pkcs7Pad,
  pkcs7Unpad,
} from '../src/utils/crypto.js';
import { fromHex, toHex, fromUtf8, equal } from '../src/utils/bytes.js';

describe('crypto utilities', () => {
  describe('X25519', () => {
    it('generates valid keypairs', () => {
      const kp = generateX25519Keypair();
      expect(kp.privateKey).toHaveLength(32);
      expect(kp.publicKey).toHaveLength(32);
    });

    it('computes matching shared secrets', () => {
      const alice = generateX25519Keypair();
      const bob = generateX25519Keypair();
      const sharedA = x25519SharedSecret(alice.privateKey, bob.publicKey);
      const sharedB = x25519SharedSecret(bob.privateKey, alice.publicKey);
      expect(equal(sharedA, sharedB)).toBe(true);
    });
  });

  describe('Ed25519', () => {
    it('generates valid keypairs', () => {
      const kp = generateEd25519Keypair();
      expect(kp.privateKey).toHaveLength(32);
      expect(kp.publicKey).toHaveLength(32);
    });

    it('signs and verifies', () => {
      const kp = generateEd25519Keypair();
      const message = fromUtf8('Reticulum test message');
      const sig = ed25519Sign(message, kp.privateKey);
      expect(sig).toHaveLength(64);
      expect(ed25519Verify(sig, message, kp.publicKey)).toBe(true);
    });

    it('rejects tampered message', () => {
      const kp = generateEd25519Keypair();
      const message = fromUtf8('original');
      const sig = ed25519Sign(message, kp.privateKey);
      const tampered = fromUtf8('tampered');
      expect(ed25519Verify(sig, tampered, kp.publicKey)).toBe(false);
    });

    it('rejects wrong key', () => {
      const kp1 = generateEd25519Keypair();
      const kp2 = generateEd25519Keypair();
      const message = fromUtf8('test');
      const sig = ed25519Sign(message, kp1.privateKey);
      expect(ed25519Verify(sig, message, kp2.publicKey)).toBe(false);
    });
  });

  describe('SHA-256', () => {
    it('hashes empty input correctly', () => {
      const hash = sha256Hash(new Uint8Array(0));
      expect(toHex(hash)).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('hashes known input correctly', () => {
      const hash = sha256Hash(fromUtf8('hello'));
      expect(toHex(hash)).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    });
  });

  describe('truncatedHash', () => {
    it('returns 16 bytes by default', () => {
      const hash = truncatedHash(fromUtf8('test'));
      expect(hash).toHaveLength(16);
    });

    it('is prefix of full hash', () => {
      const data = fromUtf8('test');
      const full = sha256Hash(data);
      const trunc = truncatedHash(data, 16);
      expect(equal(trunc, full.slice(0, 16))).toBe(true);
    });
  });

  describe('HMAC-SHA-256', () => {
    it('produces 32-byte output', () => {
      const key = fromUtf8('secret');
      const msg = fromUtf8('message');
      const mac = hmacSha256(key, msg);
      expect(mac).toHaveLength(32);
    });

    it('is deterministic', () => {
      const key = fromUtf8('key');
      const msg = fromUtf8('msg');
      expect(equal(hmacSha256(key, msg), hmacSha256(key, msg))).toBe(true);
    });
  });

  describe('HKDF', () => {
    it('derives requested length', () => {
      const ikm = fromUtf8('input key material');
      expect(hkdfDerive(ikm, 32)).toHaveLength(32);
      expect(hkdfDerive(ikm, 48)).toHaveLength(48);
      expect(hkdfDerive(ikm, 16)).toHaveLength(16);
    });
  });

  describe('AES-128-CBC (16-byte key)', () => {
    it('encrypts and decrypts', async () => {
      const key = fromHex('00112233445566778899aabbccddeeff');
      const iv = fromHex('0f1e2d3c4b5a69788796a5b4c3d2e1f0');
      const plaintext = fromUtf8('hello reticulum!'); // exactly 16 bytes

      const ciphertext = await aes128CbcEncrypt(plaintext, key, iv);
      expect(ciphertext.length).toBeGreaterThan(0);

      const decrypted = await aes128CbcDecrypt(ciphertext, key, iv);
      expect(equal(decrypted, plaintext)).toBe(true);
    });

    it('handles multi-block plaintext', async () => {
      const key = fromHex('00112233445566778899aabbccddeeff');
      const iv = fromHex('0f1e2d3c4b5a69788796a5b4c3d2e1f0');
      const plaintext = fromUtf8('this is a longer message that spans multiple AES blocks for testing');

      const ciphertext = await aes128CbcEncrypt(plaintext, key, iv);
      const decrypted = await aes128CbcDecrypt(ciphertext, key, iv);
      expect(equal(decrypted, plaintext)).toBe(true);
    });
  });

  describe('AES-256-CBC (32-byte key)', () => {
    it('encrypts and decrypts with 32-byte key', async () => {
      const { aesCbcEncrypt, aesCbcDecrypt } = await import('../src/utils/crypto.js');
      const key = fromHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
      const iv = fromHex('0f1e2d3c4b5a69788796a5b4c3d2e1f0');
      const plaintext = fromUtf8('AES-256 test data');

      const ciphertext = await aesCbcEncrypt(plaintext, key, iv);
      const decrypted = await aesCbcDecrypt(ciphertext, key, iv);
      expect(equal(decrypted, plaintext)).toBe(true);
    });

    it('produces different ciphertext than AES-128 with same IV', async () => {
      const { aesCbcEncrypt } = await import('../src/utils/crypto.js');
      const key128 = fromHex('00112233445566778899aabbccddeeff');
      const key256 = fromHex('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff');
      const iv = fromHex('0f1e2d3c4b5a69788796a5b4c3d2e1f0');
      const plaintext = fromUtf8('same plaintext');

      const ct128 = await aesCbcEncrypt(plaintext, key128, iv);
      const ct256 = await aesCbcEncrypt(plaintext, key256, iv);
      expect(equal(ct128, ct256)).toBe(false);
    });

    it('handles empty plaintext', async () => {
      const { aesCbcEncrypt, aesCbcDecrypt } = await import('../src/utils/crypto.js');
      const key = fromHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
      const iv = fromHex('0f1e2d3c4b5a69788796a5b4c3d2e1f0');
      const plaintext = new Uint8Array(0);

      const ciphertext = await aesCbcEncrypt(plaintext, key, iv);
      expect(ciphertext.length).toBe(16); // one block of padding
      const decrypted = await aesCbcDecrypt(ciphertext, key, iv);
      expect(decrypted.length).toBe(0);
    });

    it('handles block-aligned plaintext (adds full padding block)', async () => {
      const { aesCbcEncrypt, aesCbcDecrypt } = await import('../src/utils/crypto.js');
      const key = fromHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
      const iv = fromHex('0f1e2d3c4b5a69788796a5b4c3d2e1f0');
      const plaintext = new Uint8Array(32).fill(0x42); // exactly 2 blocks

      const ciphertext = await aesCbcEncrypt(plaintext, key, iv);
      expect(ciphertext.length).toBe(48); // 2 blocks + 1 padding block
      const decrypted = await aesCbcDecrypt(ciphertext, key, iv);
      expect(equal(decrypted, plaintext)).toBe(true);
    });

    it('rejects wrong key on decrypt', async () => {
      const { aesCbcEncrypt, aesCbcDecrypt } = await import('../src/utils/crypto.js');
      const key1 = fromHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
      const key2 = fromHex('ff0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
      const iv = fromHex('0f1e2d3c4b5a69788796a5b4c3d2e1f0');

      const ciphertext = await aesCbcEncrypt(fromUtf8('secret'), key1, iv);
      // Wrong key should fail (bad padding after decrypt)
      await expect(aesCbcDecrypt(ciphertext, key2, iv)).rejects.toThrow();
    });
  });

  describe('HKDF edge cases', () => {
    it('derives with explicit salt and info', () => {
      const ikm = fromUtf8('input');
      const salt = fromUtf8('salt-value');
      const info = fromUtf8('context-info');
      const derived = hkdfDerive(ikm, 32, salt, info);
      expect(derived).toHaveLength(32);

      // Same inputs should produce same output
      const derived2 = hkdfDerive(ikm, 32, salt, info);
      expect(equal(derived, derived2)).toBe(true);
    });

    it('different salt produces different output', () => {
      const ikm = fromUtf8('input');
      const d1 = hkdfDerive(ikm, 32, fromUtf8('salt1'));
      const d2 = hkdfDerive(ikm, 32, fromUtf8('salt2'));
      expect(equal(d1, d2)).toBe(false);
    });
  });

  describe('PKCS7', () => {
    it('pads and unpads correctly', () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const padded = pkcs7Pad(data);
      expect(padded.length).toBe(16);
      expect(padded[15]).toBe(11);
      expect(equal(pkcs7Unpad(padded), data)).toBe(true);
    });

    it('pads full block when input is block-aligned', () => {
      const data = new Uint8Array(16).fill(0xAA);
      const padded = pkcs7Pad(data);
      expect(padded.length).toBe(32);
    });

    it('throws on invalid padding (value 0)', () => {
      const bad = new Uint8Array(16);
      bad[15] = 0;
      expect(() => pkcs7Unpad(bad)).toThrow(/padding/i);
    });

    it('throws on padding value > 16', () => {
      const bad = new Uint8Array(16);
      bad[15] = 17;
      expect(() => pkcs7Unpad(bad)).toThrow(/padding/i);
    });

    it('round-trips single byte', () => {
      const data = new Uint8Array([0x42]);
      expect(equal(pkcs7Unpad(pkcs7Pad(data)), data)).toBe(true);
    });

    it('round-trips empty data', () => {
      const data = new Uint8Array(0);
      const padded = pkcs7Pad(data);
      expect(padded.length).toBe(16); // full padding block
      expect(padded[0]).toBe(16);     // padding value = 16
      expect(equal(pkcs7Unpad(padded), data)).toBe(true);
    });
  });
});
