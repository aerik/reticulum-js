/**
 * Connect to the RNS testnet and listen for announces.
 *
 * Usage: node scripts/connect-testnet.js
 *
 * This connects to dublin.connect.reticulum.network:4965 and prints
 * every announce it receives. After 30 seconds, it sends its own
 * announce and waits 30 more seconds before disconnecting.
 */

import { Reticulum, Identity, Destination, DEST_SINGLE, DEST_IN } from '../src/Reticulum.js';
import { toHex } from '../src/utils/bytes.js';
import { setLogLevel, LOG_VERBOSE } from '../src/utils/log.js';

setLogLevel(LOG_VERBOSE);

async function main() {
  console.log('=== Reticulum Node.js — Testnet Connection Test ===\n');

  // Create a Reticulum instance
  const rns = new Reticulum({
    enableTransport: false,
    interfaces: [
      {
        name: 'Dublin Testnet',
        type: 'TCPClientInterface',
        enabled: true,
        target_host: 'dublin.connect.reticulum.network',
        target_port: 4965,
      },
    ],
  });

  // Listen for announces
  let announceCount = 0;
  rns.transport.on('announce', (info) => {
    announceCount++;
    const destHex = toHex(info.destinationHash);
    const idHex = info.identity.hexHash;
    const appDataStr = info.appData ? new TextDecoder().decode(info.appData) : '(none)';

    console.log(`\n📡 Announce #${announceCount}:`);
    console.log(`   Destination: ${destHex}`);
    console.log(`   Identity:    ${idHex}`);
    console.log(`   Hops:        ${info.hops}`);
    console.log(`   App Data:    ${appDataStr}`);
    console.log(`   Timestamp:   ${new Date(info.timestamp * 1000).toISOString()}`);
  });

  // Start
  console.log('Connecting to Dublin testnet...');
  await rns.start();
  console.log('Connected! Listening for announces...\n');

  // Wait 30 seconds, collecting announces
  await new Promise(resolve => setTimeout(resolve, 30000));

  console.log(`\n--- Received ${announceCount} announces in 30 seconds ---\n`);

  // Create our own identity and destination
  const identity = Identity.generate();
  const dest = new Destination(identity, DEST_IN, DEST_SINGLE, 'rns_node_js', 'test');

  console.log(`Our identity:    ${identity.hexHash}`);
  console.log(`Our destination: ${toHex(dest.hash)}`);
  console.log('Sending announce...\n');

  // Send our announce
  const appData = new TextEncoder().encode('Node.js RNS v0.1');
  rns.announce(dest, appData);

  // Wait another 30 seconds
  console.log('Waiting 30 more seconds...');
  await new Promise(resolve => setTimeout(resolve, 30000));

  console.log(`\n--- Total announces received: ${announceCount} ---`);
  console.log('Stats:', rns.getStats());

  // Cleanup
  await rns.stop();
  console.log('\nDone.');
}

main().catch(console.error);
