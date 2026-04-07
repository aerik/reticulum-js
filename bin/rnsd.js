#!/usr/bin/env node

/**
 * rnsd — Reticulum Network Stack daemon.
 *
 * Starts a Reticulum transport node that routes packets, propagates
 * announces, and maintains path tables. Equivalent to Python's rnsd.
 *
 * Usage:
 *   rnsd                          # Start with default config
 *   rnsd --config <dir>           # Start with specific config directory
 *   rnsd --verbose                # Increase log verbosity
 *   rnsd --version                # Show version
 *
 * Config is loaded from (in order):
 *   1. --config <dir> argument
 *   2. ~/.config/reticulum/ (Linux/macOS)
 *   3. ~/.reticulum/
 *
 * If no config exists, a default one is generated on first run.
 * The default config enables transport and listens for TCP connections.
 */

import { Reticulum } from '../src/Reticulum.js';
import { resolveConfigDir, loadConfig } from '../src/utils/config.js';
import { setLogLevel, LOG_INFO, LOG_VERBOSE, LOG_DEBUG, LOG_EXTREME } from '../src/utils/log.js';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Parse arguments
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`rnsd — Reticulum Network Stack daemon

Usage:
  rnsd                          Start with default config
  rnsd --config <dir>           Start with specific config directory
  rnsd --verbose, -v            Increase log verbosity
  rnsd --extra-verbose, -vv     Maximum log verbosity
  rnsd --version                Show version
  rnsd --help, -h               Show this help

Config is loaded from:
  1. --config <dir> argument
  2. ~/.config/reticulum/ (Linux/macOS)
  3. ~/.reticulum/

If no config exists, a default one is generated.`);
  process.exit(0);
}

if (args.includes('--version')) {
  try {
    const pkg = JSON.parse(await readFile(join(__dirname, '..', 'package.json'), 'utf-8'));
    console.log(`rnsd ${pkg.version} (reticulum-js)`);
  } catch {
    console.log('rnsd (reticulum-js)');
  }
  process.exit(0);
}

const configIdx = args.indexOf('--config');
const configDir = configIdx !== -1 ? args[configIdx + 1] : null;

// Set log level based on verbosity flags
if (args.includes('-vv') || args.includes('--extra-verbose')) {
  setLogLevel(LOG_EXTREME);
} else if (args.includes('-v') || args.includes('--verbose')) {
  setLogLevel(LOG_VERBOSE);
}

async function main() {
  const dir = await resolveConfigDir(configDir);
  const config = await loadConfig(dir);
  config.configDir = dir;

  // Force transport enabled — rnsd is always a transport node
  if (!config.reticulum) config.reticulum = {};
  config.reticulum.enable_transport = true;

  console.log(`rnsd — Reticulum Transport Node`);
  console.log(`  Config: ${dir}`);
  console.log(`  Transport: enabled`);

  const rns = new Reticulum(config);
  await rns.start();

  const ifaces = rns._interfaces;
  console.log(`  Interfaces: ${ifaces.length}`);
  for (const iface of ifaces) {
    console.log(`    ${iface.name} (${iface.online ? 'online' : 'offline'})`);
  }
  console.log(`  Identity: ${rns.identity.hexHash}`);
  console.log();
  console.log(`Node is running. Press Ctrl+C to stop.`);

  // Periodic stats
  const statsInterval = setInterval(() => {
    const t = rns.transport;
    const uptime = process.uptime();
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const s = Math.floor(uptime % 60);
    console.log(
      `[${h}h${m}m${s}s] ` +
      `rx:${t.stats.packetsReceived} tx:${t.stats.packetsSent} ` +
      `fwd:${t.stats.packetsForwarded} ann:${t.stats.announcesValidated} ` +
      `dup:${t.stats.duplicatesDropped} ` +
      `paths:${t.pathTable.size} links:${t.linkTable.size}`
    );
  }, 60000);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    clearInterval(statsInterval);
    await rns.stop();
    console.log('Stopped.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
