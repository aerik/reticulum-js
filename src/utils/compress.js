/**
 * Compression abstraction — loosely coupled, swappable.
 *
 * Python RNS uses bz2 for Resource auto-compression. There is no
 * actively-maintained pure-JS bzip2 *encoder* we can bundle cleanly
 * (seek-bzip and sheetjs/bz2 are decoder-only; compressjs is GPL),
 * so by default this module returns null from `compressBz2()` which
 * the Resource sender treats as "no compression available, send raw".
 *
 * Users who want Python-compatible compressed Resource transfers can
 * install a bz2 encoder of their choosing and wire it up:
 *
 *   import { setCompressor } from '@reticulum/src/utils/compress.js';
 *   import myBz2Encoder from 'some-bz2-encoder';
 *   setCompressor((bytes) => myBz2Encoder(bytes));
 *
 * Once configured, ResourceSender's auto-compress path will use it.
 * The decoder side (src/utils/decompress.js) has always been able to
 * handle incoming compressed data via the vendored bz2 decoder.
 */

let _compressBz2 = null;

/**
 * Compress data with bz2. Returns null if no encoder is configured.
 * @param {Uint8Array} data
 * @returns {Uint8Array|null} compressed bytes, or null if unavailable
 */
export function compressBz2(data) {
  if (!_compressBz2) return null;
  try {
    return _compressBz2(data);
  } catch {
    return null;
  }
}

/**
 * Register a bz2 encoder implementation.
 * @param {function(Uint8Array): Uint8Array} fn
 */
export function setCompressor(fn) {
  _compressBz2 = fn;
}

/**
 * Returns true if a bz2 encoder is currently configured.
 */
export function hasCompressor() {
  return _compressBz2 != null;
}
