import { describe, it, expect } from 'vitest';
import { Identity } from '../src/Identity.js';
import { equal, fromUtf8 } from '../src/utils/bytes.js';

describe('Identity', () => {
  describe('generate', () => {
    it('creates an identity with all keys', () => {
      const id = Identity.generate();
      expect(id.encryptionPrivateKey).toHaveLength(32);
      expect(id.encryptionPublicKey).toHaveLength(32);
      expect(id.signingPrivateKey).toHaveLength(32);
      expect(id.signingPublicKey).toHaveLength(32);
      expect(id.publicKey).toHaveLength(64);
      expect(id.hash).toHaveLength(16);
      expect(id.hexHash).toHaveLength(32);
    });

    it('generates unique identities', () => {
      const a = Identity.generate();
      const b = Identity.generate();
      expect(equal(a.hash, b.hash)).toBe(false);
    });
  });

  describe('export/import', () => {
    it('round-trips correctly', () => {
      const original = Identity.generate();
      const exported = original.export();
      expect(exported).toHaveLength(128);

      const restored = Identity.fromBytes(exported);
      expect(equal(restored.hash, original.hash)).toBe(true);
      expect(equal(restored.publicKey, original.publicKey)).toBe(true);
      expect(equal(restored.encryptionPrivateKey, original.encryptionPrivateKey)).toBe(true);
      expect(equal(restored.signingPrivateKey, original.signingPrivateKey)).toBe(true);
    });
  });

  describe('fromPublicKey', () => {
    it('creates a public-only identity', () => {
      const full = Identity.generate();
      const pubOnly = Identity.fromPublicKey(full.publicKey);

      expect(pubOnly.hasPrivateKey()).toBe(false);
      expect(equal(pubOnly.hash, full.hash)).toBe(true);
      expect(equal(pubOnly.encryptionPublicKey, full.encryptionPublicKey)).toBe(true);
      expect(equal(pubOnly.signingPublicKey, full.signingPublicKey)).toBe(true);
    });

    it('throws on wrong-sized input', () => {
      expect(() => Identity.fromPublicKey(new Uint8Array(32))).toThrow();
    });
  });

  describe('sign/verify', () => {
    it('signs and verifies data', () => {
      const id = Identity.generate();
      const data = fromUtf8('test message');
      const sig = id.sign(data);

      expect(sig).toHaveLength(64);
      expect(id.verify(data, sig)).toBe(true);
    });

    it('verifies with public-only identity', () => {
      const full = Identity.generate();
      const pubOnly = Identity.fromPublicKey(full.publicKey);
      const data = fromUtf8('test');
      const sig = full.sign(data);

      expect(pubOnly.verify(data, sig)).toBe(true);
    });

    it('rejects tampered data', () => {
      const id = Identity.generate();
      const sig = id.sign(fromUtf8('original'));
      expect(id.verify(fromUtf8('tampered'), sig)).toBe(false);
    });

    it('throws when signing without private key', () => {
      const full = Identity.generate();
      const pubOnly = Identity.fromPublicKey(full.publicKey);
      expect(() => pubOnly.sign(fromUtf8('test'))).toThrow();
    });
  });

  describe('encrypt/decrypt', () => {
    it('encrypts and decrypts a message', async () => {
      const sender = Identity.generate();
      const recipient = Identity.generate();

      const plaintext = fromUtf8('secret message for reticulum');

      // Encrypt to recipient's public key
      const ciphertext = await recipient.encrypt(plaintext);

      // Recipient decrypts
      const decrypted = await recipient.decrypt(ciphertext);
      expect(equal(decrypted, plaintext)).toBe(true);
    });

    it('different identities cannot decrypt', async () => {
      const recipient = Identity.generate();
      const other = Identity.generate();

      const ciphertext = await recipient.encrypt(fromUtf8('secret'));

      await expect(other.decrypt(ciphertext)).rejects.toThrow();
    });

    it('throws when decrypting without private key', async () => {
      const full = Identity.generate();
      const pubOnly = Identity.fromPublicKey(full.publicKey);

      await expect(pubOnly.decrypt(new Uint8Array(64))).rejects.toThrow();
    });

    it('rejects ciphertext that is too short', async () => {
      const id = Identity.generate();
      await expect(id.decrypt(new Uint8Array(20))).rejects.toThrow();
    });

    it('rejects ciphertext with bad HMAC', async () => {
      const id = Identity.generate();
      const ct = await id.encrypt(fromUtf8('test'));
      // Tamper with the HMAC (last 32 bytes)
      ct[ct.length - 1] ^= 0xFF;
      await expect(id.decrypt(ct)).rejects.toThrow(/HMAC/);
    });

    it('handles empty plaintext', async () => {
      const id = Identity.generate();
      const ct = await id.encrypt(new Uint8Array(0));
      const pt = await id.decrypt(ct);
      expect(pt.length).toBe(0);
    });
  });

  describe('exportPrivateKey / fromPrivateKey', () => {
    it('exports 64-byte private key', () => {
      const id = Identity.generate();
      const prv = id.exportPrivateKey();
      expect(prv).toHaveLength(64);
    });

    it('throws when exporting public-only identity', () => {
      const full = Identity.generate();
      const pubOnly = Identity.fromPublicKey(full.publicKey);
      expect(() => pubOnly.exportPrivateKey()).toThrow();
    });

    it('fromPrivateKey reconstructs identity with matching hash', () => {
      const original = Identity.generate();
      const prvBytes = original.exportPrivateKey();

      const restored = Identity.fromPrivateKey(prvBytes);
      expect(equal(restored.hash, original.hash)).toBe(true);
      expect(equal(restored.publicKey, original.publicKey)).toBe(true);
      expect(restored.hasPrivateKey()).toBe(true);
    });

    it('fromPrivateKey can sign and encrypt', async () => {
      const original = Identity.generate();
      const restored = Identity.fromPrivateKey(original.exportPrivateKey());

      // Sign
      const sig = restored.sign(fromUtf8('test'));
      expect(original.verify(fromUtf8('test'), sig)).toBe(true);

      // Encrypt/decrypt
      const ct = await restored.encrypt(fromUtf8('hello'));
      const pt = await restored.decrypt(ct);
      expect(equal(pt, fromUtf8('hello'))).toBe(true);
    });
  });
});
