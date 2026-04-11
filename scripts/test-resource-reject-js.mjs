/**
 * Verify RCL (resource reject) handling on the sender side.
 *
 * Sets up a JS-to-JS linked pair like test-big-resource-js.mjs, but replaces
 * the responder's _handleResourceAdv with a stub that immediately sends a
 * RESOURCE_RCL packet back to the sender (mimicking Python LXMF rejecting an
 * oversized resource). The test passes if sendResource() rejects promptly
 * with a clear error instead of waiting out its 120s timeout.
 */

import { Link } from '../src/Link.js';
import { Transport } from '../src/Transport.js';
import { Identity } from '../src/Identity.js';
import { Destination } from '../src/Destination.js';
import { EventEmitter } from '../src/utils/events.js';
import { toHex } from '../src/utils/bytes.js';
import { DEST_SINGLE, DEST_IN, CONTEXT_RESOURCE_RCL } from '../src/constants.js';
import { ResourceReceiver } from '../src/Resource.js';

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
    if (this.peer) setImmediate(() => this.peer.emit('packet', new Uint8Array(data)));
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

  return { initiatorLink, responderLink };
}

const { initiatorLink, responderLink } = await setupLinkedPair();
console.log('Links established. Installing RCL stub on responder...');

// Replace responder's resource-adv handler with one that parses just enough
// to extract the resource hash, then sends RESOURCE_RCL back — matching
// Python's RNS.Resource.reject() flow.
responderLink._handleResourceAdv = function(plaintext) {
  const receiver = new ResourceReceiver(this, plaintext);
  console.log(`Responder: parsed adv, hash=${toHex(receiver.hash).slice(0,16)}.., sending RCL`);
  // Send RCL packet (resource_hash as payload, encrypted per-packet).
  this.send(receiver.hash, CONTEXT_RESOURCE_RCL).catch(err => {
    console.log(`Responder: failed to send RCL: ${err.message}`);
  });
};

const size = 32 * 1024; // small — we don't care about transfer, only the reject path
const data = new Uint8Array(size);
for (let i = 0; i < size; i++) data[i] = i & 0xff;

const t0 = Date.now();
try {
  await initiatorLink.sendResource(data, { timeoutMs: 10_000 });
  console.log(`UNEXPECTED: sendResource resolved in ${Date.now()-t0}ms`);
  process.exit(1);
} catch (err) {
  const dt = Date.now() - t0;
  if (dt > 5000) {
    console.log(`FAILED: sendResource took too long to reject (${dt}ms): ${err.message}`);
    process.exit(1);
  }
  if (!/reject/i.test(err.message)) {
    console.log(`FAILED: sendResource rejected in ${dt}ms but with wrong error: ${err.message}`);
    process.exit(1);
  }
  console.log(`OK: sendResource rejected in ${dt}ms with "${err.message}"`);
  process.exit(0);
}
