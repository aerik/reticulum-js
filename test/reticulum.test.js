import { describe, it, expect, afterEach } from 'vitest';
import { Reticulum, Identity, Destination, DEST_SINGLE, DEST_IN } from '../src/Reticulum.js';
import { toHex, fromUtf8, equal } from '../src/utils/bytes.js';
import { mkdtemp, rm, readFile, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const cleanup = [];

afterEach(async () => {
  for (const item of cleanup) {
    if (item.stop) await item.stop();
    if (item.dir) await rm(item.dir, { recursive: true, force: true });
  }
  cleanup.length = 0;
});

describe('Reticulum', () => {
  describe('basic lifecycle', () => {
    it('starts and stops without config', async () => {
      const rns = new Reticulum();
      await rns.start();
      cleanup.push(rns);

      expect(rns.started).toBe(true);
      expect(rns.storage).toBeNull(); // no configDir

      await rns.stop();
      expect(rns.started).toBe(false);
    });

    it('starts with explicit interface config', async () => {
      // Use a TCP server on port 0 so we don't need an external node
      const rns = new Reticulum({
        interfaces: [
          {
            name: 'Test Server',
            type: 'TCPServerInterface',
            enabled: true,
            bind_host: '127.0.0.1',
            bind_port: 0,
          },
        ],
      });
      cleanup.push(rns);
      await rns.start();

      expect(rns.started).toBe(true);
      expect(rns._interfaces).toHaveLength(1);
      expect(rns._interfaces[0].online).toBe(true);
    });

    it('skips disabled interfaces', async () => {
      const rns = new Reticulum({
        interfaces: [
          { name: 'Disabled', type: 'TCPServerInterface', enabled: false, bind_port: 0 },
        ],
      });
      cleanup.push(rns);
      await rns.start();

      expect(rns._interfaces).toHaveLength(0);
    });

    it('handles unknown interface types gracefully', async () => {
      const rns = new Reticulum({
        interfaces: [
          { name: 'Unknown', type: 'MagicInterface', enabled: true },
        ],
      });
      cleanup.push(rns);
      await rns.start(); // should not throw

      expect(rns._interfaces).toHaveLength(0);
    });
  });

  describe('with storage (configDir)', () => {
    it('initializes storage and generates transport identity', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'rns-test-'));
      cleanup.push({ dir });

      const rns = new Reticulum({ configDir: dir });
      cleanup.push(rns);
      await rns.start();

      expect(rns.storage).not.toBeNull();
      expect(rns.identity).not.toBeNull();
      expect(rns.identity.hasPrivateKey()).toBe(true);

      // Identity file should exist on disk
      await expect(access(join(dir, 'storage', 'transport_identity'))).resolves.not.toThrow();
    });

    it('reloads the same identity on restart', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'rns-test-'));
      cleanup.push({ dir });

      // First start
      const rns1 = new Reticulum({ configDir: dir });
      await rns1.start();
      const hash1 = rns1.identity.hexHash;
      await rns1.stop();

      // Second start — same dir
      const rns2 = new Reticulum({ configDir: dir });
      await rns2.start();
      cleanup.push(rns2);

      expect(rns2.identity.hexHash).toBe(hash1);
    });

    it('persists announce table on stop', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'rns-test-'));
      cleanup.push({ dir });

      const rns = new Reticulum({ configDir: dir });
      await rns.start();

      // Add something to the announce table
      const id = Identity.generate();
      rns.transport.announceTable.set('deadbeef00000000' + '00'.repeat(8), {
        identity: id,
        appData: null,
        hops: 3,
        timestamp: Date.now() / 1000,
      });

      await rns.stop();

      // Reload and check
      const rns2 = new Reticulum({ configDir: dir });
      await rns2.start();
      cleanup.push(rns2);

      const entry = rns2.transport.announceTable.get('deadbeef00000000' + '00'.repeat(8));
      expect(entry).toBeDefined();
      expect(equal(entry.identity.publicKey, id.publicKey)).toBe(true);
    });
  });

  describe('announce and destination', () => {
    it('registers a destination and sends an announce', async () => {
      const rns = new Reticulum({
        interfaces: [
          { name: 'Server', type: 'TCPServerInterface', enabled: true, bind_host: '127.0.0.1', bind_port: 0 },
        ],
      });
      cleanup.push(rns);
      await rns.start();

      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'myapp', 'svc');
      rns.registerDestination(dest);

      // Should not throw
      rns.announce(dest, fromUtf8('Node.js RNS'));

      expect(rns.getStats().packetsSent).toBeGreaterThanOrEqual(1);
    });
  });

  describe('interface IFAC config', () => {
    it('configures IFAC on interfaces from config', async () => {
      const rns = new Reticulum({
        interfaces: [
          {
            name: 'IFAC Server',
            type: 'TCPServerInterface',
            enabled: true,
            bind_host: '127.0.0.1',
            bind_port: 0,
            networkname: 'testnet',
            passphrase: 'secret',
          },
        ],
      });
      cleanup.push(rns);
      await rns.start();

      expect(rns._interfaces[0].ifacConfig).not.toBeNull();
      expect(rns._interfaces[0].ifacConfig.ifacKey).toHaveLength(64);
    });
  });

  describe('UDP interface creation', () => {
    it('creates a UDP interface from config', async () => {
      const rns = new Reticulum({
        interfaces: [
          {
            name: 'Test UDP',
            type: 'UDPInterface',
            enabled: true,
            listen_port: 0,
            forward_ip: '127.0.0.1',
            forward_port: 19999,
          },
        ],
      });
      cleanup.push(rns);
      await rns.start();

      expect(rns._interfaces).toHaveLength(1);
      expect(rns._interfaces[0].online).toBe(true);
      expect(rns._interfaces[0].name).toBe('Test UDP');
    });
  });

  describe('requestPath', () => {
    it('returns true immediately for known paths', async () => {
      const rns = new Reticulum();
      cleanup.push(rns);
      await rns.start();

      const destHash = new Uint8Array(16).fill(0xAB);
      rns.transport.pathTable.set(toHex(destHash), {
        timestamp: Date.now() / 1000,
        nextHop: destHash,
        hops: 1,
        expires: Date.now() / 1000 + 86400,
        interface: null,
        announcePacketHash: null,
      });

      const result = await rns.requestPath(destHash, 100);
      expect(result).toBe(true);
    });
  });
});
