/**
 * Cryptographic primitives for Reticulum — browser-compatible.
 *
 * Uses @noble/curves and @noble/hashes exclusively (no Node crypto dependency).
 * These libraries are pure JS and work identically in Node.js and browsers.
 */

import { x25519, ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { concat, randomBytes } from './bytes.js';

// --- Key Generation ---

/**
 * Generate an X25519 keypair (for ECDH key exchange).
 * @returns {{ privateKey: Uint8Array, publicKey: Uint8Array }}
 */
export function generateX25519Keypair() {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/**
 * Generate an Ed25519 keypair (for signing).
 * @returns {{ privateKey: Uint8Array, publicKey: Uint8Array }}
 */
export function generateEd25519Keypair() {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

// --- ECDH ---

/**
 * Perform X25519 ECDH to derive a shared secret.
 * @param {Uint8Array} privateKey - Our X25519 private key
 * @param {Uint8Array} publicKey - Their X25519 public key
 * @returns {Uint8Array} 32-byte shared secret
 */
export function x25519SharedSecret(privateKey, publicKey) {
  return x25519.getSharedSecret(privateKey, publicKey);
}

// --- Signing ---

/**
 * Sign data with an Ed25519 private key.
 * @param {Uint8Array} message
 * @param {Uint8Array} privateKey
 * @returns {Uint8Array} 64-byte signature
 */
export function ed25519Sign(message, privateKey) {
  return ed25519.sign(message, privateKey);
}

/**
 * Verify an Ed25519 signature.
 * @param {Uint8Array} signature
 * @param {Uint8Array} message
 * @param {Uint8Array} publicKey
 * @returns {boolean}
 */
export function ed25519Verify(signature, message, publicKey) {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

// --- Hashing ---

/**
 * SHA-256 hash (full 32 bytes).
 * @param {Uint8Array} data
 * @returns {Uint8Array} 32-byte hash
 */
export function sha256Hash(data) {
  return sha256(data);
}

/**
 * Truncated SHA-256 hash (first `length` bytes).
 * Used for destination hashes (16 bytes), name hashes (10 bytes), identity hashes.
 * @param {Uint8Array} data
 * @param {number} length - Number of bytes to keep (default 16)
 * @returns {Uint8Array}
 */
export function truncatedHash(data, length = 16) {
  return sha256(data).slice(0, length);
}

// --- HMAC ---

/**
 * HMAC-SHA-256.
 * @param {Uint8Array} key
 * @param {Uint8Array} message
 * @returns {Uint8Array} 32-byte HMAC
 */
export function hmacSha256(key, message) {
  return hmac(sha256, key, message);
}

// --- HKDF ---

/**
 * HKDF-SHA-256 key derivation (RFC 5869).
 * @param {Uint8Array} ikm - Input keying material
 * @param {number} length - Desired output length in bytes
 * @param {Uint8Array} [salt] - Optional salt (undefined/empty = zero-filled hash-length)
 * @param {Uint8Array} [info] - Optional context info (undefined = empty bytes)
 * @returns {Uint8Array}
 */
export function hkdfDerive(ikm, length, salt, info) {
  return hkdf(sha256, ikm, salt, info, length);
}

// --- AES-CBC ---
// Uses SubtleCrypto API — available in both Node 18+ and browsers.
// WebCrypto handles PKCS7 padding automatically.

/**
 * Encrypt with AES-CBC. Key length determines AES-128 (16 bytes) or AES-256 (32 bytes).
 * @param {Uint8Array} plaintext
 * @param {Uint8Array} key - 16 or 32-byte key
 * @param {Uint8Array} iv - 16-byte IV
 * @returns {Promise<Uint8Array>} ciphertext (PKCS7 padded by WebCrypto)
 */
export async function aesCbcEncrypt(plaintext, key, iv) {
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw', key, { name: 'AES-CBC' }, false, ['encrypt']
  );
  const result = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-CBC', iv }, cryptoKey, plaintext
  );
  return new Uint8Array(result);
}

/**
 * Decrypt with AES-CBC. Key length determines AES-128 or AES-256.
 * @param {Uint8Array} ciphertext
 * @param {Uint8Array} key - 16 or 32-byte key
 * @param {Uint8Array} iv - 16-byte IV
 * @returns {Promise<Uint8Array>} plaintext (PKCS7 unpadded by WebCrypto)
 */
export async function aesCbcDecrypt(ciphertext, key, iv) {
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw', key, { name: 'AES-CBC' }, false, ['decrypt']
  );
  const result = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-CBC', iv }, cryptoKey, ciphertext
  );
  return new Uint8Array(result);
}

// Keep old names as aliases for backward compat in tests
export const aes128CbcEncrypt = aesCbcEncrypt;
export const aes128CbcDecrypt = aesCbcDecrypt;

// --- PKCS7 Padding ---
// WebCrypto handles this automatically, but exposed for interop testing.

/**
 * Add PKCS7 padding to a block.
 * @param {Uint8Array} data
 * @param {number} blockSize - default 16
 * @returns {Uint8Array}
 */
export function pkcs7Pad(data, blockSize = 16) {
  const padLen = blockSize - (data.length % blockSize);
  const padded = new Uint8Array(data.length + padLen);
  padded.set(data);
  padded.fill(padLen, data.length);
  return padded;
}

/**
 * Remove PKCS7 padding.
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
export function pkcs7Unpad(data) {
  const padLen = data[data.length - 1];
  if (padLen < 1 || padLen > 16) throw new Error('Invalid PKCS7 padding');
  return data.slice(0, data.length - padLen);
}
