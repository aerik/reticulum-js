/**
 * Full Python ↔ Node.js Link interop test.
 *
 * Launches a Python RNS server with a link listener,
 * then connects from Node.js, establishes a Link, sends data,
 * and verifies the echo response.
 *
 * Requires: .venv/Scripts/python.exe with RNS installed
 * Skip if Python is not available.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { Transport } from '../src/Transport.js';
import { TCPClientInterface } from '../src/interfaces/TCPClientInterface.js';
import { Identity } from '../src/Identity.js';
import { Destination } from '../src/Destination.js';
import { Link } from '../src/Link.js';
import { fromHex, toHex, fromUtf8 } from '../src/utils/bytes.js';
import { setLogLevel, LOG_WARNING } from '../src/utils/log.js';
import { DEST_SINGLE, DEST_IN } from '../src/constants.js';

setLogLevel(LOG_WARNING);

const PYTHON = 'C:/Vet Rocket/Claude_scratch/reticulum-node/.venv/Scripts/python.exe';
const SERVER_SCRIPT = 'scripts/python-link-server.py';
const PORT = 14242;
const TIMEOUT = 30000;

/**
 * Launch the Python server and parse the first line of stdout as JSON.
 * Returns { process, info } where info contains destination_hash etc.
 */
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
          const firstLine = stdout.split('\n')[0].trim();
          const info = JSON.parse(firstLine);
          resolve({ process: proc, info });
        } catch (err) {
          reject(new Error(`Failed to parse Python output: ${stdout}`));
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      // Log Python stderr for debugging
      // process.stderr.write(`[Python] ${chunk}`);
    });

    proc.on('error', (err) => {
      if (!resolved) reject(err);
    });

    setTimeout(() => {
      if (!resolved) {
        proc.kill();
        reject(new Error(`Python server did not start within timeout. stdout: ${stdout}`));
      }
    }, 15000);
  });
}

describe('Python ↔ Node.js Link interop', () => {
  it('establishes a link with Python and exchanges data', async () => {
    // Launch Python server
    let pythonProc;
    let serverInfo;

    try {
      const result = await launchPythonServer();
      pythonProc = result.process;
      serverInfo = result.info;
    } catch (err) {
      console.warn(`Skipping interop test: ${err.message}`);
      return; // skip gracefully if Python isn't available
    }

    expect(serverInfo.ready).toBe(true);
    expect(serverInfo.destination_hash).toHaveLength(32);

    try {
      // Connect to the Python TCP server
      const transport = new Transport();
      const iface = new TCPClientInterface('Interop', '127.0.0.1', PORT);
      transport.registerInterface(iface);
      await iface.start();

      // Wait for the announce
      const destHashHex = serverInfo.destination_hash;
      const announce = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Announce timeout')), 10000);
        transport.on('announce', (info) => {
          if (toHex(info.destinationHash) === destHashHex) {
            clearTimeout(timeout);
            resolve(info);
          }
        });
      });

      expect(announce).toBeDefined();
      expect(announce.identity.hexHash).toBe(serverInfo.identity_hash);

      // Create destination for the remote peer
      const remoteDest = new Destination(
        announce.identity, DEST_IN, DEST_SINGLE,
        'interop_test', 'echo'
      );
      expect(toHex(remoteDest.hash)).toBe(destHashHex);

      // Establish link
      const link = Link.init(remoteDest, transport);
      transport.registerPendingLink(link);

      const established = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 10000);
        link.on('established', () => { clearTimeout(t); resolve(true); });
      });

      expect(established).toBe(true);

      // Send data over the encrypted link
      const testMessage = fromUtf8('Hello from Node.js!');
      await link.send(testMessage);

      // Wait for echo
      const echo = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), 10000);
        link.on('data', (data) => { clearTimeout(t); resolve(data); });
      });

      expect(echo).not.toBeNull();
      const echoText = new TextDecoder().decode(echo);
      expect(echoText).toBe('ECHO:Hello from Node.js!');

      // Clean up
      await link.close();
      await iface.stop();

    } finally {
      if (pythonProc) {
        pythonProc.kill();
        // Wait for process to exit
        await new Promise(resolve => pythonProc.on('close', resolve));
      }
    }
  }, TIMEOUT);
});
