/**
 * Quick test: connect to the RNS testnet and listen for 15 seconds.
 * Reports what we receive and validates announces.
 */

import { Transport } from '../src/Transport.js';
import { TCPClientInterface } from '../src/interfaces/TCPClientInterface.js';
import { Identity } from '../src/Identity.js';
import { Destination } from '../src/Destination.js';
import { Packet } from '../src/Packet.js';
import { createAnnounce } from '../src/Announce.js';
import { toHex } from '../src/utils/bytes.js';
import { setLogLevel, LOG_INFO } from '../src/utils/log.js';
import { DEST_SINGLE, DEST_IN } from '../src/constants.js';

setLogLevel(LOG_INFO);

async function main() {
  console.log('Connecting to dublin.connect.reticulum.network:4965...');

  const transport = new Transport();
  const iface = new TCPClientInterface(
    'Beleth', 'rns.beleth.net', 4242
  );
  transport.registerInterface(iface);

  let announceCount = 0;
  let rawPacketCount = 0;

  // Count raw packets from the interface
  iface.on('packet', () => { rawPacketCount++; });

  transport.on('announce', (info) => {
    announceCount++;
    const appStr = info.appData
      ? tryDecode(info.appData)
      : '';
    console.log(`  ANNOUNCE #${announceCount}: dest=${toHex(info.destinationHash).slice(0, 16)}.. id=${info.identity.hexHash.slice(0, 16)}.. hops=${info.hops}${appStr ? ' app="' + appStr + '"' : ''}`);
  });

  try {
    await iface.start();
    console.log('Connected! Listening for 15 seconds...\n');
  } catch (err) {
    console.error('Connection failed:', err.message);
    process.exit(1);
  }

  // Wait 15 seconds
  await sleep(15000);

  console.log(`\n--- Results ---`);
  console.log(`Raw packets received: ${rawPacketCount}`);
  console.log(`Announces validated:  ${announceCount}`);
  console.log(`Stats:`, transport.stats);

  // Now send our own announce
  console.log('\nSending our announce...');
  const identity = Identity.generate();
  const dest = new Destination(identity, DEST_IN, DEST_SINGLE, 'rns_nodejs', 'test');
  const pkt = createAnnounce(dest, new TextEncoder().encode('NodeJS-RNS-0.1'));
  transport.transmit(pkt);
  console.log(`Sent announce: dest=${toHex(dest.hash)} id=${identity.hexHash}`);

  // Wait 5 more seconds to see if any response
  await sleep(5000);

  console.log(`\nFinal stats:`, transport.stats);
  await iface.stop();
  console.log('Done.');
  process.exit(0);
}

function tryDecode(bytes) {
  try {
    const s = new TextDecoder().decode(bytes);
    // Only return if it's printable
    if (/^[\x20-\x7E]+$/.test(s)) return s;
    return `(${bytes.length} bytes)`;
  } catch {
    return `(${bytes.length} bytes)`;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
