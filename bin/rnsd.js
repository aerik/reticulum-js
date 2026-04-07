#!/usr/bin/env node

/**
 * rnsd — Reticulum Network Stack daemon with LXMF messaging.
 *
 * Starts a Reticulum transport node that routes packets, propagates
 * announces, and maintains path tables. Optionally enables LXMF
 * messaging with a built-in HTTP API for message retrieval.
 *
 * Usage:
 *   rnsd                          # Start with default config
 *   rnsd --config <dir>           # Start with specific config directory
 *   rnsd --lxmf                   # Enable LXMF delivery + propagation
 *   rnsd --lxmf --http 8080       # Enable LXMF with HTTP API on port 8080
 *   rnsd --verbose                # Increase log verbosity
 *   rnsd --version                # Show version
 */

import { Reticulum } from '../src/Reticulum.js';
import { resolveConfigDir, loadConfig } from '../src/utils/config.js';
import { setLogLevel, LOG_INFO, LOG_VERBOSE, LOG_DEBUG, LOG_EXTREME } from '../src/utils/log.js';
import { toHex } from '../src/utils/bytes.js';
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
  rnsd --lxmf                   Enable LXMF delivery + propagation
  rnsd --lxmf --http <port>     Enable LXMF with HTTP message API (default: 4281)
  rnsd --verbose, -v            Increase log verbosity
  rnsd --extra-verbose, -vv     Maximum log verbosity
  rnsd --version                Show version
  rnsd --help, -h               Show this help

LXMF HTTP API endpoints (when --http is enabled):
  GET /api/messages              List received messages (JSON)
  GET /api/messages/:id          Get a specific message
  GET /api/stats                 Node and LXMF stats
  GET /                          Web interface for browsing messages`);
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
const enableLxmf = args.includes('--lxmf');
const httpIdx = args.indexOf('--http');
const httpPort = httpIdx !== -1 ? parseInt(args[httpIdx + 1] || '4281', 10) : (enableLxmf ? 4281 : 0);

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

  // --- LXMF ---
  let router = null;
  if (enableLxmf) {
    const { LXMRouter } = await import('../src/lxmf/LXMRouter.js');
    router = new LXMRouter(rns.transport, {
      storagePath: join(dir, 'lxmf'),
      messageExpiry: 30 * 24 * 60 * 60,
    });

    // Register delivery identity (same as transport identity)
    const deliveryDest = router.registerDeliveryIdentity(rns.identity, {
      displayName: config.lxmf?.display_name || 'LXMF Node',
    });

    // Enable propagation
    router.enablePropagation(rns.identity);

    console.log(`  LXMF: enabled`);
    console.log(`    Delivery:    ${toHex(deliveryDest.hash)}`);
    console.log(`    Propagation: ${toHex(router.propagationDestination.hash)}`);

    // Periodic message expiry
    setInterval(() => router.expireMessages(), 60000);

    router.onMessage((msg) => {
      console.log(`  [LXMF] Message from ${toHex(msg.sourceHash).slice(0, 16)}.. "${msg.title}": ${msg.content.slice(0, 80)}`);
    });
  }

  // --- HTTP API ---
  let httpServer = null;
  if (httpPort > 0) {
    const { createServer } = await import('http');
    const { readFile: readFileFs } = await import('fs/promises');
    const { extname } = await import('path');

    const TYPES = {
      '.html': 'text/html', '.js': 'application/javascript',
      '.css': 'text/css', '.json': 'application/json',
    };

    httpServer = createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${httpPort}`);
      const path = url.pathname;

      // CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET');

      // --- API endpoints ---
      if (path === '/api/messages') {
        const messages = router ? router.getDeliveredMessages() : [];
        const json = messages.map(m => ({
          id: m.id,
          timestamp: m.message.timestamp,
          received: m.received,
          sourceHash: toHex(m.message.sourceHash),
          destinationHash: toHex(m.message.destinationHash),
          title: m.message.title,
          content: m.message.content,
          fields: m.message.fields,
          signatureValidated: m.message.signatureValidated,
          method: m.message.method,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
        return;
      }

      if (path.startsWith('/api/messages/')) {
        const id = path.slice('/api/messages/'.length);
        const messages = router ? router.getDeliveredMessages() : [];
        const found = messages.find(m => m.id === id);
        if (found) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: found.id,
            timestamp: found.message.timestamp,
            received: found.received,
            sourceHash: toHex(found.message.sourceHash),
            destinationHash: toHex(found.message.destinationHash),
            title: found.message.title,
            content: found.message.content,
            fields: found.message.fields,
            signatureValidated: found.message.signatureValidated,
            method: found.message.method,
          }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Message not found' }));
        }
        return;
      }

      if (path === '/api/stats') {
        const t = rns.transport;
        const stats = {
          uptime: process.uptime(),
          transport: {
            packetsReceived: t.stats.packetsReceived,
            packetsSent: t.stats.packetsSent,
            packetsForwarded: t.stats.packetsForwarded,
            announcesValidated: t.stats.announcesValidated,
            duplicatesDropped: t.stats.duplicatesDropped,
            paths: t.pathTable.size,
            links: t.linkTable.size,
          },
          lxmf: router ? router.getStats() : null,
          identity: rns.identity.hexHash,
          interfaces: ifaces.map(i => ({ name: i.name, online: i.online })),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
        return;
      }

      if (path === '/api/propagation') {
        if (!router) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'LXMF not enabled' }));
          return;
        }
        const entries = [];
        for (const [tid, entry] of router.propagationEntries) {
          entries.push({
            transientId: tid,
            destinationHash: toHex(entry.destinationHash),
            received: entry.received,
            size: entry.size,
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(entries));
        return;
      }

      // --- Static files: serve the web interface ---
      if (path === '/' || path === '/index.html') {
        try {
          const html = await readFileFs(join(__dirname, '..', 'examples', 'lxmf-viewer.html'));
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
        } catch {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(generateFallbackPage());
        }
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    httpServer.listen(httpPort, () => {
      console.log(`  HTTP API: http://localhost:${httpPort}`);
      console.log(`    Messages: http://localhost:${httpPort}/api/messages`);
      console.log(`    Stats:    http://localhost:${httpPort}/api/stats`);
      console.log(`    Web UI:   http://localhost:${httpPort}/`);
    });
  }

  console.log();
  console.log(`Node is running. Press Ctrl+C to stop.`);

  // Periodic stats
  const statsInterval = setInterval(() => {
    const t = rns.transport;
    const uptime = process.uptime();
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const s = Math.floor(uptime % 60);
    let line = `[${h}h${m}m${s}s] ` +
      `rx:${t.stats.packetsReceived} tx:${t.stats.packetsSent} ` +
      `fwd:${t.stats.packetsForwarded} ann:${t.stats.announcesValidated} ` +
      `dup:${t.stats.duplicatesDropped} ` +
      `paths:${t.pathTable.size} links:${t.linkTable.size}`;
    if (router) {
      line += ` lxmf:${router.deliveredMessages.length} prop:${router.propagationEntries.size}`;
    }
    console.log(line);
  }, 60000);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    clearInterval(statsInterval);
    if (httpServer) httpServer.close();
    await rns.stop();
    console.log('Stopped.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep alive
  await new Promise(() => {});
}

function generateFallbackPage() {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>LXMF Messages</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #0f1419; color: #e7e9ea; padding: 20px; max-width: 800px; margin: 0 auto; }
  h1 { color: #1d9bf0; } h2 { color: #8b98a5; font-size: 0.9em; }
  .msg { background: #16202a; border: 1px solid #2f3336; border-radius: 8px; padding: 12px 16px; margin-bottom: 8px; }
  .msg .from { color: #1d9bf0; font-family: monospace; font-size: 0.85em; }
  .msg .title { font-weight: 600; margin: 4px 0; }
  .msg .content { color: #b3b1ad; white-space: pre-wrap; }
  .msg .meta { font-size: 0.75em; color: #536471; margin-top: 4px; }
  .stats { font-size: 0.85em; color: #8b98a5; margin-bottom: 16px; }
  .empty { color: #536471; text-align: center; padding: 40px; }
  #refresh { background: #1d9bf0; color: white; border: none; padding: 6px 14px; border-radius: 14px; cursor: pointer; font-size: 0.85em; }
</style></head><body>
<h1>LXMF Messages</h1>
<div class="stats" id="stats">Loading...</div>
<button id="refresh" onclick="load()">Refresh</button>
<div id="messages"><div class="empty">Loading messages...</div></div>
<script>
async function load() {
  const [msgs, stats] = await Promise.all([
    fetch('/api/messages').then(r => r.json()),
    fetch('/api/stats').then(r => r.json()),
  ]);
  document.getElementById('stats').innerHTML =
    'Uptime: ' + fmt(stats.uptime) +
    ' | Packets: ' + stats.transport.packetsReceived +
    ' | Announces: ' + stats.transport.announcesValidated +
    ' | Paths: ' + stats.transport.paths +
    (stats.lxmf ? ' | LXMF delivered: ' + stats.lxmf.deliveredMessages +
      ' | Propagation: ' + stats.lxmf.propagationEntries : '');
  const el = document.getElementById('messages');
  if (msgs.length === 0) { el.innerHTML = '<div class="empty">No messages yet</div>'; return; }
  el.innerHTML = msgs.reverse().map(m => '<div class="msg">' +
    '<div class="from">From: ' + m.sourceHash.slice(0,16) + '..</div>' +
    (m.title ? '<div class="title">' + esc(m.title) + '</div>' : '') +
    '<div class="content">' + esc(m.content) + '</div>' +
    '<div class="meta">' + new Date(m.timestamp*1000).toLocaleString() +
    ' | ' + ['','opportunistic','direct','propagated'][m.method||0] +
    ' | sig: ' + (m.signatureValidated ? 'valid' : 'unverified') + '</div></div>'
  ).join('');
}
function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmt(s) { const h=Math.floor(s/3600),m=Math.floor(s%3600/60); return h+'h'+m+'m'; }
load(); setInterval(load, 15000);
</script></body></html>`;
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
