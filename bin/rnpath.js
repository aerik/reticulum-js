#!/usr/bin/env node

/**
 * rnpath — request and display path to a destination.
 *
 * Usage: rnpath <destination_hash> [--config <dir>] [--timeout <ms>]
 *
 * Connects to configured interfaces, sends a path request,
 * and displays the result.
 */

import { Reticulum } from '../src/Reticulum.js';
import { resolveConfigDir, loadConfig } from '../src/utils/config.js';
import { fromHex, toHex } from '../src/utils/bytes.js';
import { setLogLevel, LOG_WARNING } from '../src/utils/log.js';

const args = process.argv.slice(2);

function parseArg(flag, defaultVal) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : defaultVal;
}

const destHex = args.find(a => !a.startsWith('--'));
const configDir = parseArg('--config', null);
const timeout = parseInt(parseArg('--timeout', '15000'), 10);

if (!destHex || destHex.length !== 32) {
  console.error('Usage: rnpath <32-char hex destination hash> [--config <dir>] [--timeout <ms>]');
  console.error('Example: rnpath ff41470c0c58afeb129103a5753bbc0f');
  process.exit(1);
}

setLogLevel(LOG_WARNING);

async function main() {
  const dir = await resolveConfigDir(configDir);
  const config = await loadConfig(dir);
  config.configDir = dir;

  console.log(`Looking up path to ${destHex}...`);

  const rns = new Reticulum(config);
  await rns.start();

  if (rns._interfaces.length === 0) {
    console.error('No interfaces available. Check your config.');
    await rns.stop();
    process.exit(1);
  }

  console.log(`Connected via ${rns._interfaces.length} interface(s). Requesting path...`);

  const destHash = fromHex(destHex);

  // Check if we already know this destination
  const existing = rns.transport.pathTable.get(destHex);
  if (existing) {
    printPath(destHex, existing, rns);
    await rns.stop();
    return;
  }

  // Listen for the announce that serves as path response
  rns.transport.on('announce', (info) => {
    if (toHex(info.destinationHash) === destHex) {
      console.log(`\nPath found via announce:`);
      printAnnounce(info);
    }
  });

  const found = await rns.requestPath(destHash, timeout);

  if (found) {
    const path = rns.transport.pathTable.get(destHex);
    if (path) printPath(destHex, path, rns);
  } else {
    console.log(`\nNo path found within ${timeout / 1000}s.`);
  }

  await rns.stop();
}

function printPath(hex, path, rns) {
  console.log(`\nPath to ${hex}:`);
  console.log(`  Hops     : ${path.hops}`);
  console.log(`  Interface: ${path.interface?.name || '(unknown)'}`);
  const remaining = Math.floor(path.expires - Date.now() / 1000);
  console.log(`  Expires  : ${Math.floor(remaining / 3600)}h ${Math.floor((remaining % 3600) / 60)}m`);

  const identity = rns.getIdentity(fromHex(hex));
  if (identity) {
    console.log(`  Identity : ${identity.hexHash}`);
  }
}

function printAnnounce(info) {
  console.log(`  Destination: ${toHex(info.destinationHash)}`);
  console.log(`  Identity   : ${info.identity.hexHash}`);
  console.log(`  Hops       : ${info.hops}`);
  if (info.appData) {
    try {
      const text = new TextDecoder().decode(info.appData);
      if (/^[\x20-\x7E]+$/.test(text)) {
        console.log(`  App data   : ${text}`);
      } else {
        console.log(`  App data   : (${info.appData.length} bytes)`);
      }
    } catch {
      console.log(`  App data   : (${info.appData.length} bytes)`);
    }
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
