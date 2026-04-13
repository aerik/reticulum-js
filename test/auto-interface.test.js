import { describe, it, expect } from 'vitest';
import { AutoInterface } from '../src/interfaces/AutoInterface.js';
import { sha256Hash } from '../src/utils/crypto.js';
import { fromUtf8, toHex, equal } from '../src/utils/bytes.js';

describe('AutoInterface', () => {
  describe('multicast address computation', () => {
    it('computes a valid IPv6 multicast address', () => {
      const iface = new AutoInterface('test', { groupId: 'reticulum' });
      expect(iface.multicastAddress).toMatch(/^ff12:0:[0-9a-f]+(:[0-9a-f]+){5}$/);
    });

    it('different group IDs produce different addresses', () => {
      const a = new AutoInterface('a', { groupId: 'group1' });
      const b = new AutoInterface('b', { groupId: 'group2' });
      expect(a.multicastAddress).not.toBe(b.multicastAddress);
    });

    it('same group ID produces same address', () => {
      const a = new AutoInterface('a', { groupId: 'testnet' });
      const b = new AutoInterface('b', { groupId: 'testnet' });
      expect(a.multicastAddress).toBe(b.multicastAddress);
    });
  });

  describe('discovery token', () => {
    it('computes a 32-byte token', () => {
      const iface = new AutoInterface('test');
      const token = iface._computeDiscoveryToken('fe80::1');
      expect(token).toHaveLength(32);
    });

    it('same group + address = same token', () => {
      const a = new AutoInterface('a', { groupId: 'net' });
      const b = new AutoInterface('b', { groupId: 'net' });
      expect(equal(
        a._computeDiscoveryToken('fe80::1'),
        b._computeDiscoveryToken('fe80::1')
      )).toBe(true);
    });

    it('different address = different token', () => {
      const iface = new AutoInterface('test');
      expect(equal(
        iface._computeDiscoveryToken('fe80::1'),
        iface._computeDiscoveryToken('fe80::2')
      )).toBe(false);
    });
  });

  describe('peer management', () => {
    it('starts with no peers', () => {
      const iface = new AutoInterface('test');
      expect(iface.peers.size).toBe(0);
    });

    it('peer timeout evicts stale peers', () => {
      const iface = new AutoInterface('test');
      iface.peers.set('fe80::dead', {
        ifname: 'eth0',
        lastHeard: Date.now() / 1000 - 30, // 30 seconds ago (> 22s timeout)
        lastOutbound: 0,
      });

      iface._peerJob();
      expect(iface.peers.size).toBe(0);
    });

    it('peer timeout keeps fresh peers', () => {
      const iface = new AutoInterface('test');
      iface.peers.set('fe80::alive', {
        ifname: 'eth0',
        lastHeard: Date.now() / 1000 - 5, // 5 seconds ago (< 22s)
        lastOutbound: 0,
      });

      iface._peerJob();
      expect(iface.peers.size).toBe(1);
    });
  });

  describe('config', () => {
    it('uses default ports and group ID', () => {
      const iface = new AutoInterface('test');
      expect(iface.discoveryPort).toBe(29716);
      expect(iface.dataPort).toBe(42671);
    });

    it('accepts custom config', () => {
      const iface = new AutoInterface('test', {
        groupId: 'custom',
        discoveryPort: 30000,
        dataPort: 40000,
      });
      expect(iface.discoveryPort).toBe(30000);
      expect(iface.dataPort).toBe(40000);
    });

    it('allowedInterfaces defaults to null (all interfaces)', () => {
      const iface = new AutoInterface('test');
      expect(iface.allowedInterfaces).toBeNull();
    });

    it('ignoredInterfaces defaults to empty', () => {
      const iface = new AutoInterface('test');
      expect(iface.ignoredInterfaces).toEqual([]);
    });

    it('HW_MTU is 1196 (matches Python)', () => {
      const iface = new AutoInterface('test');
      expect(iface.HW_MTU).toBe(1196);
    });

    it('starts offline and sockets null', () => {
      const iface = new AutoInterface('test');
      expect(iface.online).toBe(false);
      expect(iface._discoverySocket).toBeNull();
      expect(iface._dataSocket).toBeNull();
    });
  });

  describe('_handleDiscovery', () => {
    function makeIface() {
      const iface = new AutoInterface('test', { groupId: 'reticulum' });
      // Simulate having a local address registered
      iface._localAddresses = [
        { ifname: 'eth0', address: 'fe80::1111', scopeid: 2 },
      ];
      return iface;
    }

    function validTokenFor(iface, peerAddress) {
      return iface._computeDiscoveryToken(peerAddress);
    }

    it('ignores packets shorter than 16 bytes', () => {
      const iface = makeIface();
      iface._handleDiscovery(new Uint8Array(10), { address: 'fe80::2' });
      expect(iface.peers.size).toBe(0);
    });

    it('accepts a packet with a valid discovery token', () => {
      const iface = makeIface();
      const peerAddr = 'fe80::2';
      const token = validTokenFor(iface, peerAddr);
      iface._handleDiscovery(token, { address: peerAddr });
      expect(iface.peers.size).toBe(1);
      expect(iface.peers.has(peerAddr)).toBe(true);
    });

    it('rejects a packet with the wrong group token', () => {
      const iface = makeIface();
      const other = new AutoInterface('other', { groupId: 'different-group' });
      const token = other._computeDiscoveryToken('fe80::2');
      iface._handleDiscovery(token, { address: 'fe80::2' });
      expect(iface.peers.size).toBe(0);
    });

    it('rejects a packet from our own local address', () => {
      const iface = makeIface();
      const token = validTokenFor(iface, 'fe80::1111');
      iface._handleDiscovery(token, { address: 'fe80::1111' });
      expect(iface.peers.size).toBe(0);
    });

    it('strips scope ID from incoming rinfo.address', () => {
      const iface = makeIface();
      const peerAddr = 'fe80::2';
      const token = validTokenFor(iface, peerAddr);
      iface._handleDiscovery(token, { address: 'fe80::2%eth0' });
      expect(iface.peers.has('fe80::2')).toBe(true);
    });

    it('updates lastHeard when the peer is already known', () => {
      const iface = makeIface();
      const peerAddr = 'fe80::2';
      const token = validTokenFor(iface, peerAddr);
      iface._handleDiscovery(token, { address: peerAddr });
      const firstHeard = iface.peers.get(peerAddr).lastHeard;
      // Rewind, then re-run — should update
      iface.peers.get(peerAddr).lastHeard = firstHeard - 10;
      iface._handleDiscovery(token, { address: peerAddr });
      expect(iface.peers.get(peerAddr).lastHeard).toBeGreaterThan(firstHeard - 10);
    });

    it('supports multiple distinct peers', () => {
      const iface = makeIface();
      iface._handleDiscovery(validTokenFor(iface, 'fe80::a'), { address: 'fe80::a' });
      iface._handleDiscovery(validTokenFor(iface, 'fe80::b'), { address: 'fe80::b' });
      iface._handleDiscovery(validTokenFor(iface, 'fe80::c'), { address: 'fe80::c' });
      expect(iface.peers.size).toBe(3);
    });
  });

  describe('send()', () => {
    function makeIfaceWithFakeSocket() {
      const iface = new AutoInterface('test');
      const sends = [];
      iface._dataSocket = {
        send: (buf, offset, length, port, addr, cb) => {
          sends.push({ buf: new Uint8Array(buf), port, addr });
          if (cb) cb(null); // success
        },
      };
      iface.online = true;
      return { iface, sends };
    }

    it('is a no-op when offline', () => {
      const { iface, sends } = makeIfaceWithFakeSocket();
      iface.online = false;
      iface.peers.set('fe80::1', { ifname: 'eth0', lastHeard: Date.now() / 1000, lastOutbound: 0 });
      iface.send(new Uint8Array([1, 2, 3]));
      expect(sends).toHaveLength(0);
    });

    it('is a no-op when _dataSocket is null', () => {
      const iface = new AutoInterface('test');
      iface.online = true;
      iface._dataSocket = null;
      iface.peers.set('fe80::1', { ifname: 'eth0', lastHeard: Date.now() / 1000, lastOutbound: 0 });
      // Should not throw
      expect(() => iface.send(new Uint8Array([1, 2, 3]))).not.toThrow();
    });

    it('drops packets larger than HW_MTU', () => {
      const { iface, sends } = makeIfaceWithFakeSocket();
      iface.peers.set('fe80::1', { ifname: 'eth0', lastHeard: Date.now() / 1000, lastOutbound: 0 });
      iface.send(new Uint8Array(2000));
      expect(sends).toHaveLength(0);
    });

    it('sends to every known peer', () => {
      const { iface, sends } = makeIfaceWithFakeSocket();
      iface.peers.set('fe80::a', { ifname: 'eth0', lastHeard: 0, lastOutbound: 0 });
      iface.peers.set('fe80::b', { ifname: 'eth0', lastHeard: 0, lastOutbound: 0 });
      iface.peers.set('fe80::c', { ifname: 'eth0', lastHeard: 0, lastOutbound: 0 });
      iface.send(new Uint8Array([1, 2, 3]));
      expect(sends).toHaveLength(3);
      expect(new Set(sends.map(s => s.addr))).toEqual(new Set(['fe80::a', 'fe80::b', 'fe80::c']));
    });

    it('updates peer.lastOutbound on successful send', () => {
      const { iface, sends } = makeIfaceWithFakeSocket();
      const peer = { ifname: 'eth0', lastHeard: 0, lastOutbound: 0 };
      iface.peers.set('fe80::a', peer);
      iface.send(new Uint8Array([1, 2, 3]));
      expect(peer.lastOutbound).toBeGreaterThan(0);
    });

    it('tracks txBytes', () => {
      const { iface } = makeIfaceWithFakeSocket();
      iface.peers.set('fe80::a', { ifname: 'eth0', lastHeard: 0, lastOutbound: 0 });
      iface.peers.set('fe80::b', { ifname: 'eth0', lastHeard: 0, lastOutbound: 0 });
      expect(iface.txBytes).toBe(0);
      iface.send(new Uint8Array([1, 2, 3]));
      expect(iface.txBytes).toBe(6); // 3 bytes × 2 peers
    });
  });

  describe('_sendDiscovery', () => {
    it('does nothing without a discovery socket', () => {
      const iface = new AutoInterface('test');
      // No socket set — should not throw
      expect(() => iface._sendDiscovery()).not.toThrow();
    });

    it('sends one token per local address', () => {
      const iface = new AutoInterface('test', { groupId: 'reticulum' });
      iface._localAddresses = [
        { ifname: 'eth0', address: 'fe80::a', scopeid: 2 },
        { ifname: 'eth1', address: 'fe80::b', scopeid: 3 },
      ];
      const sends = [];
      iface._discoverySocket = {
        send: (buf, offset, length, port, addr, cb) => {
          sends.push({ token: new Uint8Array(buf), port, addr });
          if (cb) cb(null);
        },
      };
      iface._sendDiscovery();
      expect(sends).toHaveLength(2);
      // Each send goes to the multicast address on the discovery port
      for (const s of sends) {
        expect(s.addr).toBe(iface.multicastAddress);
        expect(s.port).toBe(iface.discoveryPort);
        expect(s.token).toHaveLength(32);
      }
    });
  });

  describe('stop()', () => {
    it('clears timers, closes sockets, and clears peers', async () => {
      const iface = new AutoInterface('test');
      // Inject fake state
      iface._announceTimer = setInterval(() => {}, 60_000);
      iface._peerJobTimer = setInterval(() => {}, 60_000);
      let discoveryClosed = false;
      let dataClosed = false;
      iface._discoverySocket = {
        close: (cb) => { discoveryClosed = true; cb(); },
      };
      iface._dataSocket = {
        close: (cb) => { dataClosed = true; cb(); },
      };
      iface.peers.set('fe80::a', { ifname: 'eth0', lastHeard: 0, lastOutbound: 0 });
      iface.online = true;

      await iface.stop();

      expect(iface._announceTimer).toBeNull();
      expect(iface._peerJobTimer).toBeNull();
      expect(discoveryClosed).toBe(true);
      expect(dataClosed).toBe(true);
      expect(iface._discoverySocket).toBeNull();
      expect(iface._dataSocket).toBeNull();
      expect(iface.peers.size).toBe(0);
      expect(iface.online).toBe(false);
    });

    it('is safe when nothing was started', async () => {
      const iface = new AutoInterface('test');
      await expect(iface.stop()).resolves.not.toThrow();
    });
  });

  describe('_peerJob', () => {
    it('evicts multiple stale peers in one pass', () => {
      const iface = new AutoInterface('test');
      const now = Date.now() / 1000;
      iface.peers.set('fe80::a', { ifname: 'eth0', lastHeard: now - 30, lastOutbound: 0 });
      iface.peers.set('fe80::b', { ifname: 'eth0', lastHeard: now - 40, lastOutbound: 0 });
      iface.peers.set('fe80::c', { ifname: 'eth0', lastHeard: now - 5,  lastOutbound: 0 });
      iface._peerJob();
      expect(iface.peers.size).toBe(1);
      expect(iface.peers.has('fe80::c')).toBe(true);
    });

    it('is a no-op when there are no peers', () => {
      const iface = new AutoInterface('test');
      expect(() => iface._peerJob()).not.toThrow();
    });
  });

  describe('start() (integration-lite)', () => {
    // start() binds real UDP6 sockets. On many CI runners there's no IPv6
    // link-local interface available, so these tests are intentionally
    // lenient — they verify the state-machine bookkeeping and let the
    // socket operations succeed or gracefully skip.

    it('can run start() and stop() without throwing', async () => {
      const iface = new AutoInterface('test', {
        // Bind to high non-standard ports to avoid collisions with real
        // auto-interface deployments on the same host.
        discoveryPort: 39716,
        dataPort: 52671,
      });
      try {
        await iface.start();
      } catch (err) {
        // OK — environment may lack IPv6 entirely. Bookkeeping still matters.
      }
      await iface.stop();
      expect(iface.online).toBe(false);
    }, 10000);
  });
});
