/**
 * Decompression abstraction — loosely coupled, swappable.
 *
 * Uses a vendored bz2 decoder (src/vendor/bz2.js) that is pure
 * Uint8Array — no Buffer, no Node dependencies, works everywhere.
 *
 * To swap: change only this file, or call setDecompressor() at runtime.
 */

import { decodeBz2 } from '../vendor/bz2.js';

let _decompressBz2 = decodeBz2;

/**
 * Decompress bz2 data.
 * @param {Uint8Array} compressed
 * @returns {Uint8Array} decompressed data
 */
export function decompressBz2(compressed) {
  return _decompressBz2(compressed);
}

/**
 * Set a custom decompression function.
 * @param {function(Uint8Array): Uint8Array} fn
 */
export function setDecompressor(fn) {
  _decompressBz2 = fn;
}
