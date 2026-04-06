/**
 * Python ↔ Node.js page fetch interop test.
 *
 * Tests the full chain: WebSocket → Link → Request/Response
 * Python serves a page via register_request_handler, Node.js fetches it.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { Transport } from '../src/Transport.js';
import { WebSocketClientInterface } from '../src/interfaces/WebSocketInterface.js';
import { Destination } from '../src/Destination.js';
import { Link } from '../src/Link.js';
import { toHex } from '../src/utils/bytes.js';
import { setLogLevel, LOG_WARNING } from '../src/utils/log.js';
import { DEST_SINGLE, DEST_IN } from '../src/constants.js';

setLogLevel(LOG_WARNING);

const PYTHON = 'C:/Vet Rocket/Claude_scratch/reticulum-node/.venv/Scripts/python.exe';
const TIMEOUT = 60000;

function launchPageServer() {
  return new Promise((resolve, reject) => {
    // Inline Python script that serves a page over WebSocket
    const script = `
import sys, os, time, json, threading, shutil
config_dir = os.path.join(os.path.dirname(os.path.abspath('.')), 'reticulum-node', '.rns_page_test_config')
os.makedirs(config_dir, exist_ok=True)
iface_dir = os.path.join(config_dir, 'interfaces')
os.makedirs(iface_dir, exist_ok=True)
shutil.copy2('python/WebSocketInterface.py', os.path.join(iface_dir, 'WebSocketInterface.py'))
config = """[reticulum]
  enable_transport = False
  share_instance = No
[logging]
  loglevel = 2
[interfaces]
  [[WS]]
    type = WebSocketInterface
    enabled = yes
    mode = server
    listen_ip = 127.0.0.1
    listen_port = 18777
"""
with open(os.path.join(config_dir, 'config'), 'w') as f: f.write(config)
import RNS
reticulum = RNS.Reticulum(configdir=config_dir)
identity = RNS.Identity()
dest = RNS.Destination(identity, RNS.Destination.IN, RNS.Destination.SINGLE, "nomadnetwork", "node")
def on_link(link):
    link.set_resource_strategy(RNS.Link.ACCEPT_NONE)
    link.set_link_closed_callback(lambda l: None)
def page_handler(path, data, request_id, remote_identity, requested_at):
    return b"Hello from Python page server!"
dest.set_link_established_callback(on_link)
dest.register_request_handler("/page/index.mu", response_generator=page_handler, allow=RNS.Destination.ALLOW_ALL)
print(json.dumps({"ready": True, "dest": dest.hash.hex(), "id": identity.hexhash, "port": 18777}), flush=True)
time.sleep(2)
dest.announce(app_data=b"Test Page Node")
for i in range(20):
    time.sleep(3)
    dest.announce(app_data=b"Test Page Node")
reticulum.teardown()
`;

    const proc = spawn(PYTHON, ['-u', '-c', script], {
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
          resolve({ process: proc, info: JSON.parse(stdout.split('\n')[0].trim()) });
        } catch (err) {
          reject(new Error(`Parse: ${stdout}`));
        }
      }
    });

    proc.stderr.on('data', () => {});
    proc.on('error', (err) => { if (!resolved) reject(err); });
    setTimeout(() => { if (!resolved) { proc.kill(); reject(new Error('Server timeout')); } }, 15000);
  });
}

describe('Python page fetch over WebSocket', () => {
  it('fetches a page from Python via Link request/response', async () => {
    let proc;
    let info;

    try {
      const result = await launchPageServer();
      proc = result.process;
      info = result.info;
    } catch (err) {
      console.warn(`Skipping: ${err.message}`);
      return;
    }

    expect(info.ready).toBe(true);

    try {
      const transport = new Transport();
      const ws = new WebSocketClientInterface('test', `ws://127.0.0.1:${info.port}`);
      transport.registerInterface(ws);
      await ws.start();

      // Wait for announce
      const announce = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Announce timeout')), 20000);
        transport.on('announce', (a) => {
          if (toHex(a.destinationHash) === info.dest) { clearTimeout(t); resolve(a); }
        });
      });

      // Establish link
      const dest = new Destination(announce.identity, DEST_IN, DEST_SINGLE, 'nomadnetwork', 'node');
      expect(toHex(dest.hash)).toBe(info.dest);

      const link = Link.init(dest, transport);
      transport.registerPendingLink(link);

      const established = await new Promise(res => {
        const t = setTimeout(() => res(false), 15000);
        link.on('established', () => { clearTimeout(t); res(true); });
      });
      expect(established).toBe(true);

      // Fetch page
      const response = await link.request('/page/index.mu', null, 15000);
      expect(response).not.toBeNull();

      const text = new TextDecoder().decode(response);
      expect(text).toBe('Hello from Python page server!');

      await link.close();
      await ws.stop();
    } finally {
      if (proc) { proc.kill(); await new Promise(r => proc.on('close', r)); }
    }
  }, TIMEOUT);

  it('fetches a LARGE page (sent as Resource) from Python', async () => {
    let proc;
    let info;

    // Launch a server that returns a page larger than Link MDU (~431 bytes)
    // Python will send this as a Resource instead of a single packet
    try {
      const result = await (new Promise((resolve, reject) => {
        const bigScript = `
import sys, os, time, json, shutil
config_dir = os.path.join(os.path.dirname(os.path.abspath('.')), 'reticulum-node', '.rns_bigpage_config')
os.makedirs(config_dir, exist_ok=True)
iface_dir = os.path.join(config_dir, 'interfaces')
os.makedirs(iface_dir, exist_ok=True)
shutil.copy2('python/WebSocketInterface.py', os.path.join(iface_dir, 'WebSocketInterface.py'))
config = """[reticulum]
  enable_transport = False
  share_instance = No
[logging]
  loglevel = 2
[interfaces]
  [[WS]]
    type = WebSocketInterface
    enabled = yes
    mode = server
    listen_ip = 127.0.0.1
    listen_port = 18778
"""
with open(os.path.join(config_dir, 'config'), 'w') as f: f.write(config)
import RNS
reticulum = RNS.Reticulum(configdir=config_dir)
identity = RNS.Identity()
dest = RNS.Destination(identity, RNS.Destination.IN, RNS.Destination.SINGLE, "nomadnetwork", "node")
def on_link(link):
    link.set_resource_strategy(RNS.Link.ACCEPT_ALL)
    link.set_link_closed_callback(lambda l: None)
def big_page_handler(path, data, request_id, remote_identity, requested_at):
    # Return 600 bytes — larger than MDU, will be sent as Resource
    return b"X" * 600
dest.set_link_established_callback(on_link)
dest.register_request_handler("/page/index.mu", response_generator=big_page_handler, allow=RNS.Destination.ALLOW_ALL, auto_compress=True)
print(json.dumps({"ready": True, "dest": dest.hash.hex(), "id": identity.hexhash, "port": 18778}), flush=True)
time.sleep(2)
dest.announce(app_data=b"Big Page Node")
for i in range(20):
    time.sleep(3)
    dest.announce(app_data=b"Big Page Node")
reticulum.teardown()
`;
        const p = spawn(PYTHON, ['-u', '-c', bigScript], {
          cwd: 'C:/Vet Rocket/Claude_scratch/reticulum-node',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let done = false;
        p.stdout.on('data', (c) => {
          stdout += c.toString();
          if (!done && stdout.includes('\n')) {
            done = true;
            try { resolve({ process: p, info: JSON.parse(stdout.split('\n')[0].trim()) }); }
            catch(e) { reject(e); }
          }
        });
        p.stderr.on('data', () => {});
        p.on('error', (e) => { if (!done) reject(e); });
        setTimeout(() => { if (!done) { p.kill(); reject(new Error('timeout')); } }, 15000);
      }));
      proc = result.process;
      info = result.info;
    } catch (err) {
      console.warn(`Skipping large page test: ${err.message}`);
      return;
    }

    try {
      const transport = new Transport();
      const ws = new WebSocketClientInterface('test', `ws://127.0.0.1:${info.port}`);
      transport.registerInterface(ws);
      await ws.start();

      const announce = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Announce timeout')), 20000);
        transport.on('announce', (a) => {
          if (toHex(a.destinationHash) === info.dest) { clearTimeout(t); resolve(a); }
        });
      });

      const dest = new Destination(announce.identity, DEST_IN, DEST_SINGLE, 'nomadnetwork', 'node');
      const link = Link.init(dest, transport);
      transport.registerPendingLink(link);

      const established = await new Promise(res => {
        const t = setTimeout(() => res(false), 15000);
        link.on('established', () => { clearTimeout(t); res(true); });
      });
      expect(established).toBe(true);

      // This response is 600 bytes — Python will send as a Resource
      const response = await link.request('/page/index.mu', null, 30000);
      expect(response).not.toBeNull();
      expect(response.length).toBe(600);
      expect(response.every(b => b === 0x58)).toBe(true); // all 'X'

      await link.close();
      await ws.stop();
    } finally {
      if (proc) { proc.kill(); await new Promise(r => proc.on('close', r)); }
    }
  }, TIMEOUT);
});
