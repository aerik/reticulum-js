import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Storage } from '../src/utils/storage.js';
import { Identity } from '../src/Identity.js';
import { randomBytes, toHex, equal, fromUtf8 } from '../src/utils/bytes.js';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

let tempDir;
let storage;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'rns-test-'));
  storage = new Storage(tempDir);
  await storage.init();
});

afterAll(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe('Storage', () => {
  describe('transport identity', () => {
    it('saves and loads an identity', async () => {
      const id = Identity.generate();
      await storage.saveTransportIdentity(id);

      const loaded = await storage.loadTransportIdentity();
      expect(loaded).not.toBeNull();
      expect(equal(loaded.hash, id.hash)).toBe(true);
      expect(loaded.hasPrivateKey()).toBe(true);
    });

    it('returns null when no identity saved', async () => {
      const loaded = await storage.loadTransportIdentity();
      expect(loaded).toBeNull();
    });
  });

  describe('named identity files', () => {
    it('saves and loads by name', async () => {
      const id = Identity.generate();
      await storage.saveIdentity('my-node', id);

      const loaded = await storage.loadIdentity('my-node');
      expect(loaded).not.toBeNull();
      expect(equal(loaded.hash, id.hash)).toBe(true);
    });

    it('returns null for nonexistent name', async () => {
      expect(await storage.loadIdentity('nope')).toBeNull();
    });
  });

  describe('known destinations', () => {
    it('saves and loads destination → identity mappings', async () => {
      const id1 = Identity.generate();
      const id2 = Identity.generate();

      const table = new Map();
      table.set('aabbccdd' + '00'.repeat(12), {
        identity: id1,
        appData: fromUtf8('test app'),
        hops: 3,
        timestamp: Date.now() / 1000,
      });
      table.set('11223344' + '00'.repeat(12), {
        identity: id2,
        appData: null,
        hops: 1,
        timestamp: Date.now() / 1000,
      });

      await storage.saveKnownDestinations(table);

      const loaded = await storage.loadKnownDestinations();
      expect(loaded.size).toBe(2);

      const entry1 = loaded.get('aabbccdd' + '00'.repeat(12));
      expect(entry1).toBeDefined();
      expect(equal(entry1.identity.publicKey, id1.publicKey)).toBe(true);
      expect(equal(entry1.appData, fromUtf8('test app'))).toBe(true);
    });

    it('returns empty map when file missing', async () => {
      const loaded = await storage.loadKnownDestinations();
      expect(loaded.size).toBe(0);
    });
  });

  describe('path table', () => {
    it('saves and loads path entries', async () => {
      const table = new Map();
      table.set('deadbeef' + '00'.repeat(12), {
        timestamp: Date.now() / 1000,
        nextHop: randomBytes(16),
        hops: 3,
        expires: Date.now() / 1000 + 604800,
        interface: { name: 'tcp-dublin' },
        announcePacketHash: randomBytes(32),
      });

      await storage.savePathTable(table);

      const loaded = await storage.loadPathTable();
      expect(loaded.size).toBe(1);
      const key = 'deadbeef' + '00'.repeat(12);
      const entry = loaded.get(key);
      expect(entry).toBeDefined();
      expect(entry.hops).toBe(3);
      expect(entry.timestamp).toBeTypeOf('number');
      expect(entry.nextHop).toBeInstanceOf(Uint8Array);
    });

    it('skips malformed entries on save without throwing', async () => {
      const table = new Map();
      // A valid entry plus several malformed ones (the kind of garbage that
      // could leak in from a buggy load round-trip)
      table.set('aabbcc' + '00'.repeat(13), {
        timestamp: Date.now() / 1000,
        nextHop: new Uint8Array(16),
        hops: 1,
        expires: Date.now() / 1000 + 60,
      });
      table.set('11' + '00'.repeat(15), null);          // null entry
      table.set('22' + '00'.repeat(15), 12345);         // primitive
      table.set('33' + '00'.repeat(15), { hops: 2 });   // missing timestamp

      await expect(storage.savePathTable(table)).resolves.not.toThrow();

      const loaded = await storage.loadPathTable();
      expect(loaded.size).toBe(1); // only the valid entry survived
    });
  });

  describe('announce cache', () => {
    it('caches and loads announce packets', async () => {
      const packetHash = randomBytes(32);
      const raw = randomBytes(200);

      await storage.cacheAnnounce(packetHash, raw, 'tcp-interface');

      const cached = await storage.loadCachedAnnounce(packetHash);
      expect(cached).not.toBeNull();
      expect(equal(cached.raw, raw)).toBe(true);
      expect(cached.interfaceName).toBe('tcp-interface');
    });

    it('returns null for uncached packet', async () => {
      expect(await storage.loadCachedAnnounce(randomBytes(32))).toBeNull();
    });
  });

  describe('packet hashlist', () => {
    it('saves and loads hashlist', async () => {
      const hashlist = new Set(['abcd', 'ef01', '2345']);
      await storage.saveHashlist(hashlist);

      const loaded = await storage.loadHashlist();
      expect(loaded.size).toBe(3);
      expect(loaded.has('abcd')).toBe(true);
      expect(loaded.has('ef01')).toBe(true);
    });

    it('returns empty set when file missing', async () => {
      const loaded = await storage.loadHashlist();
      expect(loaded.size).toBe(0);
    });
  });
});
