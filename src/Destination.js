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
import {
  DEST_SINGLE, DEST_GROUP, DEST_PLAIN, DEST_LINK,
  DEST_IN, DEST_OUT,
  IDENTITY_HASH_LENGTH,
  IDENTITY_NAME_HASH_LENGTH,
} from './constants.js';

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
