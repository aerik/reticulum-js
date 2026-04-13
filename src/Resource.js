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
import { compressBz2 } from './utils/compress.js';
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

// Resource states — numbering matches Python RNS/Resource.py:143-151
// except REJECTED, which Python places at 0x00 (colliding with NONE). We use
// a distinct terminal value so the `status >= RESOURCE_COMPLETE` early-out
// pattern used in cancel()/_rejected() works for all terminal states.
export const RESOURCE_NONE           = 0x00;
export const RESOURCE_QUEUED         = 0x01;
export const RESOURCE_ADVERTISED     = 0x02;
export const RESOURCE_TRANSFERRING   = 0x03;
export const RESOURCE_AWAITING_PROOF = 0x04;
export const RESOURCE_ASSEMBLING     = 0x05;
export const RESOURCE_COMPLETE       = 0x06;
export const RESOURCE_FAILED         = 0x07;
export const RESOURCE_CORRUPT        = 0x08;
export const RESOURCE_REJECTED       = 0x09;

// Watchdog / retry constants — match Python RNS/Resource.py:126-134.
const PART_TIMEOUT_FACTOR  = 4;
const PROOF_TIMEOUT_FACTOR = 3;
const MAX_RETRIES          = 16;
const MAX_ADV_RETRIES      = 4;
const MAX_PROOF_RETRIES    = 3;   // Python line 1056
const SENDER_GRACE_TIME    = 10.0;
const PROCESSING_GRACE     = 1.0;
const RETRY_GRACE_TIME     = 0.25;
const PER_RETRY_DELAY      = 0.5;
const WATCHDOG_INTERVAL_MS = 1000; // Python's WATCHDOG_MAX_SLEEP = 1.0s

// Default per-link traffic-timeout factor used by the sender's ADVERTISED
// watchdog when the link hasn't reported an RTT yet. Matches
// Link.TRAFFIC_TIMEOUT_FACTOR in Python RNS/Link.py:82.
const TRAFFIC_TIMEOUT_FACTOR = 6;

/**
 * Maximum uncompressed data size to attempt auto-compression on.
 * Matches Python RNS/Resource.py:124 AUTO_COMPRESS_MAX_SIZE = 64 MiB.
 * Larger payloads skip compression to avoid excessive CPU.
 */
export const AUTO_COMPRESS_MAX_SIZE = 64 * 1024 * 1024;

/**
 * Maximum bytes in a single Resource segment. Payloads larger than this
 * are split into multiple segments, each sent as its own Resource cycle
 * but sharing the same originalHash so the receiver can reassemble.
 * Matches Python RNS/Resource.py constant (1 MiB - 1 = 1,048,575).
 */
export const MAX_EFFICIENT_SIZE = 1024 * 1024 - 1;

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
    this.fullData = data;  // The complete payload across all segments
    this.totalSize = data.length;
    this.requestId = options.requestId || null;
    this.encryptedFlag = options.encrypted !== false;
    this.status = RESOURCE_NONE;

    // Auto-compression config — matches Python `auto_compress` param on
    // RNS.Resource (RNS/Resource.py:246,362-371). Default is to try
    // compression on payloads up to AUTO_COMPRESS_MAX_SIZE. A custom
    // limit can be passed as either a boolean or an integer.
    this.autoCompressOption = options.autoCompress !== undefined ? options.autoCompress : true;
    let autoCompressLimit = AUTO_COMPRESS_MAX_SIZE;
    let autoCompressEnabled = true;
    if (typeof this.autoCompressOption === 'boolean') {
      autoCompressEnabled = this.autoCompressOption;
    } else if (typeof this.autoCompressOption === 'number') {
      autoCompressEnabled = true;
      autoCompressLimit = this.autoCompressOption;
    } else {
      throw new TypeError('Invalid type for autoCompress option');
    }
    this.autoCompressLimit = autoCompressLimit;
    this.autoCompress = autoCompressEnabled;

    // --- Segmentation decision ---
    // Payloads larger than MAX_EFFICIENT_SIZE are split into multiple
    // segments, each sent as its own Resource cycle with the same
    // originalHash. Matches Python RNS/Resource.py:272-312.
    if (data.length > MAX_EFFICIENT_SIZE) {
      this.totalSegments = Math.ceil(data.length / MAX_EFFICIENT_SIZE);
      this.split = true;
    } else {
      this.totalSegments = 1;
      this.split = false;
    }
    this.segmentIndex = 0;   // set in _loadSegment
    this.originalHash = null; // set after segment 1 hash is computed

    // Derive SDU from link MTU (matching Python: link.mtu - 36)
    this.sdu = (link.mtu || MTU) - SDU_OVERHEAD;

    // Callbacks
    this.sentParts = 0;
    this.lastPartSent = 0;
    this.progress = 0;
    this._onComplete = null;
    this._onProgress = null;
    this._onFailed = null;
    // Called from _loadSegment when advancing to a new segment so the Link
    // layer can re-key its outgoing resources map (the per-segment hash
    // changes but originalHash stays stable).
    this._onSegmentAdvance = null;

    // Watchdog / retry tracking — mirrors Python RNS/Resource.py:339-347
    this._watchdogTimer = null;

    // Load segment 1 — computes hash, compresses if beneficial, builds
    // transferData. Subsequent segments are loaded by advancing via
    // _loadSegment(segmentIndex+1) after the current segment's proof arrives.
    this._loadSegment(1);
  }

  /**
   * Reset per-segment state and prepare the given segment for transfer.
   * Matches Python's pattern of building `self.data` for one segment at a
   * time — segment 1 computes `originalHash`; later segments reuse it.
   * @param {number} segmentIndex - 1-based segment number
   */
  _loadSegment(segmentIndex) {
    if (segmentIndex < 1 || segmentIndex > this.totalSegments) {
      throw new Error(`Segment index ${segmentIndex} out of range`);
    }

    const previousHash = this.hash;
    this.segmentIndex = segmentIndex;

    // Slice this segment's bytes out of the full payload
    const start = (segmentIndex - 1) * MAX_EFFICIENT_SIZE;
    const end = Math.min(start + MAX_EFFICIENT_SIZE, this.fullData.length);
    const segmentData = this.fullData.slice(start, end);
    this.originalData = segmentData;

    // Random hash used for the outer resource hash + map_hash computation.
    // A fresh randomHash is generated for each segment.
    this.randomHash = randomBytes(RANDOM_HASH_SIZE);

    // Resource hash = SHA256(segment_data + random_hash). Segment 1's
    // hash becomes the stable originalHash used to identify the whole
    // multi-segment transfer. Matches Python RNS/Resource.py:438.
    this.hash = sha256Hash(concat(segmentData, this.randomHash));
    this.expectedProof = sha256Hash(concat(segmentData, this.hash));

    if (segmentIndex === 1) {
      this.originalHash = this.hash;
    } else if (previousHash && this._onSegmentAdvance) {
      // Notify Link to re-key its outgoing resources map with the new
      // per-segment hash so RESOURCE_REQ / RESOURCE_PRF lookups continue
      // to find this sender.
      try { this._onSegmentAdvance(previousHash, this.hash); } catch {}
    }

    // Compression decision on this segment's data (Python compresses each
    // segment independently — see RNS/Resource.py:387).
    this.uncompressedSize = segmentData.length;
    this.compressed = false;
    let payloadBytes = segmentData;
    if (this.autoCompress && segmentData.length <= this.autoCompressLimit) {
      const compressed = compressBz2(segmentData);
      if (compressed && compressed.length < segmentData.length) {
        payloadBytes = compressed;
        this.compressed = true;
      }
    }
    this.compressedSize = payloadBytes.length;

    // Inner random-hash prefix that goes inside the encrypted stream. The
    // receiver strips this after decryption.
    const innerPrefix = randomBytes(RANDOM_HASH_SIZE);
    this.transferData = concat(innerPrefix, payloadBytes);

    // Reset per-segment transfer state
    this.totalParts = 0;
    this.parts = [];
    this.mapHashes = [];
    this.hashmapRaw = new Uint8Array(0);
    this.streamData = null;
    this._prepared = false;
    this.sentParts = 0;
    this.lastPartSent = 0;
    this.status = RESOURCE_NONE;

    // Reset watchdog state for the new segment
    this.retriesLeft = MAX_ADV_RETRIES;
    this.advSent = 0;
    this.lastActivity = 0;
    this.rtt = null;
    this.timeoutFactor = TRAFFIC_TIMEOUT_FACTOR;
    this.timeout = 0;
  }

  /**
   * Start (or restart) the watchdog timer. Called from advertise() once the
   * sender has announced itself to the receiver. Matches Python's
   * `self.watchdog_job()` in `RNS/Resource.py:557`.
   */
  _startWatchdog() {
    if (this._watchdogTimer) return;
    this._watchdogTimer = setInterval(() => this._watchdogTick(), WATCHDOG_INTERVAL_MS);
    // Unref so a stray timer doesn't keep Node alive in test processes.
    if (this._watchdogTimer && typeof this._watchdogTimer.unref === 'function') {
      this._watchdogTimer.unref();
    }
  }

  _stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  /**
   * One tick of the sender-side watchdog. Mirrors the sender branches of
   * Python's `Resource.__watchdog_job()` in RNS/Resource.py:561-654.
   *
   * Three sender states are handled:
   *   ADVERTISED      - retry the advertisement if no part request arrived
   *   TRANSFERRING    - enforce a global max-wait since last activity
   *   AWAITING_PROOF  - bounded wait for the receiver's proof
   */
  _watchdogTick() {
    if (this.status >= RESOURCE_COMPLETE) {
      this._stopWatchdog();
      return;
    }

    const now = Date.now() / 1000;
    const linkRtt = (this.link && this.link.rtt) || 1.0;

    if (this.status === RESOURCE_ADVERTISED) {
      // Python: sleep_time = adv_sent + timeout + PROCESSING_GRACE - now
      const deadline = this.advSent + this.timeout + PROCESSING_GRACE;
      if (now < deadline) return;

      if (this.retriesLeft <= 0) {
        log(LOG_DEBUG, TAG, 'Resource transfer timeout after sending advertisement');
        this._rejected('Timeout: no part requests received after advertising');
        return;
      }

      this.retriesLeft -= 1;
      log(LOG_DEBUG, TAG,
        `No part requests received, retrying advertisement ` +
        `(${MAX_ADV_RETRIES - this.retriesLeft}/${MAX_ADV_RETRIES})`);
      // Fire-and-forget — same as Python which calls packet.send() inside the
      // watchdog and ignores return.
      this._resendAdvertisement().catch((err) => {
        log(LOG_WARNING, TAG, `Advertisement resend failed: ${err.message}`);
        this._rejected(`Advertisement resend failed: ${err.message}`);
      });
      return;
    }

    if (this.status === RESOURCE_TRANSFERRING) {
      // Python (sender branch):
      //   max_extra_wait = sum((r+1) * PER_RETRY_DELAY for r in range(MAX_RETRIES))
      //   max_wait = rtt * timeout_factor * max_retries + sender_grace_time + max_extra_wait
      //   if last_activity + max_wait < now: cancel
      const maxExtraWait = ((MAX_RETRIES * (MAX_RETRIES + 1)) / 2) * PER_RETRY_DELAY;
      const rtt = this.rtt || linkRtt;
      const maxWait = rtt * this.timeoutFactor * MAX_RETRIES + SENDER_GRACE_TIME + maxExtraWait;
      if (this.lastActivity + maxWait < now) {
        log(LOG_DEBUG, TAG, 'Resource timed out waiting for part requests');
        this._rejected('Timeout: receiver stopped requesting parts');
      }
      return;
    }

    if (this.status === RESOURCE_AWAITING_PROOF) {
      // Python:
      //   timeout_factor = PROOF_TIMEOUT_FACTOR
      //   sleep_time = last_part_sent + (rtt*timeout_factor+sender_grace_time) - now
      this.timeoutFactor = PROOF_TIMEOUT_FACTOR;
      const rtt = this.rtt || linkRtt;
      const deadline = this.lastPartSent + (rtt * this.timeoutFactor + SENDER_GRACE_TIME);
      if (now >= deadline) {
        if (this.retriesLeft <= 0) {
          log(LOG_DEBUG, TAG, 'Resource timed out waiting for proof');
          this._rejected('Timeout: proof not received after last part');
        } else {
          // Python re-queries the Transport cache for the proof here; JS has
          // no equivalent cache, so we just reset the timer and keep waiting.
          this.retriesLeft -= 1;
          this.lastPartSent = now;
          log(LOG_DEBUG, TAG,
            `No proof received yet, extending wait ` +
            `(${MAX_PROOF_RETRIES - this.retriesLeft}/${MAX_PROOF_RETRIES})`);
        }
      }
    }
  }

  /**
   * Re-pack and resend the advertisement packet. Matches Python
   * Resource.py:581-585 where the watchdog rebuilds a fresh RESOURCE_ADV
   * packet on each retry.
   */
  async _resendAdvertisement() {
    const packed = this._packAdvertisement();
    await this.link.send(packed, CONTEXT_RESOURCE_ADV);
    const now = Date.now() / 1000;
    this.advSent = now;
    this.lastActivity = now;
  }

  /**
   * Mark this outgoing resource as rejected by the receiver.
   * Called when a CONTEXT_RESOURCE_RCL packet arrives from the peer.
   * Matches Python Resource._rejected() in RNS/Resource.py:1088.
   * @param {string} [reason]
   */
  _rejected(reason = 'Resource rejected by receiver') {
    if (this.status >= RESOURCE_COMPLETE) return;
    this.status = RESOURCE_REJECTED;
    this._stopWatchdog();
    log(LOG_INFO, TAG, `Outgoing resource rejected: ${reason}`);
    if (this._onFailed) this._onFailed(new Error(reason));
  }

  /**
   * Cancel this outgoing resource locally. Matches Python Resource.cancel()
   * (initiator branch) in RNS/Resource.py:1064: sets status FAILED and sends
   * a RESOURCE_ICL packet to tell the receiver to stop assembling.
   */
  async cancel(reason = 'Resource transfer cancelled') {
    if (this.status >= RESOURCE_COMPLETE) return;
    this.status = RESOURCE_FAILED;
    this._stopWatchdog();
    try {
      await this.link.send(this.hash, CONTEXT_RESOURCE_ICL);
    } catch (err) {
      log(LOG_WARNING, TAG, `Could not send resource cancel packet: ${err.message}`);
    }
    if (this._onFailed) this._onFailed(new Error(reason));
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
   * Build the msgpack-encoded advertisement payload. Extracted from
   * advertise() so the watchdog can rebuild it on retry.
   */
  _packAdvertisement() {
    const initialMapCount = Math.min(this.totalParts, HASHMAP_MAX_LEN);
    const hashmap = this.hashmapRaw.slice(0, initialMapCount * MAPHASH_LEN);

    let flags = 0;
    if (this.encryptedFlag) flags |= FLAG_ENCRYPTED;
    if (this.compressed) flags |= FLAG_COMPRESSED;
    if (this.split) flags |= FLAG_SPLIT;

    const adv = {
      t: this.streamData.length,         // on-wire transfer size (post-encryption)
      d: this.originalData.length,        // logical (plaintext, uncompressed) data size for this segment
      n: this.totalParts,
      h: this.hash,
      r: this.randomHash,
      o: this.originalHash,               // stable identifier (segment 1's hash)
      i: this.segmentIndex,
      l: this.totalSegments,
      q: this.requestId,
      f: flags,
      m: hashmap,
    };

    return new Uint8Array(msgpackEncode(adv));
  }

  /**
   * Start the transfer by sending the advertisement. Also primes the
   * watchdog so a silent receiver triggers an adv-resend after
   * PROCESSING_GRACE. Matches Python RNS/Resource.py:520-538.
   */
  async advertise() {
    await this._prepareParts();

    const packed = this._packAdvertisement();
    await this.link.send(packed, CONTEXT_RESOURCE_ADV);

    const now = Date.now() / 1000;
    this.advSent = now;
    this.lastActivity = now;
    // Initial timeout window for the ADVERTISED state, mirroring Python's
    // `self.timeout = self.link.rtt * self.link.traffic_timeout_factor`.
    const linkRtt = (this.link && this.link.rtt) || 1.0;
    this.timeout = linkRtt * TRAFFIC_TIMEOUT_FACTOR;
    this.retriesLeft = MAX_ADV_RETRIES;
    this.status = RESOURCE_ADVERTISED;

    log(LOG_INFO, TAG,
      `Advertised resource: ${this.totalParts} parts, ` +
      `${this.originalData.length}b plaintext / ${this.streamData.length}b on-wire`);

    this._startWatchdog();
  }

  /**
   * Handle a resource request from the receiver.
   * Matching Python Resource.request() — sends requested parts and HMU if needed.
   * @param {Uint8Array} plaintext
   */
  async handleRequest(plaintext) {
    // First request arriving while ADVERTISED → transition to TRANSFERRING.
    // Python RNS/Resource.py:969-980: computes RTT, switches state, resets
    // retries_left to MAX_RETRIES.
    if (this.status !== RESOURCE_TRANSFERRING) {
      const now = Date.now() / 1000;
      if (this.rtt === null && this.advSent > 0) {
        this.rtt = now - this.advSent;
      }
      this.status = RESOURCE_TRANSFERRING;
      this.timeoutFactor = PART_TIMEOUT_FACTOR;
    }
    this.retriesLeft = MAX_RETRIES;

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
    const nowSec = Date.now() / 1000;
    for (const reqHash of requestedHashes) {
      // Find which part this hash corresponds to
      for (let i = 0; i < this.mapHashes.length; i++) {
        if (equal(this.mapHashes[i], reqHash)) {
          this.link.sendRaw(this.parts[i], CONTEXT_RESOURCE);
          this.sentParts++;
          this.lastPartSent = nowSec;
          this.lastActivity = nowSec;
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

    // All parts sent → transition to AWAITING_PROOF.
    // Python RNS/Resource.py:1054-1056.
    if (this.sentParts >= this.totalParts) {
      this.status = RESOURCE_AWAITING_PROOF;
      this.retriesLeft = MAX_PROOF_RETRIES;
    }
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
    this._stopWatchdog();

    // If this was an intermediate segment of a split transfer, load the
    // next segment and re-advertise. The onComplete callback only fires
    // after the FINAL segment is proved. Matches Python
    // RNS/Resource.py:776-798 (validate_proof → prepare_next_segment).
    if (this.split && this.segmentIndex < this.totalSegments) {
      log(LOG_INFO, TAG,
        `Segment ${this.segmentIndex}/${this.totalSegments} proved, advertising next`);
      const nextIdx = this.segmentIndex + 1;
      this._loadSegment(nextIdx);
      // Fire-and-forget advertise — returns a Promise we don't await.
      this.advertise().catch((err) => {
        log(LOG_WARNING, TAG, `Next segment advertise failed: ${err.message}`);
        if (this._onFailed) this._onFailed(err);
      });
      return true;
    }

    log(LOG_INFO, TAG,
      `Resource transfer complete (${this.totalSegments} segment${this.totalSegments === 1 ? '' : 's'})`);
    if (this._onComplete) this._onComplete();
    return true;
  }

  onProgress(fn) { this._onProgress = fn; return this; }
  onComplete(fn) { this._onComplete = fn; return this; }
  onFailed(fn) { this._onFailed = fn; return this; }
  onSegmentAdvance(fn) { this._onSegmentAdvance = fn; return this; }
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
    this._onFailed = null;

    // Watchdog / retry tracking (receiver side).
    // Mirrors Python RNS/Resource.py:482-483, where receipt of a part resets
    // last_activity and retries_left.
    this.retriesLeft = MAX_RETRIES;
    this.lastActivity = Date.now() / 1000;
    this.rtt = null;
    this.partTimeoutFactor = PART_TIMEOUT_FACTOR;
    this._watchdogTimer = null;
    this._lastRequestAt = 0;

    log(LOG_INFO, TAG, `Received advertisement: ${this.totalParts} parts, ${this.dataSize} bytes`);
  }

  _startWatchdog() {
    if (this._watchdogTimer) return;
    this._watchdogTimer = setInterval(() => this._watchdogTick(), WATCHDOG_INTERVAL_MS);
    if (this._watchdogTimer && typeof this._watchdogTimer.unref === 'function') {
      this._watchdogTimer.unref();
    }
  }

  _stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  /**
   * One tick of the receiver-side watchdog. Mirrors the receiver branch of
   * Python's `Resource.__watchdog_job()` in RNS/Resource.py:591-625.
   *
   * When the outstanding parts haven't arrived within the expected
   * time-of-flight + a retry grace, shrink the window and re-request.
   */
  _watchdogTick() {
    if (this.status >= RESOURCE_COMPLETE) {
      this._stopWatchdog();
      return;
    }
    if (this.status !== RESOURCE_TRANSFERRING) return;
    if (this.outstandingParts === 0) return;

    const now = Date.now() / 1000;
    const retriesUsed = MAX_RETRIES - this.retriesLeft;
    const extraWait = retriesUsed * PER_RETRY_DELAY;

    // JS doesn't compute EIFR, so fall back to a simple RTT-based budget:
    //   (outstanding * rtt) + RETRY_GRACE_TIME
    // multiplied by partTimeoutFactor. Python's formula at line 600-602 is
    // more precise but this approximates the same order of magnitude.
    const linkRtt = (this.link && this.link.rtt) || 1.0;
    const rtt = this.rtt || linkRtt;
    const budget = this.partTimeoutFactor * (this.outstandingParts * rtt + RETRY_GRACE_TIME) + extraWait;

    if (this.lastActivity + budget >= now) return;

    if (this.retriesLeft <= 0) {
      log(LOG_DEBUG, TAG, `Resource receive timeout after ${MAX_RETRIES} retries`);
      this.cancel(`Timeout: missing ${this.outstandingParts} parts after ${MAX_RETRIES} retries`);
      return;
    }

    log(LOG_DEBUG, TAG,
      `Timed out waiting for ${this.outstandingParts} part(s), ` +
      `retrying (${retriesUsed + 1}/${MAX_RETRIES})`);

    // Shrink the window on timeout — matches Python Resource.py:612-617.
    if (this.window > this.windowMin) {
      this.window -= 1;
      if (this.windowMax > this.windowMin) {
        this.windowMax -= 1;
      }
    }

    this.retriesLeft -= 1;
    this.waitingForHmu = false;
    this.lastActivity = now;
    this._requestNext().catch((err) =>
      log(LOG_WARNING, TAG, `Retry requestNext failed: ${err.message}`));
  }

  /**
   * Cancel this incoming resource. Called from Link when a
   * CONTEXT_RESOURCE_ICL packet arrives (matching Python Resource.cancel()
   * non-initiator branch in RNS/Resource.py:1064).
   */
  cancel(reason = 'Resource transfer cancelled by sender') {
    if (this.status >= RESOURCE_COMPLETE) return;
    this.status = RESOURCE_FAILED;
    this._stopWatchdog();
    log(LOG_INFO, TAG, `Incoming resource cancelled: ${reason}`);
    if (this._onFailed) this._onFailed(new Error(reason));
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
    this.lastActivity = Date.now() / 1000;
    this._startWatchdog();
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
        // Reset retry counter on progress — Python RNS/Resource.py:482-483
        this.lastActivity = Date.now() / 1000;
        this.retriesLeft = MAX_RETRIES;
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
    this._stopWatchdog();

    log(LOG_INFO, TAG, `Resource assembled and verified: ${data.length} bytes`);

    // Send proof back to the sender. Matches Python Resource.assemble()
    // in RNS/Resource.py:702 which calls self.prove() immediately after
    // setting status=COMPLETE.
    try {
      await this.sendProof();
    } catch (err) {
      log(LOG_WARNING, TAG, `Could not send resource proof: ${err.message}`);
    }

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
  onFailed(fn) { this._onFailed = fn; return this; }
}
