/**
 * Identity — an RNS identity (X25519 + Ed25519 keypair).
 *
 * Matches the Python reference implementation (RNS/Identity.py).
 *
 * Public key blob = X25519 pub (32 bytes) + Ed25519 pub (32 bytes) = 64 bytes
 * Identity hash = SHA-256(public_key_blob)[:16]
 *
 * Encryption uses a Fernet-like token scheme:
 *   1. Ephemeral X25519 ECDH → shared secret
 *   2. HKDF-SHA256(ikm=shared, salt=recipient_identity_hash, info=empty) → 64 bytes
 *   3. Split: signing_key[0:32], encryption_key[32:64]
 *   4. AES-256-CBC encrypt with random IV, PKCS7 padding
 *   5. HMAC-SHA256(signing_key, iv + ciphertext)
 *   6. Output: ephemeral_pub(32) + iv(16) + ciphertext + hmac(32)
 */

import {
  generateX25519Keypair,
  generateEd25519Keypair,
  x25519SharedSecret,
  ed25519Sign,
  ed25519Verify,
  sha256Hash,
  truncatedHash,
  hkdfDerive,
  hmacSha256,
  aesCbcEncrypt,
  aesCbcDecrypt,
} from './utils/crypto.js';
import { concat, toHex, fromHex, randomBytes, equal } from './utils/bytes.js';
import {
  IDENTITY_HASH_LENGTH,
  IDENTITY_DERIVED_KEY_LENGTH,
  IDENTITY_NAME_HASH_LENGTH,
} from './constants.js';

export class Identity {
  /**
   * @param {Uint8Array|null} encPriv - X25519 private key
   * @param {Uint8Array} encPub - X25519 public key
   * @param {Uint8Array|null} sigPriv - Ed25519 private key
   * @param {Uint8Array} sigPub - Ed25519 public key
   */
  constructor(encPriv, encPub, sigPriv, sigPub) {
    this.encryptionPrivateKey = encPriv;
    this.encryptionPublicKey = encPub;
    this.signingPrivateKey = sigPriv;
    this.signingPublicKey = sigPub;

    // Public key blob = encryption pub + signing pub (64 bytes total)
    // X25519 first, Ed25519 second — matches Python get_public_key()
    this.publicKey = concat(encPub, sigPub);

    // Identity hash = truncated SHA-256 of public key blob
    this.hash = truncatedHash(this.publicKey, IDENTITY_HASH_LENGTH);
    this.hexHash = toHex(this.hash);

    // Ratchet state: current ratchet keypair for forward-secrecy on announces.
    // Only local identities (with private keys) manage ratchets.
    this._ratchetPriv = null;  // X25519 private key
    this._ratchetPub = null;   // X25519 public key (included in announces)
  }

  /**
   * Generate a new random identity.
   * @returns {Identity}
   */
  static generate() {
    const enc = generateX25519Keypair();
    const sig = generateEd25519Keypair();
    return new Identity(enc.privateKey, enc.publicKey, sig.privateKey, sig.publicKey);
  }

  /**
   * Reconstruct an identity from its public key blob (64 bytes).
   * Creates a "remote" identity without private keys.
   * @param {Uint8Array} publicKeyBlob - 64 bytes (32 enc + 32 sig)
   * @returns {Identity}
   */
  static fromPublicKey(publicKeyBlob) {
    if (publicKeyBlob.length !== 64) {
      throw new Error(`Expected 64-byte public key, got ${publicKeyBlob.length}`);
    }
    const encPub = publicKeyBlob.slice(0, 32);
    const sigPub = publicKeyBlob.slice(32, 64);
    return new Identity(null, encPub, null, sigPub);
  }

  /**
   * Export the identity's private keys for persistence.
   * Format matches Python: enc_prv(32) + sig_prv(32) = 64 bytes
   * Public keys are derived on load, not stored.
   * @returns {Uint8Array} 64 bytes: encPriv(32) + sigPriv(32)
   */
  exportPrivateKey() {
    if (!this.encryptionPrivateKey || !this.signingPrivateKey) {
      throw new Error('Cannot export a public-only identity');
    }
    return concat(this.encryptionPrivateKey, this.signingPrivateKey);
  }

  /**
   * Import an identity from private key bytes.
   * Public keys are derived from the private keys.
   * @param {Uint8Array} data - 64 bytes: encPriv(32) + sigPriv(32)
   * @returns {Identity}
   */
  static fromPrivateKey(data) {
    if (data.length !== 64) {
      throw new Error(`Expected 64-byte private key, got ${data.length}`);
    }
    const encPriv = data.slice(0, 32);
    const sigPriv = data.slice(32, 64);
    // Derive public keys from private keys
    const encPub = _x25519.getPublicKey(encPriv);
    const sigPub = _ed25519.getPublicKey(sigPriv);
    return new Identity(encPriv, encPub, sigPriv, sigPub);
  }

  /**
   * Export full identity (private + public) for our internal persistence.
   * @returns {Uint8Array} 128 bytes: encPriv(32) + encPub(32) + sigPriv(32) + sigPub(32)
   */
  export() {
    if (!this.encryptionPrivateKey || !this.signingPrivateKey) {
      throw new Error('Cannot export a public-only identity');
    }
    return concat(
      this.encryptionPrivateKey,
      this.encryptionPublicKey,
      this.signingPrivateKey,
      this.signingPublicKey
    );
  }

  /**
   * Import an identity from our internal format (128 bytes with all keys).
   * @param {Uint8Array} data - 128 bytes from export()
   * @returns {Identity}
   */
  static fromBytes(data) {
    if (data.length !== 128) {
      throw new Error(`Expected 128-byte identity, got ${data.length}`);
    }
    return new Identity(
      data.slice(0, 32),
      data.slice(32, 64),
      data.slice(64, 96),
      data.slice(96, 128)
    );
  }

  /**
   * Whether this identity has private keys (i.e., is a local identity).
   * @returns {boolean}
   */
  hasPrivateKey() {
    return this.encryptionPrivateKey !== null && this.signingPrivateKey !== null;
  }

  /**
   * Sign data with this identity's Ed25519 signing key.
   * @param {Uint8Array} data
   * @returns {Uint8Array} 64-byte signature
   */
  sign(data) {
    if (!this.signingPrivateKey) {
      throw new Error('Cannot sign without private key');
    }
    return ed25519Sign(data, this.signingPrivateKey);
  }

  /**
   * Verify a signature against this identity's public signing key.
   * @param {Uint8Array} data
   * @param {Uint8Array} signature
   * @returns {boolean}
   */
  verify(data, signature) {
    return ed25519Verify(signature, data, this.signingPublicKey);
  }

  // --- Ratchet management ---

  /**
   * Generate a new ratchet keypair. The public key is included in announces
   * so that senders can encrypt specifically for this ratchet, providing
   * forward secrecy even if the base identity key is compromised later.
   * @returns {Uint8Array} 32-byte ratchet public key (for including in announces)
   */
  rotateRatchet() {
    if (!this.hasPrivateKey()) {
      throw new Error('Cannot rotate ratchet on a public-only identity');
    }
    const kp = generateX25519Keypair();
    this._ratchetPriv = kp.privateKey;
    this._ratchetPub = kp.publicKey;
    return this._ratchetPub;
  }

  /**
   * Get the current ratchet public key, or null if none.
   * @returns {Uint8Array|null}
   */
  get ratchetPublicKey() {
    return this._ratchetPub;
  }

  /**
   * Set a known ratchet public key for a remote identity.
   * Used when receiving an announce with a ratchet.
   * @param {Uint8Array} pubKey - 32-byte X25519 public key
   */
  setRemoteRatchet(pubKey) {
    this._ratchetPub = pubKey;
  }

  // --- Static known-ratchets store ---
  //
  // Mirrors Python's class-level `Identity.known_ratchets` dict
  // (RNS/Identity.py:94). Maps a remote destination hash (hex) to the most
  // recently advertised ratchet public key for that destination, so outgoing
  // packets to that destination can be encrypted with its current ratchet
  // instead of the base key. Entries expire after RATCHET_EXPIRY.

  /**
   * Generate a fresh ratchet private key (32-byte X25519 scalar).
   * Matches Python `Identity._generate_ratchet` in RNS/Identity.py:290.
   * @returns {Uint8Array}
   */
  static generateRatchet() {
    return generateX25519Keypair().privateKey;
  }

  /**
   * Derive the ratchet public key from its private bytes.
   * Matches Python `Identity._ratchet_public_bytes` in RNS/Identity.py:287.
   * @param {Uint8Array} ratchetPriv - 32-byte X25519 private key
   * @returns {Uint8Array} 32-byte X25519 public key
   */
  static ratchetPublicBytes(ratchetPriv) {
    return _x25519.getPublicKey(ratchetPriv);
  }

  /**
   * Remember a remote destination's current ratchet public key. If a
   * `Storage` instance is supplied it also persists the entry so it
   * survives restart. Matches Python `Identity._remember_ratchet` in
   * RNS/Identity.py:296.
   *
   * @param {Uint8Array} destinationHash - 16-byte destination hash
   * @param {Uint8Array} ratchetPub - 32-byte X25519 public key
   * @param {object} [options]
   * @param {import('./utils/storage.js').Storage} [options.storage]
   */
  static async rememberRatchet(destinationHash, ratchetPub, options = {}) {
    if (!ratchetPub || ratchetPub.length !== 32) return false;
    const hexHash = toHex(destinationHash);
    const existing = Identity._knownRatchets.get(hexHash);
    if (existing && equal(existing.ratchet, ratchetPub)) return true;

    const entry = { ratchet: new Uint8Array(ratchetPub), received: Date.now() / 1000 };
    Identity._knownRatchets.set(hexHash, entry);

    if (options.storage && typeof options.storage.saveRemoteRatchet === 'function') {
      try {
        await options.storage.saveRemoteRatchet(hexHash, entry);
      } catch (err) {
        // Best-effort — in-memory entry is still valid.
      }
    }
    return true;
  }

  /**
   * Look up a remote destination's current ratchet public key. On a cache
   * miss, tries to load from the supplied Storage. Returns null if the
   * entry is unknown or has exceeded RATCHET_EXPIRY.
   * Matches Python `Identity.get_ratchet` in RNS/Identity.py:365.
   *
   * @param {Uint8Array} destinationHash - 16-byte destination hash
   * @param {object} [options]
   * @param {import('./utils/storage.js').Storage} [options.storage]
   * @returns {Promise<Uint8Array|null>}
   */
  static async getRatchet(destinationHash, options = {}) {
    const hexHash = toHex(destinationHash);
    const now = Date.now() / 1000;

    let entry = Identity._knownRatchets.get(hexHash);
    if (!entry && options.storage && typeof options.storage.loadRemoteRatchet === 'function') {
      try {
        entry = await options.storage.loadRemoteRatchet(hexHash);
        if (entry) Identity._knownRatchets.set(hexHash, entry);
      } catch {
        // Fall through — no cached entry
      }
    }
    if (!entry) return null;
    if (now - entry.received > Identity.RATCHET_EXPIRY) {
      Identity._knownRatchets.delete(hexHash);
      return null;
    }
    return entry.ratchet;
  }

  /**
   * Drop expired entries from the in-memory known-ratchets map. If a
   * Storage instance is supplied it also asks the backend to clean up
   * persisted entries. Matches Python `Identity._clean_ratchets` in
   * RNS/Identity.py:333.
   *
   * @param {object} [options]
   * @param {import('./utils/storage.js').Storage} [options.storage]
   */
  static async cleanRatchets(options = {}) {
    const now = Date.now() / 1000;
    for (const [hex, entry] of Identity._knownRatchets) {
      if (now - entry.received > Identity.RATCHET_EXPIRY) {
        Identity._knownRatchets.delete(hex);
      }
    }
    if (options.storage && typeof options.storage.cleanRemoteRatchets === 'function') {
      try {
        await options.storage.cleanRemoteRatchets(Identity.RATCHET_EXPIRY);
      } catch {
        // Best-effort
      }
    }
  }

  /** Reset the in-memory known ratchets map (primarily for tests). */
  static _resetKnownRatchets() {
    Identity._knownRatchets.clear();
  }

  /**
   * Encrypt plaintext for this identity (as recipient).
   *
   * Matches Python RNS Identity.encrypt():
   *   1. Generate ephemeral X25519 keypair
   *   2. ECDH with recipient's X25519 public key (or ratchet)
   *   3. HKDF(ikm=shared_secret, salt=recipient_identity_hash, info=empty) → 64 bytes
   *   4. Split: signing_key = derived[0:32], encryption_key = derived[32:64]
   *   5. IV = random 16 bytes
   *   6. ciphertext = AES-256-CBC(PKCS7(plaintext), encryption_key, IV)
   *   7. hmac = HMAC-SHA256(signing_key, IV + ciphertext)
   *   8. Output: ephemeral_pub(32) + IV(16) + ciphertext + hmac(32)
   *
   * @param {Uint8Array} plaintext
   * @param {Uint8Array} [ratchet] - Optional 32-byte X25519 public key (ratchet)
   * @returns {Promise<Uint8Array>}
   */
  async encrypt(plaintext, ratchet) {
    // Generate ephemeral X25519 keypair
    const ephemeral = generateX25519Keypair();

    // ECDH with recipient's encryption public key, or ratchet if provided
    const targetKey = ratchet && ratchet.length === 32 ? ratchet : this.encryptionPublicKey;
    const sharedSecret = x25519SharedSecret(ephemeral.privateKey, targetKey);

    // HKDF: salt = recipient's identity hash (16 bytes), info = empty
    const derived = hkdfDerive(
      sharedSecret,
      IDENTITY_DERIVED_KEY_LENGTH,  // 64 bytes
      this.hash,                     // salt = identity hash (16 bytes)
      new Uint8Array(0)              // info = empty bytes
    );

    const signingKey = derived.slice(0, 32);
    const encryptionKey = derived.slice(32, 64);

    // Random IV
    const iv = randomBytes(16);

    // AES-256-CBC encrypt (WebCrypto handles PKCS7 padding)
    const ciphertext = await aesCbcEncrypt(plaintext, encryptionKey, iv);

    // HMAC over IV + ciphertext
    const signedParts = concat(iv, ciphertext);
    const mac = hmacSha256(signingKey, signedParts);

    // Final output: ephemeral_pub + IV + ciphertext + HMAC
    return concat(ephemeral.publicKey, iv, ciphertext, mac);
  }

  /**
   * Compute the 10-byte ratchet id from a ratchet public key.
   * Matches Python `Identity._get_ratchet_id` in RNS/Identity.py:283.
   * @param {Uint8Array} ratchetPubBytes - 32-byte X25519 public key
   * @returns {Uint8Array} 10-byte ratchet id
   */
  static getRatchetId(ratchetPubBytes) {
    return sha256Hash(ratchetPubBytes).slice(0, IDENTITY_NAME_HASH_LENGTH);
  }

  /**
   * Decrypt ciphertext intended for this identity.
   *
   * Matches Python RNS Identity.decrypt() in RNS/Identity.py:713:
   *   1. Extract ephemeral pub (32 bytes) and token (rest)
   *   2. If `ratchets` is provided, walk the list and try each private-key
   *      ratchet in turn. On the first success, capture the ratchet id on
   *      `ratchetIdReceiver.latestRatchetId` and return.
   *   3. If `enforceRatchets` is true and no ratchet worked, fail hard
   *      (don't fall back to the base key).
   *   4. Otherwise fall back to ECDH with our base X25519 private key.
   *   5. HKDF(ikm=shared_secret, salt=our_identity_hash, info=empty) → 64 bytes
   *   6. Verify HMAC, then AES-256-CBC decrypt.
   *
   * @param {Uint8Array} data - ephemeral_pub(32) + IV(16) + ciphertext + HMAC(32)
   * @param {object} [options]
   * @param {Uint8Array[]} [options.ratchets] - List of 32-byte X25519 ratchet
   *     private keys to try before falling back to the base key
   * @param {boolean} [options.enforceRatchets=false] - When true, fail instead
   *     of falling back to the base key if no ratchet succeeds
   * @param {{latestRatchetId: (Uint8Array|null)}} [options.ratchetIdReceiver]
   *     Object whose `latestRatchetId` is set to the id of the successful
   *     ratchet, or `null` if the base key was used
   * @returns {Promise<Uint8Array>} plaintext
   */
  async decrypt(data, options = {}) {
    if (!this.encryptionPrivateKey) {
      throw new Error('Cannot decrypt without private key');
    }

    const ratchets = options.ratchets || [];
    const enforceRatchets = options.enforceRatchets === true;
    const idReceiver = options.ratchetIdReceiver || null;

    // Build the list of ratchets to try. Explicit `options.ratchets` take
    // priority; fall back to the legacy instance ratchet (`_ratchetPriv`) so
    // existing callers that set a single ratchet keep working.
    const ratchetsToTry = ratchets.length > 0 ? ratchets : (this._ratchetPriv ? [this._ratchetPriv] : []);

    let lastError = null;
    for (const ratchetPriv of ratchetsToTry) {
      try {
        const plaintext = await this._decryptWith(data, ratchetPriv);
        if (idReceiver) {
          const ratchetPub = _x25519.getPublicKey(ratchetPriv);
          idReceiver.latestRatchetId = Identity.getRatchetId(ratchetPub);
        }
        return plaintext;
      } catch (err) {
        lastError = err;
      }
    }

    if (enforceRatchets) {
      if (idReceiver) idReceiver.latestRatchetId = null;
      throw new Error(
        `Ratchet-enforced decryption failed: ${lastError ? lastError.message : 'no ratchets supplied'}`
      );
    }

    // Fall back to base identity key
    if (idReceiver) idReceiver.latestRatchetId = null;
    return this._decryptWith(data, this.encryptionPrivateKey);
  }

  /**
   * Core decryption with a specific X25519 private key.
   * @param {Uint8Array} data
   * @param {Uint8Array} privateKey - X25519 private key
   * @returns {Promise<Uint8Array>}
   */
  async _decryptWith(data, privateKey) {
    if (data.length <= 32) {
      throw new Error('Ciphertext too short');
    }

    const ephemeralPub = data.slice(0, 32);
    const token = data.slice(32);

    if (token.length < 48) {
      throw new Error('Token too short');
    }

    // ECDH with the provided private key
    const sharedSecret = x25519SharedSecret(privateKey, ephemeralPub);

    // HKDF: salt = our identity hash, info = empty
    const derived = hkdfDerive(
      sharedSecret,
      IDENTITY_DERIVED_KEY_LENGTH,
      this.hash,
      new Uint8Array(0)
    );

    const signingKey = derived.slice(0, 32);
    const encryptionKey = derived.slice(32, 64);

    const iv = token.slice(0, 16);
    const ciphertext = token.slice(16, token.length - 32);
    const receivedMac = token.slice(token.length - 32);

    // Verify HMAC first
    const signedParts = concat(iv, ciphertext);
    const expectedMac = hmacSha256(signingKey, signedParts);

    if (!equal(receivedMac, expectedMac)) {
      throw new Error('HMAC verification failed — wrong key or corrupted data');
    }

    return aesCbcDecrypt(ciphertext, encryptionKey, iv);
  }
}

// Static class state — mirrors Python Identity.RATCHET_EXPIRY / known_ratchets.
/**
 * Maximum age of a remembered remote ratchet public key in seconds.
 * Matches Python `Identity.RATCHET_EXPIRY` in RNS/Identity.py:69 (30 days).
 */
Identity.RATCHET_EXPIRY = 30 * 24 * 60 * 60;

/**
 * Class-level cache mapping remote destination hash (hex) to
 * `{ ratchet: Uint8Array, received: number }`. Mirrors Python
 * `Identity.known_ratchets` in RNS/Identity.py:94.
 */
Identity._knownRatchets = new Map();

// Imported for fromPrivateKey() to derive public keys from private keys.
import { x25519 as _x25519, ed25519 as _ed25519 } from '@noble/curves/ed25519.js';
