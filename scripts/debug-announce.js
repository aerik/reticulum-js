/**
 * Debug script: Generate a deterministic announce packet and print a detailed
 * byte-level breakdown for comparison with the Python reference implementation.
 *
 * Usage: node scripts/debug-announce.js
 *
 * Two modes:
 *   1. Deterministic mode (default): Fixed seeds and timestamp for exact comparison
 *   2. Real mode (--real): Uses the actual createAnnounce() code path to test
 *      what the JS implementation really produces
 */

import { x25519, ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

// ── helpers ────────────────────────────────────────────────────────────────

function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function concat(...arrays) {
  const len = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function fromUtf8(str) {
  return new TextEncoder().encode(str);
}

function truncatedHash(data, length) {
  return sha256(data).slice(0, length);
}

function hexDump(label, bytes, offset) {
  const hex = toHex(bytes);
  console.log(`  ${label.padEnd(22)} offset=${String(offset).padStart(3)}  len=${String(bytes.length).padStart(3)}  ${hex}`);
}

// ── deterministic keys ────────────────────────────────────────────────────
// Use fixed seeds so Python can reproduce the exact same identity.

const ENC_SEED = new Uint8Array(32); ENC_SEED.fill(0xAA);
const SIG_SEED = new Uint8Array(32); SIG_SEED.fill(0xBB);

const encPub = x25519.getPublicKey(ENC_SEED);
const sigPub = ed25519.getPublicKey(SIG_SEED);

// Public key blob = X25519 pub (32) + Ed25519 pub (32) = 64 bytes
const publicKey = concat(encPub, sigPub);

// Identity hash = SHA-256(publicKey)[:16]
const identityHash = truncatedHash(publicKey, 16);

console.log('=== JS Announce Debug ===');
console.log();
console.log('Identity:');
console.log('  enc_seed  (X25519 priv):', toHex(ENC_SEED));
console.log('  sig_seed  (Ed25519 priv):', toHex(SIG_SEED));
console.log('  enc_pub   (X25519 pub) :', toHex(encPub));
console.log('  sig_pub   (Ed25519 pub):', toHex(sigPub));
console.log('  public_key (64 bytes)  :', toHex(publicKey));
console.log('  identity_hash (16 bytes):', toHex(identityHash));
console.log();

// ── destination ───────────────────────────────────────────────────────────

const APP_NAME = 'lxmf';
const ASPECT = 'delivery';
const destName = `${APP_NAME}.${ASPECT}`;  // "lxmf.delivery"

// name_hash = SHA-256("lxmf.delivery")[:10]
const nameHash = truncatedHash(fromUtf8(destName), 10);

// dest_hash = SHA-256(name_hash + identity_hash)[:16]
const destHash = truncatedHash(concat(nameHash, identityHash), 16);

console.log('Destination:');
console.log('  name string           :', destName);
console.log('  name_hash (10 bytes)  :', toHex(nameHash));
console.log('  dest_hash (16 bytes)  :', toHex(destHash));
console.log();

// ── random blob ───────────────────────────────────────────────────────────
// Deterministic for reproducibility: 5 zero bytes + 5-byte timestamp = 0

const FIXED_RANDOM = new Uint8Array(5).fill(0x00);
const FIXED_TIME = 1700000000; // a known Unix timestamp

const randomBlob = new Uint8Array(10);
randomBlob.set(FIXED_RANDOM, 0);
// 5-byte big-endian timestamp
randomBlob[5] = (FIXED_TIME / 0x100000000) & 0xFF;  // high byte (will be 0 for timestamps < 2^32)
randomBlob[6] = (FIXED_TIME >> 24) & 0xFF;
randomBlob[7] = (FIXED_TIME >> 16) & 0xFF;
randomBlob[8] = (FIXED_TIME >> 8) & 0xFF;
randomBlob[9] = FIXED_TIME & 0xFF;

console.log('Random blob:');
console.log('  random (5 bytes)      :', toHex(FIXED_RANDOM));
console.log('  timestamp             :', FIXED_TIME);
console.log('  random_blob (10 bytes):', toHex(randomBlob));
console.log();

// ── TIMESTAMP BUG CHECK ───────────────────────────────────────────────────
// The actual makeRandomBlob() uses >> 32 which is broken in JS
console.log('=== TIMESTAMP ENCODING BUG CHECK ===');
const realNow = Math.floor(Date.now() / 1000);
const buggyBlob5 = (realNow >> 32) & 0xFF;  // BUG: >> 32 is >> 0 in JS
const correctBlob5 = Math.floor(realNow / 0x100000000) & 0xFF;
console.log(`  Current timestamp     : ${realNow} (0x${realNow.toString(16)})`);
console.log(`  Buggy blob[5]  (>>32) : 0x${buggyBlob5.toString(16).padStart(2, '0')} (WRONG - >> 32 is >> 0 in JS)`);
console.log(`  Correct blob[5] (div) : 0x${correctBlob5.toString(16).padStart(2, '0')}`);
console.log(`  Bug affects encoding  : ${buggyBlob5 !== correctBlob5 ? 'YES - bytes differ!' : 'No (same value)'}`);
console.log();

// ── app data ──────────────────────────────────────────────────────────────

const appData = fromUtf8('Test App Data');
console.log('App data:');
console.log('  bytes                 :', toHex(appData));
console.log('  string                : "Test App Data"');
console.log();

// ── signature ─────────────────────────────────────────────────────────────
// signed_data = dest_hash + public_key + name_hash + random_blob [+ app_data]
// (no ratchet in this test)

const signedData = concat(destHash, publicKey, nameHash, randomBlob, appData);

console.log('Signed data construction:');
console.log('  dest_hash     (16)    :', toHex(destHash));
console.log('  public_key    (64)    :', toHex(publicKey));
console.log('  name_hash     (10)    :', toHex(nameHash));
console.log('  random_blob   (10)    :', toHex(randomBlob));
console.log('  app_data      (' + appData.length + ')    :', toHex(appData));
console.log('  signed_data total     :', signedData.length, 'bytes');
console.log('  signed_data hex       :', toHex(signedData));
console.log();

const signature = ed25519.sign(signedData, SIG_SEED);

console.log('Signature (64 bytes)    :', toHex(signature));
console.log();

// Verify our own signature
const sigOk = ed25519.verify(signature, signedData, sigPub);
console.log('Self-verify             :', sigOk);
console.log();

// ── announce data ─────────────────────────────────────────────────────────
// announce_data = public_key + name_hash + random_blob + signature + app_data

const announceData = concat(publicKey, nameHash, randomBlob, signature, appData);

console.log('Announce data layout:');
let off = 0;
hexDump('public_key (64)', publicKey, off); off += 64;
hexDump('name_hash (10)', nameHash, off); off += 10;
hexDump('random_blob (10)', randomBlob, off); off += 10;
hexDump('signature (64)', signature, off); off += 64;
hexDump('app_data (' + appData.length + ')', appData, off); off += appData.length;
console.log('  total announce_data   :', announceData.length, 'bytes');
console.log();

// ── packet header ─────────────────────────────────────────────────────────

const IFAC_FLAG = 0;
const HEADER_TYPE = 0;  // HEADER_1
const CONTEXT_FLAG = 0; // no ratchet
const TRANSPORT_TYPE = 0; // BROADCAST
const DEST_TYPE = 0;    // SINGLE
const PACKET_TYPE = 1;  // ANNOUNCE

const flags = (IFAC_FLAG << 7) | (HEADER_TYPE << 6) | (CONTEXT_FLAG << 5) |
              (TRANSPORT_TYPE << 4) | (DEST_TYPE << 2) | PACKET_TYPE;

const hops = 0;
const context = 0x00; // CONTEXT_NONE

console.log('Packet header:');
console.log('  flags byte            :', '0x' + flags.toString(16).padStart(2, '0'),
            '(0b' + flags.toString(2).padStart(8, '0') + ')');
console.log('    IFAC flag           :', IFAC_FLAG);
console.log('    header type         :', HEADER_TYPE, '(HEADER_1)');
console.log('    context flag        :', CONTEXT_FLAG, '(no ratchet)');
console.log('    transport type      :', TRANSPORT_TYPE, '(BROADCAST)');
console.log('    dest type           :', DEST_TYPE, '(SINGLE)');
console.log('    packet type         :', PACKET_TYPE, '(ANNOUNCE)');
console.log('  hops byte             :', '0x' + hops.toString(16).padStart(2, '0'));
console.log('  dest_hash (16 bytes)  :', toHex(destHash));
console.log('  context byte          :', '0x' + context.toString(16).padStart(2, '0'));
console.log();

// ── full packet ───────────────────────────────────────────────────────────

const header = new Uint8Array(2);
header[0] = flags;
header[1] = hops;

const fullPacket = concat(header, destHash, new Uint8Array([context]), announceData);

console.log('Full packet breakdown:');
off = 0;
hexDump('flags (1)', header.slice(0, 1), off); off += 1;
hexDump('hops (1)', header.slice(1, 2), off); off += 1;
hexDump('dest_hash (16)', destHash, off); off += 16;
hexDump('context (1)', new Uint8Array([context]), off); off += 1;
hexDump('announce_data', announceData, off);
console.log('  total packet size     :', fullPacket.length, 'bytes');
console.log();

console.log('=== FULL PACKET HEX ===');
console.log(toHex(fullPacket));
console.log();

// ── export keys for Python ────────────────────────────────────────────────
console.log('=== KEY EXPORT (paste into Python script) ===');
console.log('ENC_SEED =', toHex(ENC_SEED));
console.log('SIG_SEED =', toHex(SIG_SEED));
console.log('FIXED_TIME =', FIXED_TIME);
