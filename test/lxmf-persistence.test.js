/**
 * Tests for LXMF propagation node persistence — message store and peers
 * round-trip through Storage so a node can be restarted without losing state.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Transport } from '../src/Transport.js';
import { Identity } from '../src/Identity.js';
import { LXMRouter } from '../src/lxmf/LXMRouter.js';
import { LXMPeer } from '../src/lxmf/LXMPeer.js';
import { Storage } from '../src/utils/storage.js';
import { MemoryBackend } from '../src/utils/storage-backend.js';
import { EventEmitter } from '../src/utils/events.js';
import { toHex, randomBytes, equal } from '../src/utils/bytes.js';

class MockInterface extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.online = true;
    this.sent = [];
  }
  send(data) { this.sent.push(new Uint8Array(data)); }
}

async function makeRouterWithStorage(backend) {
  const iface = new MockInterface('mock');
  const transport = new Transport();
  transport.registerInterface(iface);
  const storage = new Storage(backend || new MemoryBackend());
  await storage.init();
  const router = new LXMRouter(transport, { autoStart: false, storage });
  return { router, transport, iface, storage };
}

function sampleEntry(overrides = {}) {
  return {
    destinationHash: randomBytes(16),
    data: randomBytes(200),
    received: Date.now() / 1000,
    size: 200,
    stampValue: 0,
    handledPeers: new Set(),
    unhandledPeers: new Set(),
    ...overrides,
  };
}

describe('Storage propagation persistence', () => {
  let storage;

  beforeEach(async () => {
    storage = new Storage(new MemoryBackend());
    await storage.init();
  });

  it('savePropagationEntry + loadPropagationEntries round-trips an entry', async () => {
    const tidHex = toHex(randomBytes(32));
    const entry = sampleEntry();
    entry.handledPeers.add('peer_a_hex');
    entry.unhandledPeers.add('peer_b_hex');

    await storage.savePropagationEntry(tidHex, entry);

    const loaded = await storage.loadPropagationEntries();
    expect(loaded.size).toBe(1);
    const restored = loaded.get(tidHex);
    expect(restored).not.toBeUndefined();
    expect(equal(restored.destinationHash, entry.destinationHash)).toBe(true);
    expect(equal(restored.data, entry.data)).toBe(true);
    expect(restored.received).toBe(entry.received);
    expect(restored.size).toBe(200);
    expect(restored.handledPeers.has('peer_a_hex')).toBe(true);
    expect(restored.unhandledPeers.has('peer_b_hex')).toBe(true);
  });

  it('loadPropagationEntries returns empty when nothing stored', async () => {
    const loaded = await storage.loadPropagationEntries();
    expect(loaded.size).toBe(0);
  });

  it('deletePropagationEntry removes a single entry', async () => {
    await storage.savePropagationEntry('tid1', sampleEntry());
    await storage.savePropagationEntry('tid2', sampleEntry());

    await storage.deletePropagationEntry('tid1');
    const loaded = await storage.loadPropagationEntries();
    expect(loaded.has('tid1')).toBe(false);
    expect(loaded.has('tid2')).toBe(true);
  });

  it('savePeer / loadPeers round-trips raw bytes', async () => {
    const mockRouter = { propagationEntries: new Map() };
    const peer = new LXMPeer(mockRouter, randomBytes(16));
    peer.alive = true;
    peer.offered = 10;
    peer.outgoing = 5;
    peer.lastHeard = 12345;

    const bytes = peer.toBytes();
    await storage.savePeer(peer.destinationHashHex, bytes);

    const loaded = await storage.loadPeers();
    expect(loaded.size).toBe(1);
    const restoredBytes = loaded.get(peer.destinationHashHex);
    expect(restoredBytes).toBeInstanceOf(Uint8Array);

    const restored = LXMPeer.fromBytes(mockRouter, restoredBytes);
    expect(restored).not.toBeNull();
    expect(equal(restored.destinationHash, peer.destinationHash)).toBe(true);
    expect(restored.alive).toBe(true);
    expect(restored.offered).toBe(10);
    expect(restored.outgoing).toBe(5);
    expect(restored.lastHeard).toBe(12345);
  });

  it('deletePeer removes a single peer', async () => {
    const mockRouter = { propagationEntries: new Map() };
    const p1 = new LXMPeer(mockRouter, randomBytes(16));
    const p2 = new LXMPeer(mockRouter, randomBytes(16));
    await storage.savePeer(p1.destinationHashHex, p1.toBytes());
    await storage.savePeer(p2.destinationHashHex, p2.toBytes());

    await storage.deletePeer(p1.destinationHashHex);
    const loaded = await storage.loadPeers();
    expect(loaded.has(p1.destinationHashHex)).toBe(false);
    expect(loaded.has(p2.destinationHashHex)).toBe(true);
  });
});

describe('LXMRouter persistence integration', () => {
  it('stored propagation messages survive router restart', async () => {
    const backend = new MemoryBackend();

    // First session: create router, store a message
    const { router: r1 } = await makeRouterWithStorage(backend);
    await r1.enablePropagation(Identity.generate());

    const lxmfData = new Uint8Array(300);
    for (let i = 0; i < 300; i++) lxmfData[i] = i & 0xff;
    r1._lxmfPropagation(lxmfData);

    expect(r1.propagationEntries.size).toBe(1);
    const [[tidHex, originalEntry]] = r1.propagationEntries;
    r1.stop();

    // Wait a tick for the async persistence to flush
    await new Promise(r => setImmediate(r));

    // Second session: new router with the same backend
    const { router: r2 } = await makeRouterWithStorage(backend);
    await r2.enablePropagation(Identity.generate());

    expect(r2.propagationEntries.size).toBe(1);
    const restored = r2.propagationEntries.get(tidHex);
    expect(restored).not.toBeUndefined();
    expect(equal(restored.data, originalEntry.data)).toBe(true);
    expect(restored.handledPeers).toBeInstanceOf(Set);
    expect(restored.unhandledPeers).toBeInstanceOf(Set);
    r2.stop();
  });

  it('peers survive router restart', async () => {
    const backend = new MemoryBackend();

    // Session 1
    const { router: r1 } = await makeRouterWithStorage(backend);
    await r1.enablePropagation(Identity.generate());

    const peerHash = randomBytes(16);
    r1.peer(peerHash, 1000, 256, 10240, 0, 0, 0, {});
    expect(r1.peers.size).toBe(1);
    const p1 = r1.peers.get(toHex(peerHash));
    p1.offered = 42;
    p1.outgoing = 10;
    r1._persistPeer(p1);
    r1.stop();

    await new Promise(r => setImmediate(r));

    // Session 2
    const { router: r2 } = await makeRouterWithStorage(backend);
    await r2.enablePropagation(Identity.generate());

    expect(r2.peers.size).toBe(1);
    const p2 = r2.peers.get(toHex(peerHash));
    expect(p2).toBeInstanceOf(LXMPeer);
    expect(equal(p2.destinationHash, peerHash)).toBe(true);
    expect(p2.offered).toBe(42);
    expect(p2.outgoing).toBe(10);
    expect(p2.peeringTimebase).toBe(1000);
    r2.stop();
  });

  it('pruned messages are also deleted from storage', async () => {
    const backend = new MemoryBackend();
    const { router, storage } = await makeRouterWithStorage(backend);
    await router.enablePropagation(Identity.generate(), { storageLimit: 2 });

    // Store 3 messages — one should be pruned
    for (let i = 0; i < 3; i++) {
      const data = new Uint8Array(300);
      data[0] = i;
      for (let j = 1; j < 300; j++) data[j] = (i + j) & 0xff;
      router._lxmfPropagation(data);
      // Ensure distinct `received` timestamps so prune-by-oldest works
      for (const entry of router.propagationEntries.values()) {
        entry.received -= 0.001 * (3 - i);
      }
    }

    await new Promise(r => setImmediate(r));
    expect(router.propagationEntries.size).toBeLessThanOrEqual(2);

    // Verify storage reflects the in-memory state
    const persisted = await storage.loadPropagationEntries();
    expect(persisted.size).toBe(router.propagationEntries.size);
    router.stop();
  });

  it('unpeer() removes peer from storage', async () => {
    const backend = new MemoryBackend();
    const { router, storage } = await makeRouterWithStorage(backend);
    await router.enablePropagation(Identity.generate());

    const peerHash = randomBytes(16);
    router.peer(peerHash, 1000, 256, null, 0, 0, 0, {});
    await new Promise(r => setImmediate(r));

    let persisted = await storage.loadPeers();
    expect(persisted.size).toBe(1);

    router.unpeer(peerHash);
    await new Promise(r => setImmediate(r));

    persisted = await storage.loadPeers();
    expect(persisted.size).toBe(0);
    router.stop();
  });

  it('stored entries with peer relationships round-trip correctly', async () => {
    const backend = new MemoryBackend();

    // Session 1: store a message, peer with someone, distribute
    const { router: r1, storage: s1 } = await makeRouterWithStorage(backend);
    await r1.enablePropagation(Identity.generate());

    const peerHash = randomBytes(16);
    r1.peer(peerHash, 1000, 256, null, 0, 0, 0, {});

    const lxmfData = new Uint8Array(300);
    for (let i = 0; i < 300; i++) lxmfData[i] = i & 0xff;
    r1._lxmfPropagation(lxmfData);
    r1.flushPeerDistributionQueue();

    const tidHex = [...r1.propagationEntries.keys()][0];
    const peerHex = toHex(peerHash);
    const entry = r1.propagationEntries.get(tidHex);
    expect(entry.unhandledPeers.has(peerHex)).toBe(true);
    r1.stop();

    await new Promise(r => setImmediate(r));

    // Session 2: restart and verify peer and handled/unhandled sets restored
    const { router: r2 } = await makeRouterWithStorage(backend);
    await r2.enablePropagation(Identity.generate());

    expect(r2.propagationEntries.has(tidHex)).toBe(true);
    expect(r2.peers.has(peerHex)).toBe(true);

    const restoredEntry = r2.propagationEntries.get(tidHex);
    expect(restoredEntry.unhandledPeers.has(peerHex)).toBe(true);
    r2.stop();
  });
});
