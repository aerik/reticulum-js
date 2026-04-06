/**
 * IFAC (Interface Access Code) — interface-level authentication and obfuscation.
 *
 * Matches the Python reference implementation.
 *
 * IFAC provides:
 * - Authentication: only nodes sharing the same networkname/passphrase can communicate
 * - Obfuscation: XOR-masking of packet contents (NOT encryption)
 *
 * Setup:
 *   ifac_origin = SHA256(networkname) + SHA256(passphrase)
 *   ifac_origin_hash = SHA256(ifac_origin)
 *   ifac_key = HKDF(ikm=ifac_origin_hash, salt=IFAC_SALT, info=empty, length=64)
 *   ifac_identity = Identity from ifac_key (used for signing)
 *   ifac_signature = ifac_identity.sign(SHA256(ifac_key))
 *
 * Transmit:
 *   1. ifac = ifac_identity.sign(raw_packet)[-ifac_size:]
 *   2. mask = HKDF(ikm=ifac, salt=ifac_key, length=len(raw)+ifac_size)
 *   3. Set IFAC flag (bit 7 of byte 0)
 *   4. Assemble: header[0:2] + ifac + raw[2:]
 *   5. XOR-mask everything except the IFAC bytes themselves
 *
 * Receive:
 *   Reverse of transmit: extract IFAC, generate mask, unmask, verify
 */

import { sha256Hash, hkdfDerive, ed25519Sign, ed25519Verify } from './crypto.js';
import { concat, fromHex, fromUtf8 } from './bytes.js';
import { Identity } from '../Identity.js';
import { DEFAULT_IFAC_SIZE } from '../constants.js';

// The IFAC salt from Python RNS (hardcoded constant)
const IFAC_SALT = fromHex('adf54d882c9a9b80771eb4995d702d4a3e733391b2a0f53f416d9f907e55cff8');

/**
 * Compute IFAC configuration from networkname and passphrase.
 *
 * @param {string} [networkname=''] - Network name
 * @param {string} [passphrase=''] - Passphrase
 * @param {number} [ifacSize=16] - IFAC size in bytes
 * @returns {{ ifacKey: Uint8Array, ifacIdentity: Identity, ifacSize: number }}
 */
export function computeIfac(networkname = '', passphrase = '', ifacSize = DEFAULT_IFAC_SIZE) {
  // ifac_origin = SHA256(networkname) + SHA256(passphrase)
  const nameHash = networkname ? sha256Hash(fromUtf8(networkname)) : new Uint8Array(0);
  const passHash = passphrase ? sha256Hash(fromUtf8(passphrase)) : new Uint8Array(0);
  const ifacOrigin = concat(nameHash, passHash);

  // ifac_origin_hash = SHA256(ifac_origin)
  const ifacOriginHash = sha256Hash(ifacOrigin);

  // ifac_key = HKDF(ikm=ifac_origin_hash, salt=IFAC_SALT, length=64)
  const ifacKey = hkdfDerive(ifacOriginHash, 64, IFAC_SALT, new Uint8Array(0));

  // Create an identity from the ifac_key (64 bytes = encPriv(32) + sigPriv(32))
  // The Python code uses Identity.from_bytes() which expects the full key format.
  // For IFAC, only the signing capability is used.
  const ifacIdentity = Identity.fromPrivateKey(ifacKey);

  return { ifacKey, ifacIdentity, ifacSize };
}

/**
 * Apply IFAC masking to an outgoing raw packet.
 *
 * @param {Uint8Array} raw - Raw packet bytes (before framing)
 * @param {{ ifacKey: Uint8Array, ifacIdentity: Identity, ifacSize: number }} ifacConfig
 * @returns {Uint8Array} Masked packet with IFAC prepended
 */
export function ifacMask(raw, ifacConfig) {
  const { ifacKey, ifacIdentity, ifacSize } = ifacConfig;

  // 1. Compute IFAC: last ifacSize bytes of signature over raw packet
  const signature = ifacIdentity.sign(raw);
  const ifac = signature.slice(signature.length - ifacSize);

  // 2. Generate XOR mask
  const maskLen = raw.length + ifacSize;
  const mask = hkdfDerive(ifac, maskLen, ifacKey, new Uint8Array(0));

  // 3. Set IFAC flag in byte 0
  const flagsByte = raw[0] | 0x80;

  // 4. Assemble: header[0:2] + ifac + raw[2:]
  const assembled = concat(
    new Uint8Array([flagsByte, raw[1]]),
    ifac,
    raw.slice(2)
  );

  // 5. XOR-mask:
  //    - Byte 0: masked, then OR with 0x80 to keep IFAC flag
  //    - Byte 1: masked
  //    - Bytes 2 to 2+ifacSize-1: NOT masked (the IFAC itself)
  //    - Bytes 2+ifacSize onwards: masked
  const masked = new Uint8Array(assembled);

  // Mask byte 0
  masked[0] = (assembled[0] ^ mask[0]) | 0x80;
  // Mask byte 1
  masked[1] = assembled[1] ^ mask[1];

  // Skip IFAC bytes (positions 2 to 2+ifacSize-1)
  // Mask everything after IFAC
  for (let i = 2 + ifacSize; i < masked.length; i++) {
    masked[i] = assembled[i] ^ mask[i];
  }

  return masked;
}

/**
 * Remove IFAC masking from an incoming raw packet.
 *
 * @param {Uint8Array} raw - Masked packet bytes (after deframing)
 * @param {{ ifacKey: Uint8Array, ifacIdentity: Identity, ifacSize: number }} ifacConfig
 * @returns {Uint8Array|null} Unmasked packet, or null if IFAC verification fails
 */
export function ifacUnmask(raw, ifacConfig) {
  const { ifacKey, ifacIdentity, ifacSize } = ifacConfig;

  if (raw.length < 2 + ifacSize + 1) return null; // too short

  // Check IFAC flag
  if ((raw[0] & 0x80) === 0) return null;

  // 1. Extract IFAC bytes (not masked)
  const ifac = raw.slice(2, 2 + ifacSize);

  // 2. Generate the same XOR mask
  // Original raw length = current length - ifacSize (IFAC bytes are extra)
  const originalLen = raw.length - ifacSize;
  const maskLen = originalLen + ifacSize;
  const mask = hkdfDerive(ifac, maskLen, ifacKey, new Uint8Array(0));

  // 3. Unmask
  const unmasked = new Uint8Array(raw);

  // Unmask byte 0, then clear IFAC flag
  unmasked[0] = (raw[0] ^ mask[0]) & 0x7F;
  // Unmask byte 1
  unmasked[1] = raw[1] ^ mask[1];

  // IFAC bytes stay as-is (positions 2 to 2+ifacSize-1)

  // Unmask everything after IFAC
  for (let i = 2 + ifacSize; i < unmasked.length; i++) {
    unmasked[i] = raw[i] ^ mask[i];
  }

  // 4. Reassemble without IFAC: header[0:2] + data[2+ifacSize:]
  const result = concat(
    unmasked.slice(0, 2),
    unmasked.slice(2 + ifacSize)
  );

  // 5. Verify: compute expected IFAC and compare
  const expectedSig = ifacIdentity.sign(result);
  const expectedIfac = expectedSig.slice(expectedSig.length - ifacSize);

  // Constant-time-ish comparison
  let valid = true;
  for (let i = 0; i < ifacSize; i++) {
    if (ifac[i] !== expectedIfac[i]) valid = false;
  }

  if (!valid) return null;

  return result;
}
