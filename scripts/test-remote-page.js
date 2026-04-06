/**
 * Test fetching a page from a real NomadNet node on the network.
 *
 * Connects via WebSocket bridge, waits for NomadNet announces,
 * tries to establish a link and fetch a page with generous timeouts.
 *
 * Usage: node scripts/test-remote-page.js [ws-url] [wait-seconds]
 *
 * Requires the chat-server.py bridge to be running.
 */

import { Transport } from '../src/Transport.js';
import { WebSocketClientInterface } from '../src/interfaces/WebSocketInterface.js';
import { Identity } from '../src/Identity.js';
import { Destination } from '../src/Destination.js';
import { Link } from '../src/Link.js';
import { toHex, fromUtf8 } from '../src/utils/bytes.js';
import { setLogLevel, LOG_INFO, LOG_DEBUG } from '../src/utils/log.js';
import { DEST_SINGLE, DEST_IN } from '../src/constants.js';

setLogLevel(LOG_INFO);

const WS_URL = process.argv[2] || 'ws://127.0.0.1:8765';
const WAIT_FOR_ANNOUNCES = parseInt(process.argv[3] || '60', 10) * 1000;
const LINK_TIMEOUT = 60000;  // 60 seconds for multi-hop link establishment
const PAGE_TIMEOUT = 60000;  // 60 seconds for page fetch (includes Resource transfer)

async function main() {
  const transport = new Transport();
  const ws = new WebSocketClientInterface('Test', WS_URL);
  transport.registerInterface(ws);

  // Collect NomadNet nodes
  const nomadNodes = new Map();

  transport.on('announce', (info) => {
    const hex = toHex(info.destinationHash);
    let app = '';
    if (info.appData) try { app = new TextDecoder().decode(info.appData); } catch {}

    // Try to match nomadnetwork.node
    const testDest = new Destination(info.identity, DEST_IN, DEST_SINGLE, 'nomadnetwork', 'node');
    if (toHex(testDest.hash) === hex) {
      nomadNodes.set(hex, { identity: info.identity, app, hops: info.hops, dest: testDest });
      console.log(`  [NomadNet] ${app || hex.slice(0,16)} (${info.hops} hops)`);
    }
  });

  try {
    await ws.start();
  } catch (e) {
    console.error('Cannot connect to bridge:', e.message);
    console.error('Start the bridge: python examples/chat-server.py --rns-host vps001.vanheusden.com');
    process.exit(1);
  }

  console.log(`Connected to ${WS_URL}`);
  console.log(`Waiting ${WAIT_FOR_ANNOUNCES/1000}s for NomadNet announces...\n`);

  await new Promise(r => setTimeout(r, WAIT_FOR_ANNOUNCES));

  if (nomadNodes.size === 0) {
    console.log('\nNo NomadNet nodes found. Try waiting longer or check bridge connection.');
    await ws.stop();
    process.exit(1);
  }

  // Sort by hops (try closest first), skip local (1-hop) nodes
  const sorted = [...nomadNodes.entries()]
    .filter(([, n]) => n.hops > 1)
    .sort((a, b) => a[1].hops - b[1].hops);

  console.log(`\n=== Found ${sorted.length} NomadNet nodes ===\n`);
  for (const [hex, node] of sorted) {
    console.log(`  ${hex.slice(0,20)}.. "${node.app}" (${node.hops} hops)`);
  }

  // Try each node, starting with the closest
  for (const [hex, node] of sorted) {
    console.log(`\n--- Trying: ${node.app || hex.slice(0,16)} (${node.hops} hops) ---`);

    // Step 1: Establish link
    console.log(`  Establishing link (timeout: ${LINK_TIMEOUT/1000}s)...`);
    const link = Link.init(node.dest, transport);
    transport.registerPendingLink(link);

    const established = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), LINK_TIMEOUT);
      link.on('established', () => { clearTimeout(t); resolve(true); });
    });

    if (!established) {
      console.log('  FAILED: Link establishment timed out');
      continue;
    }

    console.log(`  Link established! ID: ${toHex(link.linkId).slice(0,16)}..`);

    // Step 2: Fetch page
    console.log(`  Fetching /page/index.mu (timeout: ${PAGE_TIMEOUT/1000}s)...`);
    const startTime = Date.now();
    const response = await link.request('/page/index.mu', null, PAGE_TIMEOUT);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (response) {
      const text = new TextDecoder().decode(response);
      console.log(`  SUCCESS! Got ${response.length} bytes in ${elapsed}s`);
      console.log('  ---PAGE START---');
      console.log(text.slice(0, 500));
      if (text.length > 500) console.log(`  ...(${text.length - 500} more bytes)`);
      console.log('  ---PAGE END---');

      await link.close();
      await ws.stop();
      console.log('\nDone.');
      process.exit(0);
    } else {
      console.log(`  FAILED: Page fetch timed out after ${elapsed}s`);
      if (link._activeResource) {
        const r = link._activeResource;
        console.log(`  (Resource: ${r.receivedParts}/${r.totalParts} parts, status=${r.status})`);
      }
      await link.close();
    }
  }

  console.log('\nAll nodes failed. This may be a network routing issue.');
  await ws.stop();
  process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
