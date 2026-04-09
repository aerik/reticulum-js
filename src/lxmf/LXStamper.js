/**
 * LXStamper — proof-of-work "stamps" for LXMF propagation.
 *
 * Mirrors the Python reference (LXMF/LXStamper.py).
 *
 * A stamp is a 32-byte value such that SHA-256(workblock || stamp) has at least
 * `target_cost` leading zero bits. The workblock is derived deterministically
 * from a "material" (typically the message's transient_id) via repeated HKDF
 * expansion, so the work is unique per message and cannot be precomputed.
 *
 * Stamps are required by Python LXMF propagation nodes (default cost 16,
 * minimum 13 bits) — without them, the node tears down the link.
 */

import { sha256Hash, hkdfDerive } from '../utils/crypto.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { concat, randomBytes } from '../utils/bytes.js';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { log, LOG_DEBUG, LOG_VERBOSE } from '../utils/log.js';

const TAG = 'LXStamper';

// Workblock expansion rounds (matching Python LXStamper)
export const WORKBLOCK_EXPAND_ROUNDS         = 3000;
export const WORKBLOCK_EXPAND_ROUNDS_PN      = 1000;
export const WORKBLOCK_EXPAND_ROUNDS_PEERING = 25;

// Stamp size: SHA-256 hash length (32 bytes)
export const STAMP_SIZE = 32;

// Hash length / stamp working bit width
const HASH_BITS = 256;

/**
 * Build the workblock for a given material (message id / transient id).
 * Matches Python LXStamper.stamp_workblock():
 *
 *     workblock = b""
 *     for n in range(expand_rounds):
 *         workblock += hkdf(length=256,
 *                           derive_from=material,
 *                           salt=full_hash(material + msgpack(n)),
 *                           context=None)
 *
 * @param {Uint8Array} material - Typically the message transient_id (32 bytes)
 * @param {number} [expandRounds=WORKBLOCK_EXPAND_ROUNDS_PN] - Iteration count
 * @returns {Uint8Array} workblock bytes (length = expand_rounds * 256)
 */
export function stampWorkblock(material, expandRounds = WORKBLOCK_EXPAND_ROUNDS_PN) {
  const blockLen = 256;
  const out = new Uint8Array(expandRounds * blockLen);
  for (let n = 0; n < expandRounds; n++) {
    const nBytes = new Uint8Array(msgpackEncode(n));
    const salt = sha256Hash(concat(material, nBytes));
    const round = hkdfDerive(material, blockLen, salt, undefined);
    out.set(round, n * blockLen);
  }
  return out;
}

/**
 * Count the number of leading zero bits in a hash digest.
 * Matches Python LXStamper.stamp_value() — but counts directly on bytes.
 * @param {Uint8Array} hash - 32-byte SHA-256 result
 * @returns {number}
 */
export function leadingZeroBits(hash) {
  let count = 0;
  for (let i = 0; i < hash.length; i++) {
    const b = hash[i];
    if (b === 0) { count += 8; continue; }
    // Count leading zeros in this byte
    let mask = 0x80;
    while (mask && (b & mask) === 0) {
      count++;
      mask >>>= 1;
    }
    return count;
  }
  return count;
}

/**
 * Compute the "value" of a stamp = number of leading zero bits in
 * SHA-256(workblock || stamp).
 *
 * @param {Uint8Array} workblock
 * @param {Uint8Array} stamp
 * @returns {number}
 */
export function stampValue(workblock, stamp) {
  const digest = sha256Hash(concat(workblock, stamp));
  return leadingZeroBits(digest);
}

/**
 * Validate that a stamp meets the target cost.
 * Matches Python LXStamper.stamp_valid().
 *
 * @param {Uint8Array} stamp
 * @param {number} targetCost - Required leading zero bits
 * @param {Uint8Array} workblock
 * @returns {boolean}
 */
export function stampValid(stamp, targetCost, workblock) {
  return stampValue(workblock, stamp) >= targetCost;
}

/**
 * Generate a propagation-node stamp for an already-packed LXMF message.
 *
 * Matches Python LXStamper.generate_stamp() (PN variant): uses
 * WORKBLOCK_EXPAND_ROUNDS_PN (1000) and the message transient_id as material.
 *
 * Performance: average ~2^targetCost SHA-256 attempts. For default cost 13
 * that's ~8192 attempts (~1-2 seconds in JS). For cost 16 (~65k attempts)
 * it's ~10-15 seconds.
 *
 * @param {Uint8Array} transientId - SHA-256(lxmf_data) — 32 bytes
 * @param {number} targetCost - Required stamp cost (leading zero bits)
 * @returns {{ stamp: Uint8Array, value: number, attempts: number, durationMs: number }}
 */
export function generatePnStamp(transientId, targetCost) {
  const startTime = Date.now();

  // Build the workblock once. This is deterministic per transient_id.
  const workblock = stampWorkblock(transientId, WORKBLOCK_EXPAND_ROUNDS_PN);

  // Use noble's incremental SHA-256 so we can update(workblock) once and
  // clone for each stamp attempt — much faster than re-hashing the full
  // workblock for every try.
  const baseHasher = nobleSha256.create();
  baseHasher.update(workblock);

  let attempts = 0;
  while (true) {
    const stamp = randomBytes(STAMP_SIZE);
    attempts++;
    const digest = baseHasher.clone().update(stamp).digest();
    if (leadingZeroBits(digest) >= targetCost) {
      const value = leadingZeroBits(digest);
      const durationMs = Date.now() - startTime;
      log(LOG_DEBUG, TAG,
        `Stamp generated: cost=${targetCost} value=${value} attempts=${attempts} in ${durationMs}ms`);
      return { stamp, value, attempts, durationMs };
    }

    // Safety cap: stop after a hard ceiling so a misconfigured cost doesn't
    // hang forever. ~16x the expected attempts gives a wide safety margin.
    if (attempts > (1 << Math.min(targetCost + 4, 24))) {
      throw new Error(
        `LXStamper.generatePnStamp gave up after ${attempts} attempts ` +
        `(cost=${targetCost}). Cost too high or randomness broken?`);
    }
  }
}

/**
 * Validate a list of propagation-node stamps in a transient list.
 * Matches Python LXStamper.validate_pn_stamps_job_simple().
 *
 * @param {Uint8Array[]} transientList - Array of lxmf_data + stamp blobs
 * @param {number} targetCost
 * @returns {Array<{transientId, lxmData, value, stamp}>} validated entries
 */
export function validatePnStamps(transientList, targetCost) {
  const out = [];
  for (const transientData of transientList) {
    if (transientData.length <= STAMP_SIZE) continue;
    const lxmData = transientData.slice(0, transientData.length - STAMP_SIZE);
    const stamp = transientData.slice(transientData.length - STAMP_SIZE);
    const transientId = sha256Hash(lxmData);
    const workblock = stampWorkblock(transientId, WORKBLOCK_EXPAND_ROUNDS_PN);
    if (stampValid(stamp, targetCost, workblock)) {
      out.push({ transientId, lxmData, value: stampValue(workblock, stamp), stamp });
    }
  }
  return out;
}
