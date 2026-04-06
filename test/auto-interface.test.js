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
  });
});
