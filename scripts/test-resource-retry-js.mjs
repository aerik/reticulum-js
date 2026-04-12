/**
 * Verify the resource watchdog/retry loop actually retries on dropped packets.
 *
 * Sets up a JS-to-JS linked pair. On the initiator → responder path, drops
 * the first N RESOURCE-context packets (parts) so the receiver's watchdog has
 * to time out and re-request. Passes if the transfer eventually completes
 * with byte-exact data.
 *
 * Usage: node scripts/test-resource-retry-js.mjs [size_kb] [drop_count]
 */

import { Link, ACCEPT_ALL } from '../src/Link.js';
import { Transport } from '../src/Transport.js';
import { Identity } from '../src/Identity.js';
import { Destination } from '../src/Destination.js';
import { EventEmitter } from '../src/utils/events.js';
import { toHex } from '../src/utils/bytes.js';
import { Packet } from '../src/Packet.js';
import { DEST_SINGLE, DEST_IN, CONTEXT_RESOURCE } from '../src/constants.js';

class MockInterface extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.online = true;
    this.peer = null;
    this.sent = [];
    this.dropResourcePartsRemaining = 0;
  }
  send(data) {
    this.sent.push(new Uint8Array(data));

    // If this is a RESOURCE-context data packet and we still have drops
    // budgeted, throw it away instead of forwarding. Parse just far enough
    // to classify.
    if (this.dropResourcePartsRemaining > 0) {
      try {
        const pkt = Packet.parse(new Uint8Array(data));
        if (pkt && pkt.context === CONTEXT_RESOURCE) {
          this.dropResourcePartsRemaining--;
          console.log(`  [drop] dropped resource part (${this.dropResourcePartsRemaining} remaining)`);
          return;
        }
      } catch (err) {
        console.log(`  [drop] parse failed: ${err.message}`);
      }
    }

    if (this.peer) {
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
  await new Promise(r => setImmediate(r));

  let responderLink = null;
  for (const [, link] of responderTransport.linkTable) {
    if (link !== initiatorLink) { responderLink = link; break; }
  }

  return { initiatorLink, responderLink, initiatorIface, responderIface };
}

const sizeKb = parseInt(process.argv[2] || '64', 10);
const dropCount = parseInt(process.argv[3] || '3', 10);
const size = sizeKb * 1024;

const { initiatorLink, responderLink, initiatorIface } = await setupLinkedPair();
console.log(`Links established. Dropping first ${dropCount} RESOURCE parts going initiator→responder, sending ${size} bytes...`);

initiatorIface.dropResourcePartsRemaining = dropCount;
responderLink.setResourceStrategy(ACCEPT_ALL);

const receivePromise = new Promise((resolve, reject) => {
  responderLink.on('resource_complete', (data) => resolve(data));
  setTimeout(() => reject(new Error('receive timeout')), 60_000);
});

const t0 = Date.now();
const data = new Uint8Array(size);
for (let i = 0; i < size; i++) data[i] = i & 0xff;

try {
  const sendPromise = initiatorLink.sendResource(data, { timeoutMs: 60_000 });
  const [bytes, received] = await Promise.all([sendPromise, receivePromise]);
  const dt = Date.now() - t0;
  console.log(`DELIVERED ${bytes} bytes in ${dt}ms, receiver got ${received.length} bytes`);

  let ok = received.length === size;
  for (let i = 0; i < size && ok; i++) if (received[i] !== (i & 0xff)) { ok = false; break; }
  console.log(`verify: ${ok ? 'OK' : 'MISMATCH'}`);
  process.exit(ok ? 0 : 1);
} catch (err) {
  const dt = Date.now() - t0;
  console.log(`FAILED in ${dt}ms: ${err.message}`);
  process.exit(1);
}
