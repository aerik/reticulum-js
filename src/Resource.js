/**
 * Resource — large data transfer over Links.
 *
 * Matches the Python reference implementation (RNS/Resource.py) wire format.
 *
 * Transfer protocol:
 *   1. Sender advertises resource (RESOURCE_ADV) with size, parts, hashmap
 *   2. Receiver accepts (RESOURCE_REQ)
 *   3. Sender sends parts (RESOURCE) — each is an encrypted chunk
 *   4. Receiver identifies parts via map_hash = SHA256(part_data + random_hash)[:4]
 *   5. After all parts received, receiver verifies hash and sends proof (RESOURCE_PRF)
 */

import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import { sha256Hash, truncatedHash } from './utils/crypto.js';
import { concat, toHex, randomBytes, equal } from './utils/bytes.js';
import { Packet } from './Packet.js';
import { log, LOG_DEBUG, LOG_INFO, LOG_WARNING } from './utils/log.js';
import { decompressBz2 } from './utils/decompress.js';
import {
  PACKET_DATA, PACKET_PROOF,
  HEADER_1, DEST_LINK, TRANSPORT_BROADCAST,
  CONTEXT_RESOURCE, CONTEXT_RESOURCE_ADV, CONTEXT_RESOURCE_REQ,
  CONTEXT_RESOURCE_HMU, CONTEXT_RESOURCE_PRF,
  CONTEXT_RESOURCE_ICL, CONTEXT_RESOURCE_RCL,
} from './constants.js';

const TAG = 'Resource';

// Constants
const MAPHASH_LEN = 4;
const RANDOM_HASH_SIZE = 4;
const ADV_OVERHEAD = 134;
const HASHMAP_MAX_LEN = 74;
const WINDOW_INITIAL = 4;

// Resource states
export const RESOURCE_NONE        = 0x00;
export const RESOURCE_ADVERTISING = 0x01;
export const RESOURCE_TRANSFERRING = 0x02;
export const RESOURCE_COMPLETE    = 0x03;
export const RESOURCE_FAILED      = 0x04;

// Flags
const FLAG_ENCRYPTED    = 0x01;
const FLAG_COMPRESSED   = 0x02;
const FLAG_SPLIT        = 0x04;
const FLAG_IS_REQUEST   = 0x08;
const FLAG_IS_RESPONSE  = 0x10;
const FLAG_HAS_METADATA = 0x20;

/**
 * Compute a map hash for a part.
 * @param {Uint8Array} partData
 * @param {Uint8Array} randomHash - 4-byte random hash
 * @returns {Uint8Array} 4-byte map hash
 */
function computeMapHash(partData, randomHash) {
  return sha256Hash(concat(partData, randomHash)).slice(0, MAPHASH_LEN);
}

/**
 * Outgoing Resource — send large data over a link.
 */
export class ResourceSender {
  /**
   * @param {import('./Link.js').Link} link
   * @param {Uint8Array} data - Data to send
   * @param {object} [options]
   * @param {Uint8Array} [options.requestId] - Attach to a request
   */
  constructor(link, data, options = {}) {
    this.link = link;
    this.originalData = data;
    this.requestId = options.requestId || null;
    this.status = RESOURCE_NONE;

    // Random hash for part identification
    this.randomHash = randomBytes(RANDOM_HASH_SIZE);

    // Resource hash = SHA256(data + random_hash)
    this.hash = sha256Hash(concat(data, this.randomHash));

    // Prepare transfer data: random_hash prefix + data
    // Then encrypt the entire stream via the link
    this.transferData = concat(this.randomHash, data);

    // Compute SDU (segment data unit) from link MDU
    // Link MDU depends on the link's negotiated MTU. Default ~431.
    this.sdu = 431; // TODO: derive from link MTU

    // Segment the transfer data
    this.totalParts = Math.ceil(this.transferData.length / this.sdu);
    this.parts = [];
    this.mapHashes = [];

    for (let i = 0; i < this.totalParts; i++) {
      const start = i * this.sdu;
      const end = Math.min(start + this.sdu, this.transferData.length);
      const part = this.transferData.slice(start, end);
      this.parts.push(part);
      this.mapHashes.push(computeMapHash(part, this.randomHash));
    }

    // Expected proof
    this.expectedProof = sha256Hash(concat(data, this.hash));

    this.sentParts = 0;
    this.progress = 0;
    this._onComplete = null;
    this._onProgress = null;
  }

  /**
   * Start the transfer by sending the advertisement.
   */
  async advertise() {
    this.status = RESOURCE_ADVERTISING;

    // Build hashmap bytes (first HASHMAP_MAX_LEN entries)
    const initialMapCount = Math.min(this.totalParts, HASHMAP_MAX_LEN);
    const hashmap = new Uint8Array(initialMapCount * MAPHASH_LEN);
    for (let i = 0; i < initialMapCount; i++) {
      hashmap.set(this.mapHashes[i], i * MAPHASH_LEN);
    }

    const flags = FLAG_ENCRYPTED; // always encrypted over links

    const adv = {
      t: this.transferData.length,
      d: this.originalData.length,
      n: this.totalParts,
      h: this.hash,
      r: this.randomHash,
      o: this.hash,
      i: 1,
      l: 1,
      q: this.requestId,
      f: flags,
      m: hashmap,
    };

    const packed = new Uint8Array(msgpackEncode(adv));
    await this.link.send(packed, CONTEXT_RESOURCE_ADV);

    log(LOG_INFO, TAG, `Advertised resource: ${this.totalParts} parts, ${this.originalData.length} bytes`);
  }

  /**
   * Handle a resource request from the receiver.
   * @param {Uint8Array} plaintext
   */
  async handleRequest(plaintext) {
    // Just start sending all parts
    this.status = RESOURCE_TRANSFERRING;
    await this.sendParts();
  }

  /**
   * Send all parts sequentially.
   */
  async sendParts() {
    for (let i = 0; i < this.totalParts; i++) {
      await this.link.send(this.parts[i], CONTEXT_RESOURCE);
      this.sentParts++;
      this.progress = this.sentParts / this.totalParts;
      if (this._onProgress) this._onProgress(this.progress);
    }

    log(LOG_DEBUG, TAG, `Sent all ${this.totalParts} parts`);
  }

  /**
   * Handle proof from receiver.
   * @param {Uint8Array} proofData - 64 bytes: resource_hash(32) + proof_hash(32)
   * @returns {boolean}
   */
  handleProof(proofData) {
    if (proofData.length < 64) return false;

    const receivedHash = proofData.slice(0, 32);
    const proofHash = proofData.slice(32, 64);

    if (!equal(receivedHash, this.hash)) return false;
    if (!equal(proofHash, this.expectedProof)) return false;

    this.status = RESOURCE_COMPLETE;
    this.progress = 1;
    log(LOG_INFO, TAG, `Resource transfer complete (verified by receiver)`);
    if (this._onComplete) this._onComplete();
    return true;
  }

  onProgress(fn) { this._onProgress = fn; return this; }
  onComplete(fn) { this._onComplete = fn; return this; }
}

/**
 * Incoming Resource — receive large data over a link.
 */
export class ResourceReceiver {
  /**
   * @param {import('./Link.js').Link} link
   * @param {Uint8Array} advPlaintext - Decrypted advertisement data
   */
  constructor(link, advPlaintext) {
    this.link = link;
    this.status = RESOURCE_NONE;

    // Parse advertisement
    const adv = msgpackDecode(advPlaintext);

    this.transferSize = adv.t;
    this.dataSize = adv.d;
    this.totalParts = adv.n;
    this.hash = new Uint8Array(adv.h);
    this.randomHash = new Uint8Array(adv.r);
    this.originalHash = new Uint8Array(adv.o);
    this.segmentIndex = adv.i;
    this.totalSegments = adv.l;
    this.requestId = adv.q ? new Uint8Array(adv.q) : null;
    this.flags = adv.f;

    // Parse initial hashmap
    const mapBytes = new Uint8Array(adv.m);
    this.mapHashes = [];
    for (let i = 0; i < mapBytes.length; i += MAPHASH_LEN) {
      this.mapHashes.push(mapBytes.slice(i, i + MAPHASH_LEN));
    }

    // Prepare parts array
    this.parts = new Array(this.totalParts).fill(null);
    this.receivedParts = 0;
    this.progress = 0;
    this.data = null;

    this._onComplete = null;
    this._onProgress = null;

    log(LOG_INFO, TAG, `Received advertisement: ${this.totalParts} parts, ${this.dataSize} bytes`);
  }

  /**
   * Accept the resource (send request to sender).
   */
  async accept() {
    this.status = RESOURCE_TRANSFERRING;

    // Build RESOURCE_REQ: [flag(1)] + [resource_hash(32)] + [requested_map_hashes]
    // The sender uses the map hashes to know which parts to send.
    // Request all parts from our hashmap.
    const requestedHashes = new Uint8Array(this.mapHashes.length * MAPHASH_LEN);
    for (let i = 0; i < this.mapHashes.length; i++) {
      requestedHashes.set(this.mapHashes[i], i * MAPHASH_LEN);
    }

    const reqData = concat(
      new Uint8Array([0x00]), // HASHMAP_IS_NOT_EXHAUSTED
      this.hash,              // 32-byte resource hash
      requestedHashes,        // 4 bytes per requested part
    );

    await this.link.send(reqData, CONTEXT_RESOURCE_REQ);

    log(LOG_DEBUG, TAG, `Accepted resource, requesting ${this.mapHashes.length} parts`);
  }

  /**
   * Handle an incoming resource part.
   * @param {Uint8Array} partData
   * @returns {boolean} true if all parts received
   */
  receivePart(partData) {
    // Identify the part by computing its map_hash
    const mapHash = computeMapHash(partData, this.randomHash);

    // Find which part this is
    for (let i = 0; i < this.mapHashes.length; i++) {
      if (this.parts[i] === null && equal(this.mapHashes[i], mapHash)) {
        this.parts[i] = partData;
        this.receivedParts++;
        this.progress = this.receivedParts / this.totalParts;
        if (this._onProgress) this._onProgress(this.progress);

        log(LOG_DEBUG, TAG, `Received part ${i + 1}/${this.totalParts}`);

        if (this.receivedParts === this.totalParts) {
          // _assemble is async when encrypted (needs Link.decrypt)
          const result = this._assemble();
          if (result instanceof Promise) {
            result.catch(err => log(LOG_WARNING, TAG, `Assembly failed: ${err.message}`));
          }
          return true;
        }
        return false;
      }
    }

    log(LOG_WARNING, TAG, `Received unknown part (map_hash ${toHex(mapHash)})`);
    return false;
  }

  /**
   * Assemble all parts, decrypt if needed, verify, and extract data.
   * @returns {boolean} true if assembly and verification succeed
   */
  _assemble() {
    // Concatenate all parts
    const totalLen = this.parts.reduce((sum, p) => sum + p.length, 0);
    const assembled = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of this.parts) {
      assembled.set(part, offset);
      offset += part.length;
    }

    let plainStream;

    // If encrypted (FLAG_ENCRYPTED), the assembled data is a single Link-encrypted token.
    // Decrypt using the Link's session keys, then verify.
    if ((this.flags & FLAG_ENCRYPTED) && this.link._encryptionKey) {
      return this.link.decrypt(assembled).then(
        (plainStream) => this._verifyAndComplete(plainStream),
        (err) => {
          log(LOG_WARNING, TAG, `Resource decryption failed: ${err.message}`);
          this.status = RESOURCE_FAILED;
          return false;
        }
      );
    } else {
      return this._verifyAndComplete(assembled);
    }
  }

  async _verifyAndComplete(plainStream) {
    log(LOG_DEBUG, TAG, `Verify: plainStream=${plainStream.length}b, dataSize=${this.dataSize}, flags=0x${this.flags.toString(16)}`);
    const randomHash = plainStream.slice(0, RANDOM_HASH_SIZE);
    let data = plainStream.slice(RANDOM_HASH_SIZE);

    // If compressed, decompress. Python uses bz2.
    if (this.flags & FLAG_COMPRESSED) {
      try {
        data = decompressBz2(data);
        log(LOG_DEBUG, TAG, `Decompressed: ${plainStream.length - RANDOM_HASH_SIZE}b -> ${data.length}b`);
      } catch (err) {
        log(LOG_WARNING, TAG, `bz2 decompression failed: ${err.message}`);
        this.status = RESOURCE_FAILED;
        return false;
      }
    }

    // Verify: SHA256(data + randomHash_from_advertisement) must equal resource hash
    const computed = sha256Hash(concat(data, this.randomHash));
    if (!equal(computed, this.hash)) {
      log(LOG_WARNING, TAG, 'Resource hash verification failed');
      this.status = RESOURCE_FAILED;
      return false;
    }

    this.data = data;
    this.status = RESOURCE_COMPLETE;
    this.progress = 1;

    log(LOG_INFO, TAG, `Resource assembled and verified: ${data.length} bytes`);
    if (this._onComplete) this._onComplete(data);
    return true;
  }

  /**
   * Generate proof data to send back to the sender.
   * @returns {Uint8Array} 64 bytes: resource_hash(32) + proof_hash(32)
   */
  generateProof() {
    if (this.status !== RESOURCE_COMPLETE || !this.data) {
      throw new Error('Resource not complete');
    }
    const proofHash = sha256Hash(concat(this.data, this.hash));
    return concat(this.hash, proofHash);
  }

  /**
   * Send proof to the sender.
   */
  async sendProof() {
    const proof = this.generateProof();
    await this.link.send(proof, CONTEXT_RESOURCE_PRF);
    log(LOG_DEBUG, TAG, 'Sent resource proof');
  }

  onProgress(fn) { this._onProgress = fn; return this; }
  onComplete(fn) { this._onComplete = fn; return this; }
}
