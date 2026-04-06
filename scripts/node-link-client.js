/**
 * Node.js RNS Link client for interop testing.
 *
 * Connects to a Python RNS TCP server, waits for the announce,
 * establishes a link, sends data, and waits for the echo response.
 *
 * Usage: node scripts/node-link-client.js <dest_hash> <port>
 *
 * Outputs JSON result on stdout.
 */

import { Transport } from '../src/Transport.js';
import { TCPClientInterface } from '../src/interfaces/TCPClientInterface.js';
import { Identity } from '../src/Identity.js';
import { Destination } from '../src/Destination.js';
import { Link } from '../src/Link.js';
import { Packet } from '../src/Packet.js';
import { fromHex, toHex, fromUtf8, equal } from '../src/utils/bytes.js';
import { setLogLevel, LOG_DEBUG } from '../src/utils/log.js';
import { DEST_SINGLE, DEST_IN } from '../src/constants.js';

setLogLevel(LOG_DEBUG);

const destHashHex = process.argv[2];
const port = parseInt(process.argv[3] || '14242', 10);

if (!destHashHex || destHashHex.length !== 32) {
  console.error('Usage: node scripts/node-link-client.js <32-char-dest-hash> [port]');
  process.exit(1);
}

async function main() {
  const transport = new Transport();
  const iface = new TCPClientInterface('Interop TCP', '127.0.0.1', port);
  transport.registerInterface(iface);

  try {
    await iface.start();
  } catch (err) {
    console.log(JSON.stringify({ status: 'error', message: `Cannot connect: ${err.message}` }));
    process.exit(1);
  }

  console.error('Connected to Python server, waiting for announce...');

  // Wait for the announce from the Python side
  const destHash = fromHex(destHashHex);
  const announcePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Announce timeout')), 15000);
    transport.on('announce', (info) => {
      if (toHex(info.destinationHash) === destHashHex) {
        clearTimeout(timeout);
        resolve(info);
      }
    });
  });

  let announceInfo;
  try {
    announceInfo = await announcePromise;
  } catch (err) {
    console.log(JSON.stringify({ status: 'error', message: err.message }));
    await iface.stop();
    process.exit(1);
  }

  console.error(`Received announce for ${destHashHex}, identity=${announceInfo.identity.hexHash}`);

  // Create a destination object for the remote peer
  const remoteDest = new Destination(
    announceInfo.identity,
    DEST_IN,
    DEST_SINGLE,
    'interop_test',
    'echo'
  );

  // Establish link
  console.error('Establishing link...');
  const link = Link.init(remoteDest, transport);
  transport.registerPendingLink(link);

  // Wait for link establishment
  const established = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 15000);
    link.on('established', () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });

  if (!established) {
    console.log(JSON.stringify({ status: 'error', message: 'Link establishment timeout' }));
    await iface.stop();
    process.exit(1);
  }

  console.error('Link established! Sending test data...');

  // Send test data
  const testData = fromUtf8('Hello from Node.js RNS!');
  await link.send(testData);

  // Wait for echo response
  const response = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 10000);
    link.on('data', (data) => {
      clearTimeout(timeout);
      resolve(data);
    });
  });

  if (response) {
    const responseText = new TextDecoder().decode(response);
    console.error(`Received echo: ${responseText}`);
    console.log(JSON.stringify({
      status: 'ok',
      sent: 'Hello from Node.js RNS!',
      received: responseText,
      link_id: toHex(link.linkId),
    }));
  } else {
    console.log(JSON.stringify({ status: 'error', message: 'Echo response timeout' }));
  }

  await link.close();
  await iface.stop();
  process.exit(0);
}

main().catch(err => {
  console.log(JSON.stringify({ status: 'error', message: err.message }));
  process.exit(1);
});
