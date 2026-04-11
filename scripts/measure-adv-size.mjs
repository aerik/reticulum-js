// Measure ResourceSender advertisement packed size for various resource sizes.
// The advertisement has a fixed-size-ish header plus a bounded hashmap.
// If it ever exceeds Link.MDU (~431 bytes) it'll be dropped.

import { encode as msgpackEncode } from '@msgpack/msgpack';
import { sha256Hash } from '../src/utils/crypto.js';
import { concat, randomBytes } from '../src/utils/bytes.js';

const HASHMAP_MAX_LEN = 74;
const SDU = 464;

for (const sizeKb of [30, 100, 500, 750, 900, 1024, 1100, 2048]) {
  const size = sizeKb * 1024;
  const totalParts = Math.ceil(size / SDU);
  const hashmap = new Uint8Array(Math.min(totalParts, HASHMAP_MAX_LEN) * 4);
  for (let i = 0; i < hashmap.length; i++) hashmap[i] = i & 0xff;
  const hash = sha256Hash(new Uint8Array(32));
  const randHash = randomBytes(4);

  const adv = {
    t: size + 64,
    d: size,
    n: totalParts,
    h: hash,
    r: randHash,
    o: hash,
    i: 1,
    l: 1,
    q: null,
    f: 0x01,
    m: hashmap,
  };

  const packed = msgpackEncode(adv);
  console.log(`${sizeKb} KB → ${totalParts} parts, adv ${packed.length} bytes, hashmap ${hashmap.length} bytes`);
}
