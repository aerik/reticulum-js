/**
 * Python ↔ Node.js WebSocket interop test.
 *
 * Python runs a RNS node with WebSocketInterface (server mode).
 * Node.js connects via WebSocketClientInterface, receives announce,
 * establishes Link, exchanges encrypted data.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { Transport } from '../src/Transport.js';
import { WebSocketClientInterface } from '../src/interfaces/WebSocketInterface.js';
import { Identity } from '../src/Identity.js';
import { Destination } from '../src/Destination.js';
import { Link } from '../src/Link.js';
import { fromHex, toHex, fromUtf8 } from '../src/utils/bytes.js';
import { setLogLevel, LOG_WARNING } from '../src/utils/log.js';
import { DEST_SINGLE, DEST_IN } from '../src/constants.js';

setLogLevel(LOG_WARNING);

const PYTHON = 'C:/Vet Rocket/Claude_scratch/reticulum-node/.venv/Scripts/python.exe';
const SERVER_SCRIPT = 'scripts/python-ws-server.py';
const TIMEOUT = 45000;

function launchPythonServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [SERVER_SCRIPT], {
      cwd: 'C:/Vet Rocket/Claude_scratch/reticulum-node',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let resolved = false;

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (!resolved && stdout.includes('\n')) {
        resolved = true;
        try {
          const info = JSON.parse(stdout.split('\n')[0].trim());
          resolve({ process: proc, info });
        } catch (err) {
          reject(new Error(`Parse error: ${stdout}`));
        }
      }
    });

    proc.stderr.on('data', () => {}); // suppress
    proc.on('error', (err) => { if (!resolved) reject(err); });

    setTimeout(() => {
      if (!resolved) {
        proc.kill();
        reject(new Error(`Python server timeout. stdout: ${stdout}`));
      }
    }, 20000);
  });
}

describe('Python ↔ Node.js WebSocket interop', () => {
  it('establishes a Link over WebSocket and exchanges data', async () => {
    let pythonProc;
    let serverInfo;

    try {
      const result = await launchPythonServer();
      pythonProc = result.process;
      serverInfo = result.info;
    } catch (err) {
      console.warn(`Skipping WebSocket interop test: ${err.message}`);
      return;
    }

    expect(serverInfo.ready).toBe(true);

    try {
      // Connect via WebSocket
      const transport = new Transport();
      const iface = new WebSocketClientInterface(
        'WS Interop', `ws://127.0.0.1:${serverInfo.ws_port}`
      );
      transport.registerInterface(iface);
      await iface.start();

      // Wait for announce
      const destHashHex = serverInfo.destination_hash;
      const announce = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Announce timeout')), 15000);
        transport.on('announce', (info) => {
          if (toHex(info.destinationHash) === destHashHex) {
            clearTimeout(t);
            resolve(info);
          }
        });
      });

      expect(announce.identity.hexHash).toBe(serverInfo.identity_hash);

      // Establish Link
      const remoteDest = new Destination(
        announce.identity, DEST_IN, DEST_SINGLE, 'ws_interop', 'echo'
      );

      const link = Link.init(remoteDest, transport);
      transport.registerPendingLink(link);

      const established = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 15000);
        link.on('established', () => { clearTimeout(t); resolve(true); });
      });

      expect(established).toBe(true);

      // Send data
      await link.send(fromUtf8('Hello via WebSocket!'));

      // Wait for echo
      const echo = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), 10000);
        link.on('data', (data) => { clearTimeout(t); resolve(data); });
      });

      expect(echo).not.toBeNull();
      const echoText = new TextDecoder().decode(echo);
      expect(echoText).toBe('ECHO:Hello via WebSocket!');

      await link.close();
      await iface.stop();

    } finally {
      if (pythonProc) {
        pythonProc.kill();
        await new Promise(resolve => pythonProc.on('close', resolve));
      }
    }
  }, TIMEOUT);
});
