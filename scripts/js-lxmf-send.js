/**
 * JS LXMF sender for interop testing.
 *
 * Connects to the public RNS network via TCP, registers an LXMF delivery
 * identity, looks up the target destination via path request, and sends a
 * message via the chosen method (opportunistic / direct / propagated).
 *
 * Usage:
 *   node scripts/js-lxmf-send.js <dest_hash> [options]
 *
 * Options:
 *   --rns-host <host>       RNS network host (default: rns.noderage.org)
 *   --rns-port <port>       RNS network port (default: 4242)
 *   --method <name>         opportunistic | direct | propagated (default: opportunistic)
 *   --title <text>          Message title (default: "JS Interop Test")
 *   --content <text>        Message body (default: "Hello from JS LXMF!")
 *   --propagation <hash>    Propagation node hash (required for --method propagated)
 *   --timeout <seconds>     Max wait for delivery (default: 60)
 *
 * Example (with the Python receiver running):
 *   node scripts/js-lxmf-send.js a1b2c3d4e5f6...  --method opportunistic
 */

import { Reticulum } from '../src/Reticulum.js';
import { LXMRouter } from '../src/lxmf/LXMRouter.js';
import {
  LXMessage,
  OPPORTUNISTIC, DIRECT, PROPAGATED,
  OUTBOUND, SENDING, SENT, DELIVERED, FAILED,
} from '../src/lxmf/LXMessage.js';
import { toHex, fromHex } from '../src/utils/bytes.js';
import { setLogLevel, LOG_INFO, LOG_VERBOSE } from '../src/utils/log.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STATE_NAMES = {
  [OUTBOUND]: 'OUTBOUND',
  [SENDING]:  'SENDING',
  [SENT]:     'SENT',
  [DELIVERED]: 'DELIVERED',
  [FAILED]:   'FAILED',
};

const METHOD_NAMES = {
  [OPPORTUNISTIC]: 'opportunistic',
  [DIRECT]:        'direct',
  [PROPAGATED]:    'propagated',
};

function parseArgs(argv) {
  const args = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      args[a.slice(2)] = argv[++i];
    } else {
      args.positional.push(a);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const destHashHex = (args.positional[0] || '').replace(/\s+/g, '');

  if (!/^[0-9a-f]{32}$/i.test(destHashHex)) {
    console.error('Usage: node scripts/js-lxmf-send.js <dest_hash> [--method ...] [--title ...] [--content ...]');
    console.error('  dest_hash must be 32 hex characters');
    process.exit(1);
  }

  const rnsHost = args['rns-host'] || 'rns.noderage.org';
  const rnsPort = parseInt(args['rns-port'] || '4242', 10);
  const methodName = (args.method || 'opportunistic').toLowerCase();
  const title = args.title || 'JS Interop Test';
  const content = args.content || 'Hello from JS LXMF!';
  const timeoutSec = parseInt(args.timeout || '60', 10);
  const propHashHex = args.propagation;

  const methodMap = { opportunistic: OPPORTUNISTIC, direct: DIRECT, propagated: PROPAGATED };
  const desiredMethod = methodMap[methodName];
  if (!desiredMethod) {
    console.error(`Invalid --method: ${methodName} (expected opportunistic/direct/propagated)`);
    process.exit(1);
  }
  if (desiredMethod === PROPAGATED && !/^[0-9a-f]{32}$/i.test(propHashHex || '')) {
    console.error('--propagation <hash> required for propagated method');
    process.exit(1);
  }

  setLogLevel(args.verbose ? LOG_VERBOSE : LOG_INFO);

  console.log('=== JS LXMF Sender ===');
  console.log(`  Network : ${rnsHost}:${rnsPort}`);
  console.log(`  Target  : ${destHashHex}`);
  console.log(`  Method  : ${methodName}`);
  console.log();

  // Start a Reticulum node connected to the public network. We need a
  // configDir so a transport identity is loaded/generated and persisted.
  const configDir = args['config-dir'] || join(__dirname, '.lxmf_send_config');
  const rns = new Reticulum({
    configDir,
    enableTransport: false,
    interfaces: [{
      name: 'RNS Network',
      type: 'TCPClientInterface',
      enabled: true,
      target_host: rnsHost,
      target_port: rnsPort,
    }],
  });
  rns.configDir = configDir; // Reticulum.start() reads this.configDir
  await rns.start();
  console.log(`  Identity: ${rns.identity.hexHash}`);

  // LXMF router
  const router = new LXMRouter(rns.transport, {
    deliveryRetryWait: 5_000,
    maxDeliveryAttempts: 6,
  });
  const senderDest = router.registerDeliveryIdentity(rns.identity, { displayName: 'JS Test Sender' });
  console.log(`  Sender delivery dest: ${toHex(senderDest.hash)}`);
  console.log();

  // Announce so the receiver knows our source identity (needed for sig verify)
  router.announceAll();

  // Wait briefly for announces to propagate AND request a path to the target
  console.log(`Requesting path to ${destHashHex}...`);
  const targetHash = fromHex(destHashHex);
  rns.transport.requestPath(targetHash);

  // Wait until we have an identity AND a path for the target (or timeout)
  const pathDeadline = Date.now() + timeoutSec * 1000;
  let lastReq = Date.now();
  while (Date.now() < pathDeadline) {
    const haveIdentity = rns.transport.getIdentity(targetHash) !== null;
    const havePath = rns.transport.pathTable.has(destHashHex);
    if (haveIdentity && havePath) break;
    if (Date.now() - lastReq > 8_000) {
      rns.transport.requestPath(targetHash);
      lastReq = Date.now();
    }
    await new Promise(r => setTimeout(r, 500));
  }

  const haveIdentity = rns.transport.getIdentity(targetHash) !== null;
  const havePath = rns.transport.pathTable.has(destHashHex);
  if (!haveIdentity || !havePath) {
    console.error(`  ERROR: Could not resolve target after ${timeoutSec}s ` +
                  `(identity=${haveIdentity}, path=${havePath})`);
    console.error('  Make sure the receiver has announced and we are on the same network.');
    process.exit(1);
  }
  console.log('  Target resolved (identity + path known).');
  console.log();

  // Build the LXMessage
  const msg = new LXMessage({
    destinationHash: targetHash,
    title,
    content,
    desiredMethod,
  });

  // Track state transitions
  msg.deliveryCallback = (m) => {
    console.log(`  -> deliveryCallback: state=${STATE_NAMES[m.state] || m.state}`);
  };
  msg.failedCallback = (m) => {
    console.log(`  -> failedCallback: state=${STATE_NAMES[m.state] || m.state}`);
  };

  console.log(`Sending: "${title}" — "${content}"`);
  const sendOpts = {};
  if (desiredMethod === PROPAGATED) sendOpts.propagationNodeHash = fromHex(propHashHex);
  router.handleOutbound(msg, sendOpts);

  console.log(`  Queued as ${toHex(msg.hash).slice(0, 16)}.. (method=${METHOD_NAMES[msg.method]}, ${msg.packed.length}b)`);
  console.log();

  // Poll state until terminal
  const sendDeadline = Date.now() + timeoutSec * 1000;
  let lastState = null;
  while (Date.now() < sendDeadline) {
    if (msg.state !== lastState) {
      console.log(`  state: ${STATE_NAMES[msg.state] || `0x${msg.state?.toString(16)}`}`);
      lastState = msg.state;
    }
    if (msg.state === DELIVERED || msg.state === SENT || msg.state === FAILED) break;
    await new Promise(r => setTimeout(r, 500));
  }

  console.log();
  if (msg.state === DELIVERED) {
    console.log('  SUCCESS: message DELIVERED (proof received)');
  } else if (msg.state === SENT) {
    console.log('  SENT: message transmitted (no delivery proof for this method)');
  } else if (msg.state === FAILED) {
    console.log('  FAILED: delivery did not complete');
    process.exitCode = 2;
  } else {
    console.log(`  TIMEOUT: state=${STATE_NAMES[msg.state] || msg.state}`);
    process.exitCode = 3;
  }

  // Allow async cleanup, then exit
  router.stop();
  await rns.stop();
  setTimeout(() => process.exit(process.exitCode || 0), 500);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
