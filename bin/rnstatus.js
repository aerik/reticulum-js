#!/usr/bin/env node

/**
 * rnstatus — show Reticulum node status.
 *
 * Displays interfaces, path table, announce cache, and statistics.
 *
 * Usage: rnstatus [--config <dir>] [--json]
 */

import { Reticulum } from '../src/Reticulum.js';
import { resolveConfigDir, loadConfig } from '../src/utils/config.js';
import { Storage } from '../src/utils/storage.js';
import { toHex } from '../src/utils/bytes.js';
import { setLogLevel, LOG_CRITICAL } from '../src/utils/log.js';

setLogLevel(LOG_CRITICAL); // suppress log noise

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const configIdx = args.indexOf('--config');
const configDir = configIdx !== -1 ? args[configIdx + 1] : null;

async function main() {
  const dir = await resolveConfigDir(configDir);
  const config = await loadConfig(dir);
  const storage = new Storage(dir);
  await storage.init();

  const identity = await storage.loadTransportIdentity();
  const knownDests = await storage.loadKnownDestinations();
  const pathTable = await storage.loadPathTable();
  const hashlist = await storage.loadHashlist();

  if (jsonOutput) {
    const data = {
      configDir: dir,
      identity: identity ? identity.hexHash : null,
      transport: config.reticulum.enable_transport,
      interfaces: config.interfaces.map(i => ({
        name: i.name,
        type: i.type,
        enabled: i.enabled,
      })),
      knownDestinations: knownDests.size,
      pathTableEntries: pathTable.length,
      packetHashlistSize: hashlist.size,
    };
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log('Reticulum Node.js Status');
  console.log('========================\n');

  console.log(`Config directory : ${dir}`);
  console.log(`Transport enabled: ${config.reticulum.enable_transport}`);

  if (identity) {
    console.log(`Transport identity: ${identity.hexHash}`);
  } else {
    console.log('Transport identity: (not generated yet)');
  }

  console.log(`\nInterfaces (${config.interfaces.length}):`);
  if (config.interfaces.length === 0) {
    console.log('  (none configured)');
  }
  for (const iface of config.interfaces) {
    const status = iface.enabled ? 'enabled' : 'disabled';
    const details = [];
    if (iface.target_host) details.push(`${iface.target_host}:${iface.target_port}`);
    if (iface.bind_port) details.push(`port ${iface.bind_port}`);
    if (iface.networkname) details.push('IFAC');
    console.log(`  [${status}] ${iface.name || '(unnamed)'} (${iface.type})${details.length ? ' — ' + details.join(', ') : ''}`);
  }

  console.log(`\nKnown destinations: ${knownDests.size}`);
  if (knownDests.size > 0 && knownDests.size <= 20) {
    for (const [hex, entry] of knownDests) {
      const age = Math.floor(Date.now() / 1000 - entry.timestamp);
      const ageStr = age < 3600 ? `${age}s` : age < 86400 ? `${Math.floor(age / 3600)}h` : `${Math.floor(age / 86400)}d`;
      console.log(`  ${hex.slice(0, 20)}.. (${ageStr} ago)`);
    }
  }

  console.log(`Path table entries: ${pathTable.length}`);
  if (pathTable.length > 0 && pathTable.length <= 20) {
    for (const entry of pathTable) {
      const [hexHash, _ts, _nextHop, hops, expires, , ifaceName] = entry;
      const remaining = Math.floor(expires - Date.now() / 1000);
      const expStr = remaining > 0 ? `${Math.floor(remaining / 3600)}h remaining` : 'expired';
      console.log(`  ${hexHash.slice(0, 20)}.. hops=${hops} via=${ifaceName || '?'} (${expStr})`);
    }
  }

  console.log(`Packet hashlist: ${hashlist.size} entries`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
