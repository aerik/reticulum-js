import { describe, it, expect } from 'vitest';
import { Identity } from '../src/Identity.js';
import { Storage } from '../src/utils/storage.js';
import { MemoryBackend } from '../src/utils/storage-backend.js';
import { equal, fromUtf8, toHex } from '../src/utils/bytes.js';
import { generateX25519Keypair } from '../src/utils/crypto.js';

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

  describe('multi-ratchet decrypt', () => {
    // These tests exercise the Python-style decrypt() options added to match
    // RNS/Identity.py:713 — specifically the multi-ratchet walk and the
    // enforce_ratchets flag.

    it('decrypts a message encrypted to a ratchet public key', async () => {
      const recipient = Identity.generate();
      const ratchet = generateX25519Keypair();
      const ct = await recipient.encrypt(fromUtf8('msg'), ratchet.publicKey);
      const pt = await recipient.decrypt(ct, { ratchets: [ratchet.privateKey] });
      expect(equal(pt, fromUtf8('msg'))).toBe(true);
    });

    it('walks the ratchets list until one works', async () => {
      const recipient = Identity.generate();
      const r1 = generateX25519Keypair();
      const r2 = generateX25519Keypair();
      const r3 = generateX25519Keypair();
      const ct = await recipient.encrypt(fromUtf8('msg'), r2.publicKey);
      // Provide in an order where r2 isn't first — decrypt must iterate.
      const pt = await recipient.decrypt(ct, {
        ratchets: [r1.privateKey, r3.privateKey, r2.privateKey],
      });
      expect(equal(pt, fromUtf8('msg'))).toBe(true);
    });

    it('falls back to base key when no ratchet matches', async () => {
      const recipient = Identity.generate();
      const wrongRatchet = generateX25519Keypair();
      // Encrypt with the identity's BASE key (no ratchet)
      const ct = await recipient.encrypt(fromUtf8('msg'));
      // Pass a wrong ratchet — should fall through to base key
      const pt = await recipient.decrypt(ct, { ratchets: [wrongRatchet.privateKey] });
      expect(equal(pt, fromUtf8('msg'))).toBe(true);
    });

    it('enforceRatchets fails instead of falling back to base', async () => {
      const recipient = Identity.generate();
      const wrongRatchet = generateX25519Keypair();
      const ct = await recipient.encrypt(fromUtf8('msg'));
      await expect(
        recipient.decrypt(ct, {
          ratchets: [wrongRatchet.privateKey],
          enforceRatchets: true,
        })
      ).rejects.toThrow(/Ratchet-enforced/);
    });

    it('populates ratchetIdReceiver on ratchet success', async () => {
      const recipient = Identity.generate();
      const ratchet = generateX25519Keypair();
      const ct = await recipient.encrypt(fromUtf8('msg'), ratchet.publicKey);
      const receiver = { latestRatchetId: undefined };
      await recipient.decrypt(ct, {
        ratchets: [ratchet.privateKey],
        ratchetIdReceiver: receiver,
      });
      expect(receiver.latestRatchetId).toBeInstanceOf(Uint8Array);
      expect(receiver.latestRatchetId).toHaveLength(10);
      // Should equal Identity.getRatchetId(ratchet.publicKey)
      expect(equal(receiver.latestRatchetId, Identity.getRatchetId(ratchet.publicKey))).toBe(true);
    });

    it('sets ratchetIdReceiver.latestRatchetId = null when base key is used', async () => {
      const recipient = Identity.generate();
      const ct = await recipient.encrypt(fromUtf8('msg'));
      const receiver = { latestRatchetId: undefined };
      await recipient.decrypt(ct, { ratchetIdReceiver: receiver });
      expect(receiver.latestRatchetId).toBe(null);
    });

    it('legacy instance _ratchetPriv still works for callers without options', async () => {
      const recipient = Identity.generate();
      const ratchetPub = recipient.rotateRatchet();
      const ct = await recipient.encrypt(fromUtf8('msg'), ratchetPub);
      const pt = await recipient.decrypt(ct);
      expect(equal(pt, fromUtf8('msg'))).toBe(true);
    });
  });

  describe('static known-ratchet store', () => {
    // These exercise the class-level known_ratchets store that Transport uses
    // to remember remote destinations' advertised ratchets. Mirrors Python
    // `Identity.known_ratchets` + `_remember_ratchet` / `get_ratchet` /
    // `_clean_ratchets` in RNS/Identity.py:94-363.

    it('generateRatchet returns 32-byte X25519 private bytes', () => {
      const priv = Identity.generateRatchet();
      expect(priv).toBeInstanceOf(Uint8Array);
      expect(priv).toHaveLength(32);
    });

    it('ratchetPublicBytes derives a matching public key', () => {
      const priv = Identity.generateRatchet();
      const pub = Identity.ratchetPublicBytes(priv);
      expect(pub).toHaveLength(32);
      // Encrypting to the derived pub and decrypting with the priv should
      // round-trip through _decryptWith().
      const recipient = Identity.generate();
      return recipient.encrypt(fromUtf8('roundtrip'), pub).then(async (ct) => {
        const pt = await recipient.decrypt(ct, { ratchets: [priv] });
        expect(equal(pt, fromUtf8('roundtrip'))).toBe(true);
      });
    });

    it('remembers and recalls a remote ratchet', async () => {
      Identity._resetKnownRatchets();
      const destHash = new Uint8Array(16);
      for (let i = 0; i < 16; i++) destHash[i] = i;
      const pub = Identity.ratchetPublicBytes(Identity.generateRatchet());

      await Identity.rememberRatchet(destHash, pub);
      const recalled = await Identity.getRatchet(destHash);
      expect(recalled).toBeInstanceOf(Uint8Array);
      expect(equal(recalled, pub)).toBe(true);
    });

    it('returns null for an unknown destination', async () => {
      Identity._resetKnownRatchets();
      const destHash = new Uint8Array(16);
      destHash[0] = 0xAB;
      const recalled = await Identity.getRatchet(destHash);
      expect(recalled).toBeNull();
    });

    it('expires a ratchet older than RATCHET_EXPIRY', async () => {
      Identity._resetKnownRatchets();
      const destHash = new Uint8Array(16);
      destHash[0] = 0xCD;
      const pub = Identity.ratchetPublicBytes(Identity.generateRatchet());

      await Identity.rememberRatchet(destHash, pub);
      // Rewind the entry's `received` timestamp into the distant past.
      const hex = [...destHash].map((b) => b.toString(16).padStart(2, '0')).join('');
      const entry = Identity._knownRatchets.get(hex);
      entry.received -= Identity.RATCHET_EXPIRY + 1;

      const recalled = await Identity.getRatchet(destHash);
      expect(recalled).toBeNull();
      // Also evicted from the in-memory map
      expect(Identity._knownRatchets.has(hex)).toBe(false);
    });

    it('cleanRatchets drops expired entries in-memory', async () => {
      Identity._resetKnownRatchets();
      const fresh = new Uint8Array(16); fresh[0] = 1;
      const stale = new Uint8Array(16); stale[0] = 2;
      await Identity.rememberRatchet(fresh, Identity.ratchetPublicBytes(Identity.generateRatchet()));
      await Identity.rememberRatchet(stale, Identity.ratchetPublicBytes(Identity.generateRatchet()));

      // Age out the stale entry
      const staleHex = '02' + '00'.repeat(15);
      Identity._knownRatchets.get(staleHex).received -= Identity.RATCHET_EXPIRY + 1;

      await Identity.cleanRatchets();
      expect(Identity._knownRatchets.has(staleHex)).toBe(false);
      expect(Identity._knownRatchets.size).toBe(1);
    });

    it('rememberRatchet persists to Storage when provided', async () => {
      Identity._resetKnownRatchets();
      const storage = new Storage(new MemoryBackend());
      await storage.init();

      const destHash = new Uint8Array(16); destHash[0] = 0xEE;
      const pub = Identity.ratchetPublicBytes(Identity.generateRatchet());
      await Identity.rememberRatchet(destHash, pub, { storage });

      // Verify it landed in storage
      const hexHash = toHex(destHash);
      const loaded = await storage.loadRemoteRatchet(hexHash);
      expect(loaded).not.toBeNull();
      expect(equal(loaded.ratchet, pub)).toBe(true);
      expect(typeof loaded.received).toBe('number');
    });

    it('getRatchet loads from Storage on cache miss', async () => {
      Identity._resetKnownRatchets();
      const storage = new Storage(new MemoryBackend());
      await storage.init();

      const destHash = new Uint8Array(16); destHash[0] = 0xDD;
      const pub = Identity.ratchetPublicBytes(Identity.generateRatchet());

      // Write directly to storage (bypassing in-memory map)
      await storage.saveRemoteRatchet(toHex(destHash), {
        ratchet: pub,
        received: Date.now() / 1000,
      });

      // Should load on miss
      const recalled = await Identity.getRatchet(destHash, { storage });
      expect(recalled).not.toBeNull();
      expect(equal(recalled, pub)).toBe(true);
      // Now also cached in memory
      expect(Identity._knownRatchets.has(toHex(destHash))).toBe(true);
    });

    it('getRatchet returns null when storage entry is expired', async () => {
      Identity._resetKnownRatchets();
      const storage = new Storage(new MemoryBackend());
      await storage.init();

      const destHash = new Uint8Array(16); destHash[0] = 0xCC;
      const pub = Identity.ratchetPublicBytes(Identity.generateRatchet());

      await storage.saveRemoteRatchet(toHex(destHash), {
        ratchet: pub,
        received: (Date.now() / 1000) - Identity.RATCHET_EXPIRY - 1,
      });

      const recalled = await Identity.getRatchet(destHash, { storage });
      expect(recalled).toBeNull();
    });

    it('cleanRatchets removes expired entries from Storage', async () => {
      Identity._resetKnownRatchets();
      const storage = new Storage(new MemoryBackend());
      await storage.init();

      const freshHash = 'aa' + '00'.repeat(15);
      const staleHash = 'bb' + '00'.repeat(15);
      const now = Date.now() / 1000;

      await storage.saveRemoteRatchet(freshHash, {
        ratchet: Identity.ratchetPublicBytes(Identity.generateRatchet()),
        received: now,
      });
      await storage.saveRemoteRatchet(staleHash, {
        ratchet: Identity.ratchetPublicBytes(Identity.generateRatchet()),
        received: now - Identity.RATCHET_EXPIRY - 1,
      });

      await Identity.cleanRatchets({ storage });
      expect(await storage.loadRemoteRatchet(freshHash)).not.toBeNull();
      expect(await storage.loadRemoteRatchet(staleHash)).toBeNull();
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
