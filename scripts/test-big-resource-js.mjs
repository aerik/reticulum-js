/**
 * JS-to-JS resource transfer stress test.
 *
 * Wires two Links through in-memory MockInterface pairs and runs a full
 * Resource transfer through them — advertisement, HMU cycles, parts, proof.
 * Lets us test large resource sizes without involving Python or TCP.
 */

import { Link, ACCEPT_ALL } from '../src/Link.js';
import { Transport } from '../src/Transport.js';
import { Identity } from '../src/Identity.js';
import { Destination } from '../src/Destination.js';
import { EventEmitter } from '../src/utils/events.js';
import { toHex } from '../src/utils/bytes.js';
import { DEST_SINGLE, DEST_IN } from '../src/constants.js';

class MockInterface extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.online = true;
    this.peer = null;
    this.sent = [];
  }
  send(data) {
    this.sent.push(new Uint8Array(data));
    // Pipe directly into peer as if received over the wire.
    if (this.peer) {
      // Use setImmediate so we don't blow the stack on large bursts.
      setImmediate(() => this.peer.emit('packet', new Uint8Array(data)));
    }
  }
}

async function setupLinkedPair() {
  const responderIdentity = Identity.generate();
  const responderDest = new Destination(responderIdentity, DEST_IN, DEST_SINGLE, 'test', 'res');

  const responderIface = new MockInterface('responder');
  const responderTransport = new Transport();
  responderTransport.registerInterface(responderIface);
  responderTransport.registerDestination(responderDest);
  responderDest.setLinkCallback(() => true);

  const initiatorIface = new MockInterface('initiator');
  const initiatorTransport = new Transport();
  initiatorTransport.registerInterface(initiatorIface);

  initiatorIface.peer = responderIface;
  responderIface.peer = initiatorIface;

  initiatorTransport.announceTable.set(toHex(responderDest.hash), {
    identity: Identity.fromPublicKey(responderIdentity.publicKey),
    appData: null, hops: 1, timestamp: Date.now() / 1000,
  });

  const initiatorLink = Link.init(responderDest, initiatorTransport);
  initiatorTransport.registerPendingLink(initiatorLink);

  await new Promise(r => initiatorLink.on('established', r));
  // Give responder side a tick to wire up its own link.
  await new Promise(r => setImmediate(r));

  let responderLink = null;
  for (const [, link] of responderTransport.linkTable) {
    if (link !== initiatorLink) { responderLink = link; break; }
  }

  return { initiatorLink, responderLink };
}

const sizeKb = parseInt(process.argv[2] || '500', 10);
const size = sizeKb * 1024;

const { initiatorLink, responderLink } = await setupLinkedPair();
console.log(`Links established. Sending ${size} bytes...`);

responderLink.setResourceStrategy(ACCEPT_ALL);
const receivePromise = new Promise((resolve, reject) => {
  responderLink.on('resource_complete', (data) => resolve(data));
  setTimeout(() => reject(new Error('receive timeout')), 120_000);
});

const t0 = Date.now();
const data = new Uint8Array(size);
for (let i = 0; i < size; i++) data[i] = i & 0xff;

try {
  const sendPromise = initiatorLink.sendResource(data, {
    onProgress: (p) => {
      if (Math.floor(p * 10) !== Math.floor((p - 0.001) * 10)) {
        console.log(`  progress: ${Math.round(p * 100)}%`);
      }
    },
  });

  const [bytes, received] = await Promise.all([sendPromise, receivePromise]);
  const dt = Date.now() - t0;
  console.log(`DELIVERED ${bytes} bytes in ${dt}ms, receiver got ${received.length} bytes`);

  // Verify
  let ok = received.length === size;
  for (let i = 0; i < size && ok; i++) if (received[i] !== (i & 0xff)) { ok = false; break; }
  console.log(`verify: ${ok ? 'OK' : 'MISMATCH'}`);
  process.exit(ok ? 0 : 1);
} catch (err) {
  const dt = Date.now() - t0;
  console.log(`FAILED in ${dt}ms: ${err.message}`);
  const receiver = responderLink._activeResource;
  if (receiver) {
    console.log(`  receiver: ${receiver.receivedParts}/${receiver.totalParts} parts, height=${receiver.hashmapHeight}, waiting_hmu=${receiver.waitingForHmu}`);
  }
  process.exit(1);
}
