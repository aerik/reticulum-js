/**
 * Destination — a named, addressable endpoint in the RNS network.
 *
 * Matches the Python reference implementation (RNS/Destination.py).
 *
 * Hash computation:
 *   name_hash = SHA-256("appname.aspect1.aspect2")[:10]   (without identity hash)
 *   dest_hash = SHA-256(name_hash + identity_hash)[:16]    (for SINGLE destinations)
 *   dest_hash = SHA-256(name_hash)[:16]                    (for PLAIN destinations)
 */

import { truncatedHash, sha256Hash } from './utils/crypto.js';
import { concat, fromUtf8, toHex } from './utils/bytes.js';
import { Identity } from './Identity.js';
import { log, LOG_DEBUG, LOG_WARNING, LOG_ERROR } from './utils/log.js';
import {
  DEST_SINGLE, DEST_GROUP, DEST_PLAIN, DEST_LINK,
  DEST_IN, DEST_OUT,
  IDENTITY_HASH_LENGTH,
  IDENTITY_NAME_HASH_LENGTH,
} from './constants.js';

const TAG = 'Destination';

/**
 * Default interval between ratchet rotations, in seconds.
 * Matches Python `Destination.RATCHET_INTERVAL` in RNS/Destination.py:90.
 */
export const RATCHET_INTERVAL = 30 * 60;

/**
 * Default number of retained historical ratchets for incoming decryption.
 * Matches Python `Destination.RATCHET_COUNT` in RNS/Destination.py:85.
 */
export const RATCHET_COUNT = 512;

export class Destination {
  /**
   * @param {import('./Identity.js').Identity|null} identity
   * @param {number} direction - DEST_IN or DEST_OUT
   * @param {number} type - DEST_SINGLE, DEST_GROUP, DEST_PLAIN, DEST_LINK
   * @param {string} appName - App name (no dots)
   * @param {...string} aspects - Additional name aspects (no dots in each)
   */
  constructor(identity, direction, type, appName, ...aspects) {
    this.identity = identity;
    this.direction = direction;
    this.type = type;
    this.appName = appName;
    this.aspects = aspects;

    // Full name without identity = "appName.aspect1.aspect2"
    this.name = [appName, ...aspects].join('.');

    // Full name with identity (for display) = "appName.aspect1.aspect2.hexhash"
    if (identity) {
      this.fullName = this.name + '.' + identity.hexHash;
    } else {
      this.fullName = this.name;
    }

    // Name hash = SHA-256(name_without_identity)[:10]
    this.nameHash = truncatedHash(fromUtf8(this.name), IDENTITY_NAME_HASH_LENGTH);

    // Compute destination hash
    if (type === DEST_SINGLE && identity) {
      // SINGLE: hash(name_hash + identity_hash)
      const hashMaterial = concat(this.nameHash, identity.hash);
      this.hash = truncatedHash(hashMaterial, IDENTITY_HASH_LENGTH);
    } else if (type === DEST_PLAIN) {
      // PLAIN: hash(name_hash)
      this.hash = truncatedHash(this.nameHash, IDENTITY_HASH_LENGTH);
    } else if (type === DEST_GROUP) {
      // GROUP: same as PLAIN for now
      this.hash = truncatedHash(this.nameHash, IDENTITY_HASH_LENGTH);
    } else {
      this.hash = null;
    }

    this.hexHash = this.hash ? toHex(this.hash) : null;

    // Callbacks
    this._callbacks = {
      packet: null,
      link: null,
      proof: null,
    };

    // Ratchet state — mirrors Python Destination fields in RNS/Destination.py:161-168
    this.ratchets = null;                // List of 32-byte X25519 private keys (newest first), or null = disabled
    this._ratchetsStorageKey = null;     // Storage key used by _persistRatchets / _reloadRatchets
    this._ratchetsStorage = null;        // Reference to the Storage instance used by persistence
    this._ratchetInterval = RATCHET_INTERVAL;
    this._retainedRatchets = RATCHET_COUNT;
    this._latestRatchetTime = 0;
    this._enforceRatchets = false;
  }

  // --- Ratchet management ---
  //
  // Destination-owned ratchets mirror the Python model in RNS/Destination.py:205-540.
  // Each destination maintains a list of private X25519 ratchet keys. The newest
  // (index 0) is included in outgoing announces so peers can encrypt to it; old
  // entries are retained up to `retainedRatchets` to decrypt messages that were
  // sent before the latest rotation propagated.

  /**
   * Enable ratchets on this destination. Loads any previously persisted list
   * from storage, or initializes an empty one if none exists.
   * Matches Python `Destination.enable_ratchets` in RNS/Destination.py:477.
   *
   * @param {string} storageKey - Unique key under the Storage namespace
   *   (typically `storage/ratchets/<hexhash>`)
   * @param {import('./utils/storage.js').Storage} storage - Storage instance
   * @returns {Promise<boolean>}
   */
  async enableRatchets(storageKey, storage) {
    if (!this.identity || !this.identity.hasPrivateKey()) {
      throw new Error('Cannot enable ratchets without a private identity');
    }
    if (!storageKey) throw new Error('enableRatchets requires a storage key');
    if (!storage) throw new Error('enableRatchets requires a Storage instance');

    this._ratchetsStorageKey = storageKey;
    this._ratchetsStorage = storage;
    this._latestRatchetTime = 0;
    await this._reloadRatchets();
    log(LOG_DEBUG, TAG, `Ratchets enabled on ${this.fullName}`);
    return true;
  }

  /**
   * Load the persisted ratchet list. If no file exists, start with an empty
   * list and persist it. Matches Python `_reload_ratchets` in
   * RNS/Destination.py:437.
   */
  async _reloadRatchets() {
    if (!this._ratchetsStorage || !this._ratchetsStorageKey) return;
    let loaded = null;
    try {
      loaded = await this._ratchetsStorage.loadDestinationRatchets(
        this._ratchetsStorageKey, this.identity
      );
    } catch (err) {
      log(LOG_ERROR, TAG,
        `Ratchet file at ${this._ratchetsStorageKey} could not be loaded: ${err.message}`);
      this.ratchets = null;
      this._ratchetsStorageKey = null;
      throw err;
    }
    if (loaded) {
      this.ratchets = loaded;
    } else {
      log(LOG_DEBUG, TAG, `No existing ratchet data found, initializing new file for ${this.fullName}`);
      this.ratchets = [];
      await this._persistRatchets();
    }
  }

  /**
   * Persist the current ratchet list, signed with the identity's private key
   * so it can be verified on reload. Matches Python `_persist_ratchets` in
   * RNS/Destination.py:210.
   */
  async _persistRatchets() {
    if (!this._ratchetsStorage || !this._ratchetsStorageKey) return;
    if (!this.identity || !this.identity.hasPrivateKey()) return;
    try {
      await this._ratchetsStorage.saveDestinationRatchets(
        this._ratchetsStorageKey, this.ratchets, this.identity
      );
    } catch (err) {
      log(LOG_ERROR, TAG, `Could not write ratchet file for ${this.fullName}: ${err.message}`);
      throw err;
    }
  }

  _cleanRatchets() {
    if (this.ratchets && this.ratchets.length > this._retainedRatchets) {
      this.ratchets = this.ratchets.slice(0, this._retainedRatchets);
    }
  }

  /**
   * Rotate the active ratchet if `ratchetInterval` seconds have elapsed since
   * the last rotation. Returns the current ratchet public key (either the
   * freshly generated one or the still-valid previous one). Matches Python
   * `rotate_ratchets` in RNS/Destination.py:227.
   *
   * @returns {Promise<Uint8Array|null>} Current ratchet public key, or null
   *   if ratchets are not enabled.
   */
  async rotateRatchets() {
    if (this.ratchets === null) return null;
    const now = Date.now() / 1000;
    if (now > this._latestRatchetTime + this._ratchetInterval) {
      log(LOG_DEBUG, TAG, `Rotating ratchets for ${this.fullName}`);
      const newRatchet = Identity.generateRatchet();
      this.ratchets.unshift(newRatchet);
      this._latestRatchetTime = now;
      this._cleanRatchets();
      await this._persistRatchets();
    }
    return this.ratchets.length > 0
      ? Identity.ratchetPublicBytes(this.ratchets[0])
      : null;
  }

  /**
   * Return the current (latest) ratchet public key without rotating.
   * Convenience helper used by announce-building code and tests.
   * @returns {Uint8Array|null}
   */
  currentRatchetPub() {
    if (!this.ratchets || this.ratchets.length === 0) return null;
    return Identity.ratchetPublicBytes(this.ratchets[0]);
  }

  /**
   * Reject packets encrypted with the base identity key; only accept
   * ratchet-encrypted traffic. Matches Python `enforce_ratchets` in
   * RNS/Destination.py:502.
   */
  enforceRatchets() {
    if (this.ratchets === null) return false;
    this._enforceRatchets = true;
    log(LOG_DEBUG, TAG, `Ratchets enforced on ${this.fullName}`);
    return true;
  }

  /**
   * Set the number of historical ratchets retained for incoming decryption.
   * Matches Python `set_retained_ratchets` in RNS/Destination.py:515.
   * @param {number} n
   */
  setRetainedRatchets(n) {
    if (!Number.isInteger(n) || n <= 0) return false;
    this._retainedRatchets = n;
    this._cleanRatchets();
    return true;
  }

  /**
   * Set the minimum interval between ratchet rotations (seconds).
   * Matches Python `set_ratchet_interval` in RNS/Destination.py:530.
   * @param {number} seconds
   */
  setRatchetInterval(seconds) {
    if (!Number.isInteger(seconds) || seconds <= 0) return false;
    this._ratchetInterval = seconds;
    return true;
  }

  /**
   * Compute a destination hash from components (static, for validation).
   * @param {Uint8Array} nameHash - 10-byte name hash
   * @param {Uint8Array} identityHash - 16-byte identity hash
   * @returns {Uint8Array} 16-byte destination hash
   */
  static computeHash(nameHash, identityHash) {
    return truncatedHash(concat(nameHash, identityHash), IDENTITY_HASH_LENGTH);
  }

  /**
   * Register a callback for incoming packets.
   * @param {function(Uint8Array, import('./Packet.js').Packet): void} callback
   */
  setPacketCallback(callback) {
    this._callbacks.packet = callback;
  }

  /**
   * Register a callback for incoming link requests.
   * @param {function(import('./Link.js').Link): boolean} callback - return true to accept
   */
  setLinkCallback(callback) {
    this._callbacks.link = callback;
  }

  /**
   * Register a callback for incoming proofs.
   * @param {function(import('./Packet.js').Packet): void} callback
   */
  setProofCallback(callback) {
    this._callbacks.proof = callback;
  }
}
