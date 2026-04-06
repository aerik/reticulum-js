#!/usr/bin/env node
/**
 * Minimal static file server for the example apps.
 *
 * Usage: node examples/serve.js [port]
 *
 * Serves the project root so browser apps can load the UMD bundle.
 * Open http://localhost:3000/examples/network-explorer.html
 */

import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = parseInt(process.argv[2] || '3000', 10);

const TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  let path = req.url.split('?')[0];
  if (path === '/') path = '/examples/network-explorer.html';

  const filePath = join(ROOT, path);
  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Serving at http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT}/examples/network-explorer.html`);
  console.log(`  or http://localhost:${PORT}/examples/browser-chat.html`);
});
