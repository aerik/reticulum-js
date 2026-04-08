/**
 * Debug script: Test the REAL createAnnounce() + pack() code path.
 *
 * This uses the actual library code (not manual byte assembly) to create
 * an announce and print the raw packet for comparison. This catches any
 * bugs in the actual code path vs the manual construction.
 *
 * Usage: node scripts/debug-announce-realpath.js
 */

import { Identity } from '../src/Identity.js';
import { Destination } from '../src/Destination.js';
import { createAnnounce } from '../src/Announce.js';
import { DEST_SINGLE, DEST_IN } from '../src/constants.js';
import { toHex } from '../src/utils/bytes.js';

// ── Create identity from known seeds ──
const ENC_SEED = new Uint8Array(32); ENC_SEED.fill(0xAA);
const SIG_SEED = new Uint8Array(32); SIG_SEED.fill(0xBB);

// Use the library's fromPrivateKey (which expects 64 bytes: encPriv + sigPriv)
const keyBytes = new Uint8Array(64);
keyBytes.set(ENC_SEED, 0);
keyBytes.set(SIG_SEED, 32);
const identity = Identity.fromPrivateKey(keyBytes);

console.log('=== Real Code Path Test ===');
console.log();
console.log('Identity (from library):');
console.log('  enc pub :', toHex(identity.encryptionPublicKey));
console.log('  sig pub :', toHex(identity.signingPublicKey));
console.log('  pub key :', toHex(identity.publicKey));
console.log('  hash    :', identity.hexHash);
console.log();

// ── Create destination ──
const dest = new Destination(identity, DEST_IN, DEST_SINGLE, 'lxmf', 'delivery');

console.log('Destination (from library):');
console.log('  name     :', dest.name);
console.log('  nameHash :', toHex(dest.nameHash));
console.log('  hash     :', dest.hexHash);
console.log();

// ── Create announce ──
const appData = new TextEncoder().encode('Test App Data');
const packet = createAnnounce(dest, appData);

console.log('Announce packet (from createAnnounce):');
console.log('  headerType   :', packet.headerType);
console.log('  packetType   :', packet.packetType);
console.log('  destType     :', packet.destType);
console.log('  transportType:', packet.transportType);
console.log('  contextFlag  :', packet.contextFlag);
console.log('  hops         :', packet.hops);
console.log('  context      :', packet.context);
console.log('  dest hash    :', toHex(packet.destinationHash));
console.log('  data length  :', packet.data.length);
console.log();

// ── Pack the packet ──
const raw = packet.pack();

console.log('Packed packet:');
console.log('  flags byte: 0x' + raw[0].toString(16).padStart(2, '0'),
            '(0b' + raw[0].toString(2).padStart(8, '0') + ')');
console.log('  hops byte:  0x' + raw[1].toString(16).padStart(2, '0'));
console.log('  total size:', raw.length, 'bytes');
console.log();

// ── Parse the announce data ──
const data = packet.data;
let off = 0;
const pubKey = data.slice(off, off + 64); off += 64;
const nameHash = data.slice(off, off + 10); off += 10;
const randomBlob = data.slice(off, off + 10); off += 10;
const signature = data.slice(off, off + 64); off += 64;
const announceAppData = off < data.length ? data.slice(off) : null;

console.log('Announce data breakdown:');
console.log('  public_key  (64):', toHex(pubKey));
console.log('  name_hash   (10):', toHex(nameHash));
console.log('  random_blob (10):', toHex(randomBlob));
console.log('  signature   (64):', toHex(signature));
if (announceAppData) {
  console.log('  app_data   (' + announceAppData.length + '):', toHex(announceAppData));
}
console.log();

// ── Check random_blob timestamp encoding ──
console.log('Random blob analysis:');
console.log('  random part (5):', toHex(randomBlob.slice(0, 5)));
console.log('  time part   (5):', toHex(randomBlob.slice(5, 10)));

// Extract timestamp like Python does: int.from_bytes(random_blob[5:10], "big")
const ts = (randomBlob[5] * 0x100000000) +
           (randomBlob[6] * 0x1000000) +
           (randomBlob[7] * 0x10000) +
           (randomBlob[8] * 0x100) +
           randomBlob[9];
const actualTs = Math.floor(Date.now() / 1000);
console.log('  Extracted timestamp:', ts);
console.log('  Actual time:       ', actualTs);
console.log('  Difference:        ', Math.abs(ts - actualTs), 'seconds');
if (Math.abs(ts - actualTs) > 100) {
  console.log('  WARNING: Timestamp appears incorrect (diff > 100s)');
  console.log('  This is the >> 32 bug in makeRandomBlob()');
}
console.log();

// ── Verify signature ──
const signedData = new Uint8Array([
  ...packet.destinationHash,
  ...pubKey,
  ...nameHash,
  ...randomBlob,
  ...(announceAppData || []),
]);
const verified = identity.verify(signedData, signature);
console.log('Signature self-verify:', verified);
console.log();

// ── Export for Python validation ──
console.log('=== RAW PACKET HEX (for Python validation) ===');
console.log(toHex(raw));
