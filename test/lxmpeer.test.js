import { describe, it, expect, beforeEach } from 'vitest';
import { LXMPeer } from '../src/lxmf/LXMPeer.js';
import { toHex, randomBytes, equal } from '../src/utils/bytes.js';
import {
  PEER_IDLE, DEFAULT_SYNC_STRATEGY, STRATEGY_LAZY, STRATEGY_PERSISTENT,
} from '../src/lxmf/constants.js';

function makeRouter() {
  return {
    propagationEntries: new Map(),
  };
}

function addEntry(router, tidHex, data = randomBytes(100)) {
  router.propagationEntries.set(tidHex, {
    destinationHash: randomBytes(16),
    data,
    received: Date.now() / 1000,
    size: data.length,
    stampValue: 0,
    handledPeers: new Set(),
    unhandledPeers: new Set(),
  });
}

describe('LXMPeer', () => {
  let router;
  let destHash;
  let peer;

  beforeEach(() => {
    router = makeRouter();
    destHash = randomBytes(16);
    peer = new LXMPeer(router, destHash);
  });

  describe('constructor', () => {
    it('initializes with correct defaults', () => {
      expect(peer.state).toBe(PEER_IDLE);
      expect(peer.alive).toBe(false);
      expect(peer.syncStrategy).toBe(DEFAULT_SYNC_STRATEGY);
      expect(peer.offered).toBe(0);
      expect(peer.outgoing).toBe(0);
      expect(peer.incoming).toBe(0);
      expect(peer.destinationHashHex).toBe(toHex(destHash));
    });

    it('accepts a custom sync strategy', () => {
      const p = new LXMPeer(router, destHash, { syncStrategy: STRATEGY_LAZY });
      expect(p.syncStrategy).toBe(STRATEGY_LAZY);
    });
  });

  describe('handled/unhandled message tracking', () => {
    it('addUnhandledMessage and unhandledMessages', () => {
      addEntry(router, 'aaa');
      addEntry(router, 'bbb');

      peer.addUnhandledMessage('aaa');
      expect(peer.unhandledMessages).toContain('aaa');
      expect(peer.unhandledMessages).not.toContain('bbb');
      expect(peer.unhandledMessageCount).toBe(1);
    });

    it('addHandledMessage and handledMessages', () => {
      addEntry(router, 'aaa');
      peer.addHandledMessage('aaa');
      expect(peer.handledMessages).toContain('aaa');
      expect(peer.handledMessageCount).toBe(1);
    });

    it('removeUnhandledMessage', () => {
      addEntry(router, 'aaa');
      peer.addUnhandledMessage('aaa');
      expect(peer.unhandledMessageCount).toBe(1);
      peer.removeUnhandledMessage('aaa');
      expect(peer.unhandledMessages).toHaveLength(0);
    });

    it('removeHandledMessage', () => {
      addEntry(router, 'aaa');
      peer.addHandledMessage('aaa');
      peer.removeHandledMessage('aaa');
      expect(peer.handledMessages).toHaveLength(0);
    });

    it('ignores nonexistent entry IDs gracefully', () => {
      peer.addHandledMessage('nonexistent');
      expect(peer.handledMessages).toHaveLength(0);
    });
  });

  describe('batching queues', () => {
    it('queuedItems reflects queue state', () => {
      expect(peer.queuedItems).toBe(false);
      peer.queueUnhandledMessage('aaa');
      expect(peer.queuedItems).toBe(true);
    });

    it('processQueues moves items from unhandled to handled', () => {
      addEntry(router, 'aaa');
      addEntry(router, 'bbb');

      peer.addUnhandledMessage('aaa');
      peer.addUnhandledMessage('bbb');

      // Queue aaa as handled
      peer.queueHandledMessage('aaa');
      peer.processQueues();

      expect(peer.handledMessages).toContain('aaa');
      expect(peer.unhandledMessages).not.toContain('aaa');
      // bbb still unhandled
      expect(peer.unhandledMessages).toContain('bbb');
    });

    it('processQueues skips already-handled items in unhandled queue', () => {
      addEntry(router, 'aaa');
      peer.addHandledMessage('aaa');

      peer.queueUnhandledMessage('aaa');
      peer.processQueues();

      // Should not appear in unhandled since already handled
      expect(peer.unhandledMessages).not.toContain('aaa');
      expect(peer.handledMessages).toContain('aaa');
    });
  });

  describe('computed properties', () => {
    it('acceptanceRate is 0 when nothing offered', () => {
      expect(peer.acceptanceRate).toBe(0);
    });

    it('acceptanceRate reflects outgoing/offered ratio', () => {
      peer.offered = 10;
      peer.outgoing = 3;
      expect(peer.acceptanceRate).toBeCloseTo(0.3);
    });

    it('name returns null when no metadata', () => {
      expect(peer.name).toBeNull();
    });

    it('name decodes from metadata', () => {
      peer.metadata = { [Symbol.for('name')]: null };
      // Use actual string key like Python does
      peer.metadata = { name: new TextEncoder().encode('TestNode') };
      expect(peer.name).toBe('TestNode');
    });
  });

  describe('serialization', () => {
    it('round-trips through toBytes/fromBytes', () => {
      addEntry(router, 'msg1');
      addEntry(router, 'msg2');
      addEntry(router, 'msg3');

      peer.alive = true;
      peer.lastHeard = 12345;
      peer.peeringTimebase = 100;
      peer.syncStrategy = STRATEGY_PERSISTENT;
      peer.offered = 42;
      peer.outgoing = 10;
      peer.incoming = 5;
      peer.rxBytes = 1000;
      peer.txBytes = 2000;
      peer.propagationTransferLimit = 256;
      peer.propagationSyncLimit = 10240;

      peer.addHandledMessage('msg1');
      peer.addUnhandledMessage('msg2');
      peer.addUnhandledMessage('msg3');

      const bytes = peer.toBytes();
      const restored = LXMPeer.fromBytes(router, bytes);

      expect(restored).not.toBeNull();
      expect(equal(restored.destinationHash, peer.destinationHash)).toBe(true);
      expect(restored.alive).toBe(true);
      expect(restored.lastHeard).toBe(12345);
      expect(restored.peeringTimebase).toBe(100);
      expect(restored.syncStrategy).toBe(STRATEGY_PERSISTENT);
      expect(restored.offered).toBe(42);
      expect(restored.outgoing).toBe(10);
      expect(restored.incoming).toBe(5);
      expect(restored.rxBytes).toBe(1000);
      expect(restored.txBytes).toBe(2000);
      expect(restored.propagationTransferLimit).toBe(256);
      expect(restored.propagationSyncLimit).toBe(10240);

      expect(restored.handledMessages).toContain('msg1');
      expect(restored.unhandledMessages).toContain('msg2');
      expect(restored.unhandledMessages).toContain('msg3');
      expect(restored.handledMessageCount).toBe(1);
      expect(restored.unhandledMessageCount).toBe(2);
    });

    it('fromBytes drops IDs not in propagationEntries', () => {
      addEntry(router, 'exists');

      peer.addHandledMessage('exists');
      peer.addUnhandledMessage('exists');
      // Manually add a reference to a non-existent entry in the serialization
      const bytes = peer.toBytes();

      // Remove the entry before deserializing
      router.propagationEntries.delete('exists');
      // Also clear the peer sets so fromBytes starts clean
      const restored = LXMPeer.fromBytes(router, bytes);
      expect(restored.handledMessages).toHaveLength(0);
      expect(restored.unhandledMessages).toHaveLength(0);
    });

    it('fromBytes returns null on invalid data', () => {
      expect(LXMPeer.fromBytes(router, new Uint8Array([0xFF]))).toBeNull();
    });
  });
});
