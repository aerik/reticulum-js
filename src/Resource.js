/**
 * Resource — large data transfer over Links.
 *
 * Matches the Python reference implementation (RNS/Resource.py) wire format.
 *
 * Transfer protocol:
 *   1. Sender advertises resource (RESOURCE_ADV) with size, parts, initial hashmap
 *   2. Receiver accepts (RESOURCE_REQ) requesting a window of parts
 *   3. Sender sends requested parts (RESOURCE)
 *   4. Receiver identifies parts via map_hash = SHA256(part_data + random_hash)[:4]
 *   5. When all requested parts arrive, receiver grows window and requests more
 *   6. If hashmap is exhausted, receiver sets HASHMAP_IS_EXHAUSTED flag
 *   7. Sender responds with a hashmap update (RESOURCE_HMU) for the next segment
 *   8. After all parts received, receiver verifies hash and sends proof (RESOURCE_PRF)
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
  MTU,
} from './constants.js';

const TAG = 'Resource';

// Constants (matching Python RNS/Resource.py)
const MAPHASH_LEN = 4;
const RANDOM_HASH_SIZE = 4;
const ADV_OVERHEAD = 134;
const HASHMAP_MAX_LEN = 74;

// SDU derivation: link.mtu - HEADER_MAXSIZE - IFAC_MIN_SIZE
// HEADER_MAXSIZE = 2 + 1 + 16*2 = 35, IFAC_MIN_SIZE = 1 → overhead = 36
const SDU_OVERHEAD = 36;
const DEFAULT_SDU = MTU - SDU_OVERHEAD;  // 464 with MTU=500

// Window constants (matching Python Resource.py)
const WINDOW_INITIAL     = 4;
const WINDOW_MIN_INITIAL = 2;
const WINDOW_MAX_SLOW    = 10;
const WINDOW_MAX_FAST    = 75;
const WINDOW_FLEXIBILITY = 4;

// Hashmap exhaustion flags
const HASHMAP_IS_NOT_EXHAUSTED = 0x00;
const HASHMAP_IS_EXHAUSTED     = 0xFF;

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
 * Matches Python Resource.py sender side.
 */
export class ResourceSender {
  /**
   * @param {import('./Link.js').Link} link
   * @param {Uint8Array} data - Data to send
   * @param {object} [options]
   * @param {Uint8Array} [options.requestId] - Attach to a request
   * @param {boolean} [options.encrypted=true] - Encrypt the stream over the link
   */
  constructor(link, data, options = {}) {
    this.link = link;
    this.originalData = data;
    this.requestId = options.requestId || null;
    this.encryptedFlag = options.encrypted !== false;
    this.status = RESOURCE_NONE;

    // Random hash used for the outer resource hash + map_hash computation.
    // Matches Python `self.random_hash` (separate from the inner data prefix).
    this.randomHash = randomBytes(RANDOM_HASH_SIZE);

    // Resource hash = SHA256(original_data + random_hash). Computed on the
    // PLAINTEXT original data (matches Python's `full_hash(data+random_hash)`).
    this.hash = sha256Hash(concat(data, this.randomHash));

    // Expected proof = SHA256(original_data + resource_hash). Also plaintext.
    this.expectedProof = sha256Hash(concat(data, this.hash));

    // Inner random-hash prefix that goes inside the encrypted stream. The
    // receiver strips this after decryption (Python uses a different random
    // value for the prefix vs the outer hash; we match by generating a fresh
    // one here).
    const innerPrefix = randomBytes(RANDOM_HASH_SIZE);
    this.transferData = concat(innerPrefix, data);

    // Derive SDU from link MTU (matching Python: link.mtu - 36)
    this.sdu = (link.mtu || MTU) - SDU_OVERHEAD;

    // Parts and hashmap are populated lazily in advertise() because we need
    // an async link.encrypt() call when encryption is enabled.
    this.totalParts = 0;
    this.parts = [];
    this.mapHashes = [];
    this.hashmapRaw = new Uint8Array(0);
    this.streamData = null; // either plaintext or encrypted stream
    this._prepared = false;

    this.sentParts = 0;
    this.progress = 0;
    this._onComplete = null;
    this._onProgress = null;
  }

  /**
   * Prepare the stream (encrypt if needed) and chunk it into parts.
   * Computes map hashes on the on-the-wire bytes (encrypted if applicable).
   *
   * Matches Python Resource.__init__ post-encryption flow.
   */
  async _prepareParts() {
    if (this._prepared) return;

    // Encrypt the entire stream once (matches Python's
    // `self.data = self.link.encrypt(self.data)`).
    if (this.encryptedFlag) {
      this.streamData = await this.link.encrypt(this.transferData);
    } else {
      this.streamData = this.transferData;
    }

    this.totalParts = Math.ceil(this.streamData.length / this.sdu);
    this.parts = [];
    this.mapHashes = [];
    this.hashmapRaw = new Uint8Array(this.totalParts * MAPHASH_LEN);

    for (let i = 0; i < this.totalParts; i++) {
      const start = i * this.sdu;
      const end = Math.min(start + this.sdu, this.streamData.length);
      const part = this.streamData.slice(start, end);
      this.parts.push(part);
      const mapHash = computeMapHash(part, this.randomHash);
      this.mapHashes.push(mapHash);
      this.hashmapRaw.set(mapHash, i * MAPHASH_LEN);
    }

    this._prepared = true;
  }

  /**
   * Start the transfer by sending the advertisement.
   */
  async advertise() {
    await this._prepareParts();
    this.status = RESOURCE_ADVERTISING;

    // Build initial hashmap (first HASHMAP_MAX_LEN entries, segment 0)
    const initialMapCount = Math.min(this.totalParts, HASHMAP_MAX_LEN);
    const hashmap = this.hashmapRaw.slice(0, initialMapCount * MAPHASH_LEN);

    const flags = this.encryptedFlag ? FLAG_ENCRYPTED : 0;

    const adv = {
      t: this.streamData.length,         // on-wire transfer size (post-encryption)
      d: this.originalData.length,        // logical (plaintext) data size
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

    log(LOG_INFO, TAG,
      `Advertised resource: ${this.totalParts} parts, ` +
      `${this.originalData.length}b plaintext / ${this.streamData.length}b on-wire`);
  }

  /**
   * Handle a resource request from the receiver.
   * Matching Python Resource.request() — sends requested parts and HMU if needed.
   * @param {Uint8Array} plaintext
   */
  async handleRequest(plaintext) {
    this.status = RESOURCE_TRANSFERRING;

    // Parse the request
    // Format: flag(1) [+ last_map_hash(4) if exhausted] + resource_hash(32) + requested_hashes(4*N)
    let offset = 0;
    const exhaustedFlag = plaintext[offset];
    offset += 1;

    let lastMapHash = null;
    if (exhaustedFlag === HASHMAP_IS_EXHAUSTED) {
      lastMapHash = plaintext.slice(offset, offset + MAPHASH_LEN);
      offset += MAPHASH_LEN;
    }

    const resourceHash = plaintext.slice(offset, offset + 32);
    offset += 32;

    if (!equal(resourceHash, this.hash)) {
      log(LOG_WARNING, TAG, 'Request hash mismatch');
      return;
    }

    // Extract requested part hashes
    const requestedHashes = [];
    while (offset + MAPHASH_LEN <= plaintext.length) {
      requestedHashes.push(plaintext.slice(offset, offset + MAPHASH_LEN));
      offset += MAPHASH_LEN;
    }

    // Send requested parts. RESOURCE-context packets are NOT encrypted at the
    // link layer (matches Python Packet.pack: "A resource takes care of
    // encryption by itself"). Use sendRaw to skip the link.encrypt step.
    for (const reqHash of requestedHashes) {
      // Find which part this hash corresponds to
      for (let i = 0; i < this.mapHashes.length; i++) {
        if (equal(this.mapHashes[i], reqHash)) {
          this.link.sendRaw(this.parts[i], CONTEXT_RESOURCE);
          this.sentParts++;
          this.progress = this.sentParts / this.totalParts;
          if (this._onProgress) this._onProgress(this.progress);
          break;
        }
      }
    }

    // If receiver needs more hashmap, send HMU
    if (lastMapHash) {
      this._sendHashmapUpdate(lastMapHash);
    }

    log(LOG_DEBUG, TAG, `Sent ${requestedHashes.length} requested parts (${this.sentParts}/${this.totalParts})`);
  }

  /**
   * Send a hashmap update for the next segment.
   * Matching Python Resource.py lines 1033-1044.
   * @param {Uint8Array} lastMapHash - Last hash the receiver has
   */
  async _sendHashmapUpdate(lastMapHash) {
    // Find which part the last map hash belongs to
    let partIndex = -1;
    for (let i = 0; i < this.mapHashes.length; i++) {
      if (equal(this.mapHashes[i], lastMapHash)) {
        partIndex = i;
        break;
      }
    }

    if (partIndex < 0) {
      log(LOG_WARNING, TAG, 'Could not find last map hash for HMU');
      return;
    }

    // Calculate next segment
    const segment = Math.floor((partIndex + 1) / HASHMAP_MAX_LEN);
    const hashmapStart = segment * HASHMAP_MAX_LEN;
    const hashmapEnd = Math.min(hashmapStart + HASHMAP_MAX_LEN, this.totalParts);

    if (hashmapStart >= this.totalParts) {
      log(LOG_DEBUG, TAG, 'No more hashmap segments to send');
      return;
    }

    // Build hashmap bytes for this segment
    const hashmap = this.hashmapRaw.slice(
      hashmapStart * MAPHASH_LEN,
      hashmapEnd * MAPHASH_LEN
    );

    // HMU format: resource_hash(32) + msgpack([segment, hashmap])
    const hmuPayload = new Uint8Array(msgpackEncode([segment, hashmap]));
    const hmu = concat(this.hash, hmuPayload);

    await this.link.send(hmu, CONTEXT_RESOURCE_HMU);

    log(LOG_DEBUG, TAG, `Sent HMU segment ${segment} (parts ${hashmapStart}-${hashmapEnd - 1})`);
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
 * Matches Python Resource.py receiver side with windowed requesting and HMU support.
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

    // Hashmap: array of nullable 4-byte entries (matching Python self.hashmap list)
    this.hashmap = new Array(this.totalParts).fill(null);
    this.hashmapHeight = 0;

    // Parse initial hashmap from advertisement (segment 0)
    const mapBytes = new Uint8Array(adv.m);
    this._applyHashmapUpdate(0, mapBytes);

    // Prepare parts array
    this.parts = new Array(this.totalParts).fill(null);
    this.receivedParts = 0;
    this.consecutiveCompleted = 0;
    this.outstandingParts = 0;
    this.progress = 0;
    this.data = null;

    // Window (matching Python Resource.py)
    this.window = WINDOW_INITIAL;
    this.windowMin = WINDOW_MIN_INITIAL;
    this.windowMax = WINDOW_MAX_SLOW;
    this.waitingForHmu = false;

    this._onComplete = null;
    this._onProgress = null;

    log(LOG_INFO, TAG, `Received advertisement: ${this.totalParts} parts, ${this.dataSize} bytes`);
  }

  /**
   * Apply a hashmap update (segment 0 from adv, or later segments from HMU).
   * Matching Python Resource.hashmap_update().
   * @param {number} segment
   * @param {Uint8Array} hashmapBytes
   */
  _applyHashmapUpdate(segment, hashmapBytes) {
    const segLen = HASHMAP_MAX_LEN;
    const hashes = Math.floor(hashmapBytes.length / MAPHASH_LEN);

    for (let i = 0; i < hashes; i++) {
      const idx = i + segment * segLen;
      if (idx < this.totalParts) {
        if (this.hashmap[idx] === null) {
          this.hashmapHeight++;
        }
        this.hashmap[idx] = hashmapBytes.slice(i * MAPHASH_LEN, (i + 1) * MAPHASH_LEN);
      }
    }
  }

  /**
   * Handle an incoming hashmap update packet.
   * Matching Python Resource.hashmap_update_packet().
   * @param {Uint8Array} plaintext - Decrypted HMU data
   */
  handleHashmapUpdate(plaintext) {
    if (this.status === RESOURCE_FAILED) return;

    // Format: resource_hash(32) + msgpack([segment, hashmap_bytes])
    const update = msgpackDecode(plaintext.slice(32));
    const segment = update[0];
    const hashmapBytes = new Uint8Array(update[1]);

    this._applyHashmapUpdate(segment, hashmapBytes);

    log(LOG_DEBUG, TAG, `Applied HMU segment ${segment} (hashmap height: ${this.hashmapHeight}/${this.totalParts})`);

    this.waitingForHmu = false;
    this._requestNext();
  }

  /**
   * Accept the resource and start requesting parts.
   */
  async accept() {
    this.status = RESOURCE_TRANSFERRING;
    this._requestNext();
  }

  /**
   * Request the next window of parts.
   * Matching Python Resource.request_next().
   */
  async _requestNext() {
    if (this.status === RESOURCE_FAILED) return;
    if (this.waitingForHmu) return;

    // Find consecutive completed height
    this._updateConsecutiveCompleted();

    const searchStart = this.consecutiveCompleted;
    const searchSize = Math.min(this.window, this.totalParts - searchStart);
    const requestedHashes = [];
    let hashmapExhausted = HASHMAP_IS_NOT_EXHAUSTED;

    for (let pn = searchStart; pn < searchStart + searchSize; pn++) {
      if (this.parts[pn] === null) {
        const partHash = this.hashmap[pn];
        if (partHash !== null) {
          requestedHashes.push(partHash);
        } else {
          // Hashmap exhausted — need more from sender
          hashmapExhausted = HASHMAP_IS_EXHAUSTED;
          break;
        }
      }
    }

    if (requestedHashes.length === 0 && hashmapExhausted === HASHMAP_IS_NOT_EXHAUSTED) {
      // Nothing to request — might be done
      return;
    }

    this.outstandingParts = requestedHashes.length;

    // Build RESOURCE_REQ
    // Format: flag(1) [+ last_map_hash(4)] + resource_hash(32) + requested_hashes(4*N)
    let hmuPart;
    if (hashmapExhausted === HASHMAP_IS_EXHAUSTED) {
      const lastMapHash = this.hashmap[this.hashmapHeight - 1];
      hmuPart = concat(new Uint8Array([HASHMAP_IS_EXHAUSTED]), lastMapHash);
      this.waitingForHmu = true;
    } else {
      hmuPart = new Uint8Array([HASHMAP_IS_NOT_EXHAUSTED]);
    }

    const hashBytes = new Uint8Array(requestedHashes.length * MAPHASH_LEN);
    for (let i = 0; i < requestedHashes.length; i++) {
      hashBytes.set(requestedHashes[i], i * MAPHASH_LEN);
    }

    const reqData = concat(hmuPart, this.hash, hashBytes);
    await this.link.send(reqData, CONTEXT_RESOURCE_REQ);

    log(LOG_DEBUG, TAG, `Requested ${requestedHashes.length} parts (window=${this.window}${hashmapExhausted ? ', hashmap exhausted' : ''})`);
  }

  /**
   * Update consecutive completed counter.
   */
  _updateConsecutiveCompleted() {
    while (this.consecutiveCompleted < this.totalParts &&
           this.parts[this.consecutiveCompleted] !== null) {
      this.consecutiveCompleted++;
    }
  }

  /**
   * Handle an incoming resource part.
   * Matching Python Resource.receive_part().
   * @param {Uint8Array} partData
   * @returns {boolean} true if all parts received
   */
  receivePart(partData) {
    // Identify the part by computing its map_hash
    const mapHash = computeMapHash(partData, this.randomHash);

    // Find which part this is
    for (let i = 0; i < this.hashmap.length; i++) {
      if (this.parts[i] === null && this.hashmap[i] !== null && equal(this.hashmap[i], mapHash)) {
        this.parts[i] = partData;
        this.receivedParts++;
        this.outstandingParts = Math.max(0, this.outstandingParts - 1);
        this.progress = this.receivedParts / this.totalParts;
        if (this._onProgress) this._onProgress(this.progress);

        log(LOG_DEBUG, TAG, `Received part ${i + 1}/${this.totalParts}`);

        if (this.receivedParts === this.totalParts) {
          // All parts received — assemble
          const result = this._assemble();
          if (result instanceof Promise) {
            result.catch(err => log(LOG_WARNING, TAG, `Assembly failed: ${err.message}`));
          }
          return true;
        }

        // If all outstanding parts arrived, grow window and request more
        // (matching Python Resource.receive_part() window growth)
        if (this.outstandingParts === 0) {
          if (this.window < this.windowMax) {
            this.window++;
            if ((this.window - this.windowMin) > (WINDOW_FLEXIBILITY - 1)) {
              this.windowMin++;
            }
          }
          this._requestNext();
        }

        return false;
      }
    }

    log(LOG_WARNING, TAG, `Received unknown part (map_hash ${toHex(mapHash)})`);
    return false;
  }

  /**
   * Assemble all parts, decrypt if needed, verify, and extract data.
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

    // If encrypted, decrypt the assembled stream
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

    // If compressed, decompress (Python uses bz2)
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

    // Verify: SHA256(data + randomHash_from_adv) must equal resource hash
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
   * Resource proofs are sent as PROOF packets without per-packet encryption
   * (Python Packet.pack: "Resource proofs are not encrypted").
   */
  async sendProof() {
    const proof = this.generateProof();
    this.link.sendRaw(proof, CONTEXT_RESOURCE_PRF, PACKET_PROOF);
    log(LOG_DEBUG, TAG, 'Sent resource proof');
  }

  onProgress(fn) { this._onProgress = fn; return this; }
  onComplete(fn) { this._onComplete = fn; return this; }
}
