import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { NodeFileBackend, MemoryBackend } from '../src/utils/storage-backend.js';
import { Storage } from '../src/utils/storage.js';
import { Identity } from '../src/Identity.js';
import { equal, fromUtf8, randomBytes } from '../src/utils/bytes.js';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Run the same test suite against each backend
const backends = [
  {
    name: 'NodeFileBackend',
    create: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'rns-backend-'));
      const backend = new NodeFileBackend(dir);
      return { backend, cleanup: () => rm(dir, { recursive: true, force: true }) };
    },
  },
  {
    name: 'MemoryBackend',
    create: async () => {
      const backend = new MemoryBackend();
      return { backend, cleanup: () => Promise.resolve() };
    },
  },
];

for (const { name, create } of backends) {
  describe(`StorageBackend: ${name}`, () => {
    let backend;
    let cleanupFn;

    beforeEach(async () => {
      const result = await create();
      backend = result.backend;
      cleanupFn = result.cleanup;
      await backend.init();
    });

    afterAll(async () => {
      if (cleanupFn) await cleanupFn();
    });

    it('get returns null for missing key', async () => {
      expect(await backend.get('nonexistent')).toBeNull();
    });

    it('set and get round-trip', async () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      await backend.set('test/key', data);
      const got = await backend.get('test/key');
      expect(got).not.toBeNull();
      expect(equal(got, data)).toBe(true);
    });

    it('overwrites existing key', async () => {
      await backend.set('key', new Uint8Array([1]));
      await backend.set('key', new Uint8Array([2]));
      const got = await backend.get('key');
      expect(got[0]).toBe(2);
    });

    it('handles nested paths', async () => {
      const data = fromUtf8('deep value');
      await backend.set('a/b/c/d/e', data);
      const got = await backend.get('a/b/c/d/e');
      expect(equal(got, data)).toBe(true);
    });

    it('delete removes a key', async () => {
      await backend.set('to-delete', new Uint8Array([99]));
      expect(await backend.delete('to-delete')).toBe(true);
      expect(await backend.get('to-delete')).toBeNull();
    });

    it('delete returns false for missing key', async () => {
      expect(await backend.delete('nope')).toBe(false);
    });

    it('handles binary data (Uint8Array)', async () => {
      const data = randomBytes(1000);
      await backend.set('binary', data);
      const got = await backend.get('binary');
      expect(equal(got, data)).toBe(true);
    });

    it('handles empty data', async () => {
      await backend.set('empty', new Uint8Array(0));
      const got = await backend.get('empty');
      expect(got).not.toBeNull();
      expect(got.length).toBe(0);
    });
  });
}

describe('Storage with MemoryBackend', () => {
  it('full round-trip: save and load identity', async () => {
    const backend = new MemoryBackend();
    const storage = new Storage(backend);
    await storage.init();

    const id = Identity.generate();
    await storage.saveTransportIdentity(id);

    const loaded = await storage.loadTransportIdentity();
    expect(loaded).not.toBeNull();
    expect(equal(loaded.hash, id.hash)).toBe(true);
  });

  it('full round-trip: save and load known destinations', async () => {
    const backend = new MemoryBackend();
    const storage = new Storage(backend);
    await storage.init();

    const id = Identity.generate();
    const table = new Map();
    table.set('aabb' + '00'.repeat(14), {
      identity: id,
      appData: fromUtf8('test'),
      hops: 2,
      timestamp: 1234567890,
    });

    await storage.saveKnownDestinations(table);
    const loaded = await storage.loadKnownDestinations();

    expect(loaded.size).toBe(1);
    const entry = loaded.get('aabb' + '00'.repeat(14));
    expect(entry).toBeDefined();
    expect(equal(entry.identity.publicKey, id.publicKey)).toBe(true);
  });

  it('full round-trip: save and load hashlist', async () => {
    const backend = new MemoryBackend();
    const storage = new Storage(backend);
    await storage.init();

    const hashlist = new Set(['abc', 'def', '123']);
    await storage.saveHashlist(hashlist);

    const loaded = await storage.loadHashlist();
    expect(loaded.size).toBe(3);
    expect(loaded.has('abc')).toBe(true);
    expect(loaded.has('def')).toBe(true);
  });

  it('full round-trip: cache and load announce', async () => {
    const backend = new MemoryBackend();
    const storage = new Storage(backend);
    await storage.init();

    const hash = randomBytes(32);
    const raw = randomBytes(200);

    await storage.cacheAnnounce(hash, raw, 'tcp-iface');
    const loaded = await storage.loadCachedAnnounce(hash);

    expect(loaded).not.toBeNull();
    expect(equal(loaded.raw, raw)).toBe(true);
    expect(loaded.interfaceName).toBe('tcp-iface');
  });

  it('returns null/empty for missing data', async () => {
    const backend = new MemoryBackend();
    const storage = new Storage(backend);
    await storage.init();

    expect(await storage.loadTransportIdentity()).toBeNull();
    expect(await storage.loadIdentity('nope')).toBeNull();
    expect((await storage.loadKnownDestinations()).size).toBe(0);
    expect(await storage.loadPathTable()).toEqual([]);
    expect((await storage.loadHashlist()).size).toBe(0);
    expect(await storage.loadCachedAnnounce(randomBytes(32))).toBeNull();
  });
});

describe('NodeFileBackend list()', () => {
  it('lists files under a prefix', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rns-list-'));
    const backend = new NodeFileBackend(dir);
    await backend.init();

    await backend.set('cache/announces/aabb', fromUtf8('1'));
    await backend.set('cache/announces/ccdd', fromUtf8('2'));
    await backend.set('cache/other', fromUtf8('3'));

    const keys = await backend.list('cache/announces');
    expect(keys).toHaveLength(2);
    expect(keys.some(k => k.includes('aabb'))).toBe(true);
    expect(keys.some(k => k.includes('ccdd'))).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  it('returns empty for nonexistent prefix', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rns-list-'));
    const backend = new NodeFileBackend(dir);
    await backend.init();

    const keys = await backend.list('nonexistent/path');
    expect(keys).toEqual([]);

    await rm(dir, { recursive: true, force: true });
  });
});
