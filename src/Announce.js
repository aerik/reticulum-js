/**
 * Announce — construction and validation of RNS announce packets.
 *
 * Announce data layout (without ratchet, context_flag = 0):
 *   [public_key: 64] [name_hash: 10] [random_blob: 10] [signature: 64] [app_data: var]
 *
 * With ratchet (context_flag = 1):
 *   [public_key: 64] [name_hash: 10] [random_blob: 10] [ratchet: 32] [signature: 64] [app_data: var]
 *
 * The signed_data for the signature is:
 *   destination_hash + public_key + name_hash + random_blob [+ ratchet] [+ app_data]
 *
 * Note: destination_hash is in the packet header, not in the announce data.
 *
 * Random blob = 5 random bytes + 5 bytes big-endian Unix timestamp
 */

import { Identity } from './Identity.js';
import { Packet } from './Packet.js';
import { Destination } from './Destination.js';
import { truncatedHash, sha256Hash, ed25519Verify } from './utils/crypto.js';
import { concat, fromUtf8, toHex, randomBytes, equal } from './utils/bytes.js';
import {
  PACKET_ANNOUNCE, TRANSPORT_BROADCAST, HEADER_1,
  DEST_SINGLE, FLAG_UNSET, FLAG_SET,
  CONTEXT_NONE,
  IDENTITY_HASH_LENGTH, IDENTITY_NAME_HASH_LENGTH,
  IDENTITY_KEYSIZE, IDENTITY_SIGLENGTH, IDENTITY_RATCHETSIZE,
} from './constants.js';

/**
 * Build a 10-byte random blob: 5 random bytes + 5-byte big-endian timestamp.
 * @returns {Uint8Array}
 */
export function makeRandomBlob() {
  const blob = new Uint8Array(10);
  // First 5 bytes: random
  const rand = randomBytes(5);
  blob.set(rand, 0);
  // Last 5 bytes: Unix timestamp in big-endian
  const now = Math.floor(Date.now() / 1000);
  blob[5] = (now >> 32) & 0xFF;
  blob[6] = (now >> 24) & 0xFF;
  blob[7] = (now >> 16) & 0xFF;
  blob[8] = (now >> 8) & 0xFF;
  blob[9] = now & 0xFF;
  return blob;
}

/**
 * Extract the timestamp from a 10-byte random blob.
 * @param {Uint8Array} blob
 * @returns {number} Unix timestamp in seconds
 */
export function extractTimestamp(blob) {
  return (
    (blob[5] * 0x100000000) +
    (blob[6] << 24 | blob[7] << 16 | blob[8] << 8 | blob[9]) >>> 0
  );
}

/**
 * Construct an announce packet for a destination.
 *
 * @param {Destination} destination
 * @param {Uint8Array} [appData] - Optional application data
 * @param {object} [options]
 * @param {Uint8Array} [options.ratchet] - 32-byte X25519 public key for ratcheted encryption
 * @returns {Packet} Ready-to-send announce packet
 */
export function createAnnounce(destination, appData, options = {}) {
  const identity = destination.identity;
  if (!identity || !identity.hasPrivateKey()) {
    throw new Error('Cannot announce without a local identity with private keys');
  }
  if (destination.type !== DEST_SINGLE) {
    throw new Error('Only SINGLE destinations can be announced');
  }

  const ratchet = options.ratchet || null;
  const hasRatchet = ratchet !== null && ratchet.length === IDENTITY_RATCHETSIZE;
  const randomBlob = makeRandomBlob();

  // Build signed data: dest_hash + pubkey + name_hash + random_blob [+ ratchet] [+ app_data]
  const signedParts = [
    destination.hash,
    identity.publicKey,
    destination.nameHash,
    randomBlob,
  ];
  if (hasRatchet) signedParts.push(ratchet);
  if (appData && appData.length > 0) signedParts.push(appData);
  const signedData = concat(...signedParts);

  // Sign with identity
  const signature = identity.sign(signedData);

  // Build announce data blob: pubkey + name_hash + random_blob [+ ratchet] + signature [+ app_data]
  const dataParts = [
    identity.publicKey,     // 64 bytes
    destination.nameHash,   // 10 bytes
    randomBlob,             // 10 bytes
  ];
  if (hasRatchet) dataParts.push(ratchet); // 32 bytes
  dataParts.push(signature);               // 64 bytes
  if (appData && appData.length > 0) dataParts.push(appData);
  const announceData = concat(...dataParts);

  // Build the packet
  const packet = new Packet();
  packet.headerType = HEADER_1;
  packet.packetType = PACKET_ANNOUNCE;
  packet.destType = DEST_SINGLE;
  packet.transportType = TRANSPORT_BROADCAST;
  packet.contextFlag = hasRatchet ? FLAG_SET : FLAG_UNSET;
  packet.hops = 0;
  packet.destinationHash = destination.hash;
  packet.context = CONTEXT_NONE;
  packet.data = announceData;

  return packet;
}

/**
 * Parse and validate an announce from a received packet.
 *
 * @param {Packet} packet - A parsed packet with packetType === PACKET_ANNOUNCE
 * @returns {{ identity: Identity, nameHash: Uint8Array, randomBlob: Uint8Array,
 *             appData: Uint8Array|null, timestamp: number, destinationHash: Uint8Array }|null}
 *   Returns null if validation fails.
 */
export function validateAnnounce(packet) {
  if (packet.packetType !== PACKET_ANNOUNCE) return null;

  const data = packet.data;
  const hasRatchet = packet.contextFlag === FLAG_SET;

  // Minimum size check
  const minSize = hasRatchet
    ? IDENTITY_KEYSIZE + IDENTITY_NAME_HASH_LENGTH + 10 + IDENTITY_RATCHETSIZE + IDENTITY_SIGLENGTH
    : IDENTITY_KEYSIZE + IDENTITY_NAME_HASH_LENGTH + 10 + IDENTITY_SIGLENGTH;
  // 180 bytes with ratchet, 148 without

  if (data.length < minSize) return null;

  // Parse fields
  let offset = 0;

  const publicKey = data.slice(offset, offset + IDENTITY_KEYSIZE); // 64 bytes
  offset += IDENTITY_KEYSIZE;

  const nameHash = data.slice(offset, offset + IDENTITY_NAME_HASH_LENGTH); // 10 bytes
  offset += IDENTITY_NAME_HASH_LENGTH;

  const randomBlob = data.slice(offset, offset + 10); // 10 bytes
  offset += 10;

  let ratchet = null;
  if (hasRatchet) {
    ratchet = data.slice(offset, offset + IDENTITY_RATCHETSIZE); // 32 bytes
    offset += IDENTITY_RATCHETSIZE;
  }

  const signature = data.slice(offset, offset + IDENTITY_SIGLENGTH); // 64 bytes
  offset += IDENTITY_SIGLENGTH;

  const appData = offset < data.length ? data.slice(offset) : null;

  // Reconstruct identity from public key
  const identity = Identity.fromPublicKey(publicKey);

  // Verify destination hash: SHA-256(name_hash + identity_hash)[:16]
  const expectedHash = Destination.computeHash(nameHash, identity.hash);
  if (!equal(expectedHash, packet.destinationHash)) {
    return null;
  }

  // Reconstruct signed data and verify signature
  const signedParts = [packet.destinationHash, publicKey, nameHash, randomBlob];
  if (ratchet) signedParts.push(ratchet);
  if (appData) signedParts.push(appData);
  const signedData = concat(...signedParts);

  if (!identity.verify(signedData, signature)) {
    return null;
  }

  return {
    identity,
    nameHash,
    randomBlob,
    ratchet,
    appData,
    timestamp: extractTimestamp(randomBlob),
    destinationHash: packet.destinationHash,
  };
}
