/**
 * Byte utilities — Uint8Array-first for browser compatibility.
 *
 * All internal code uses Uint8Array. These helpers bridge the gap
 * where Node Buffer convenience methods are expected.
 */

/**
 * Concatenate multiple Uint8Arrays into one.
 * @param  {...Uint8Array} arrays
 * @returns {Uint8Array}
 */
export function concat(...arrays) {
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

/**
 * Compare two Uint8Arrays for equality.
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
export function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Convert a hex string to Uint8Array.
 * @param {string} hex
 * @returns {Uint8Array}
 */
export function fromHex(hex) {
  if (hex.length % 2 !== 0) throw new Error('Hex string must have even length');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Convert a Uint8Array to hex string.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Convert a UTF-8 string to Uint8Array.
 * @param {string} str
 * @returns {Uint8Array}
 */
export function fromUtf8(str) {
  return new TextEncoder().encode(str);
}

/**
 * Convert a Uint8Array to UTF-8 string.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}

/**
 * Create a Uint8Array of random bytes.
 * Works in both Node.js and browser (via globalThis.crypto).
 * @param {number} length
 * @returns {Uint8Array}
 */
export function randomBytes(length) {
  const bytes = new Uint8Array(length);
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Node.js fallback (shouldn't be needed in modern Node, but just in case)
    throw new Error('No crypto.getRandomValues available');
  }
  return bytes;
}

/**
 * Truncate a Uint8Array to the specified length.
 * @param {Uint8Array} bytes
 * @param {number} length
 * @returns {Uint8Array}
 */
export function truncate(bytes, length) {
  return bytes.slice(0, length);
}
