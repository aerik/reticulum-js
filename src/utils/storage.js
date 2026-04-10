/**
 * Storage — persistence layer for RNS data.
 *
 * Uses a pluggable StorageBackend:
 * - NodeFileBackend (default on Node.js) — files under ~/.reticulum/
 * - IndexedDBBackend (browser) — IndexedDB key-value store
 * - MemoryBackend (testing) — in-memory, no persistence
 *
 * Key layout (slash-separated, matching Python directory structure):
 *   storage/transport_identity
 *   storage/known_destinations
 *   storage/destination_table
 *   storage/packet_hashlist
 *   storage/identities/{name}
 *   storage/cache/announces/{hex_hash}
 */

import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import { Identity } from '../Identity.js';
import { toHex } from './bytes.js';
import { log, LOG_DEBUG, LOG_WARNING } from './log.js';
import { NodeFileBackend } from './storage-backend.js';

const TAG = 'Storage';

export class Storage {
  /**
   * @param {import('./storage-backend.js').StorageBackend|string} backendOrConfigDir
   *   If a string, creates a NodeFileBackend at that path.
   *   If a StorageBackend instance, uses it directly.
   */
  constructor(backendOrConfigDir) {
    if (typeof backendOrConfigDir === 'string') {
      this.backend = new NodeFileBackend(backendOrConfigDir);
    } else {
      this.backend = backendOrConfigDir;
    }
  }

  /**
   * Initialize the storage backend.
   */
  async init() {
    await this.backend.init();
    log(LOG_DEBUG, TAG, 'Storage initialized');
  }

  /**
   * Close the storage backend.
   */
  async close() {
    await this.backend.close();
  }

  // --- Transport Identity ---

  async saveTransportIdentity(identity) {
    await this.backend.set('storage/transport_identity', identity.exportPrivateKey());
    log(LOG_DEBUG, TAG, 'Saved transport identity');
  }

  async loadTransportIdentity() {
    const data = await this.backend.get('storage/transport_identity');
    if (!data) return null;
    const identity = Identity.fromPrivateKey(data);
    log(LOG_DEBUG, TAG, `Loaded transport identity: ${identity.hexHash}`);
    return identity;
  }

  // --- Named Identity Files ---

  async saveIdentity(name, identity) {
    await this.backend.set(`storage/identities/${name}`, identity.exportPrivateKey());
  }

  async loadIdentity(name) {
    const data = await this.backend.get(`storage/identities/${name}`);
    if (!data) return null;
    return Identity.fromPrivateKey(data);
  }

  // --- Known Destinations ---

  async saveKnownDestinations(announceTable) {
    const dict = {};
    let skipped = 0;
    for (const [hexHash, entry] of announceTable) {
      // Defensive: skip malformed entries (null, missing identity, etc.)
      if (!entry || !entry.identity || !entry.identity.publicKey) {
        skipped++;
        continue;
      }
      dict[hexHash] = [
        entry.timestamp,
        null,
        Array.from(entry.identity.publicKey),
        entry.appData ? Array.from(entry.appData) : null,
      ];
    }
    const packed = new Uint8Array(msgpackEncode(dict));
    await this.backend.set('storage/known_destinations', packed);
    log(LOG_DEBUG, TAG,
      `Saved ${announceTable.size - skipped} known destinations` +
      (skipped ? ` (skipped ${skipped} malformed)` : ''));
  }

  async loadKnownDestinations() {
    const result = new Map();
    const data = await this.backend.get('storage/known_destinations');
    if (!data) return result;

    try {
      const dict = msgpackDecode(data);
      for (const [hexHash, entry] of Object.entries(dict)) {
        const [timestamp, _packetHash, publicKeyArr, appDataArr] = entry;
        const publicKey = new Uint8Array(publicKeyArr);
        const identity = Identity.fromPublicKey(publicKey);
        result.set(hexHash, {
          identity,
          appData: appDataArr ? new Uint8Array(appDataArr) : null,
          hops: 0,
          timestamp,
        });
      }
      log(LOG_DEBUG, TAG, `Loaded ${result.size} known destinations`);
    } catch (err) {
      log(LOG_WARNING, TAG, `Failed to parse known_destinations: ${err.message}`);
    }
    return result;
  }

  // --- Path Table ---

  async savePathTable(pathTable) {
    const entries = [];
    let skipped = 0;
    for (const [hexHash, entry] of pathTable) {
      // Defensive: skip malformed entries (null, primitives, missing fields)
      if (!entry || typeof entry !== 'object' || entry.timestamp == null) {
        skipped++;
        continue;
      }
      entries.push([
        hexHash,
        entry.timestamp,
        entry.nextHop ? Array.from(entry.nextHop) : null,
        entry.hops,
        entry.expires,
        null,
        entry.interface ? entry.interface.name : null,
        entry.announcePacketHash ? Array.from(entry.announcePacketHash) : null,
      ]);
    }
    const packed = new Uint8Array(msgpackEncode(entries));
    await this.backend.set('storage/destination_table', packed);
    log(LOG_DEBUG, TAG,
      `Saved ${pathTable.size - skipped} path table entries` +
      (skipped ? ` (skipped ${skipped} malformed)` : ''));
  }

  /**
   * Load the persisted path table.
   * Returns a Map of `hexHash → entryObject` so callers can directly merge it
   * into transport.pathTable. The on-disk format is a positional array per
   * entry; we reconstruct the object form here.
   *
   * @returns {Promise<Map<string, object>>}
   */
  async loadPathTable() {
    const result = new Map();
    const data = await this.backend.get('storage/destination_table');
    if (!data) return result;
    try {
      const entries = msgpackDecode(data);
      if (!Array.isArray(entries)) return result;
      for (const e of entries) {
        if (!Array.isArray(e) || e.length < 5) continue;
        const [hexHash, timestamp, nextHopArr, hops, expires, _unused, ifaceName, announceHashArr] = e;
        if (!hexHash || timestamp == null) continue;
        result.set(hexHash, {
          timestamp,
          nextHop: nextHopArr ? new Uint8Array(nextHopArr) : null,
          hops: hops || 0,
          expires,
          interface: null,                // resolved later by Transport (we only have name here)
          interfaceName: ifaceName || null,
          announcePacketHash: announceHashArr ? new Uint8Array(announceHashArr) : null,
        });
      }
      log(LOG_DEBUG, TAG, `Loaded ${result.size} path table entries`);
    } catch (err) {
      log(LOG_WARNING, TAG, `Failed to parse destination_table: ${err.message}`);
    }
    return result;
  }

  // --- LXMF Outbound Queue ---

  /**
   * Save an outbound LXMF entry. Used by LXMRouter to persist its
   * pendingOutbound map across rnsd restarts.
   *
   * @param {string} msgIdHex - Hex of the LXMessage hash (32 bytes → 64 chars)
   * @param {object} entry - { packed, method, desiredMethod, attempts,
   *                            nextAttempt, propagationNodeHash, sourceHash,
   *                            destinationHash, sourceIdentityHash }
   */
  async saveOutboundEntry(msgIdHex, entry) {
    const key = `storage/lxmf/outbound/${msgIdHex}`;
    const packed = new Uint8Array(msgpackEncode({
      packed: Array.from(entry.packed),
      method: entry.method || 0,
      desiredMethod: entry.desiredMethod || 0,
      attempts: entry.attempts || 0,
      nextAttempt: entry.nextAttempt || 0,
      propagationNodeHash: entry.propagationNodeHash
        ? Array.from(entry.propagationNodeHash) : null,
      sourceHash: entry.sourceHash ? Array.from(entry.sourceHash) : null,
      destinationHash: entry.destinationHash ? Array.from(entry.destinationHash) : null,
      sourceIdentityHash: entry.sourceIdentityHash
        ? Array.from(entry.sourceIdentityHash) : null,
      createdAt: entry.createdAt || Date.now() / 1000,
    }));
    await this.backend.set(key, packed);
  }

  /**
   * Delete an outbound entry (after successful delivery or terminal failure).
   * @param {string} msgIdHex
   */
  async deleteOutboundEntry(msgIdHex) {
    const key = `storage/lxmf/outbound/${msgIdHex}`;
    await this.backend.delete(key);
  }

  /**
   * Load all persisted outbound entries.
   * @returns {Promise<Map<string, object>>} msgIdHex → entry
   */
  async loadOutboundEntries() {
    const result = new Map();
    const prefix = 'storage/lxmf/outbound/';
    let keys;
    try {
      keys = await this.backend.list(prefix);
    } catch {
      return result;
    }
    for (const key of keys) {
      const msgIdHex = key.slice(prefix.length);
      const data = await this.backend.get(key);
      if (!data) continue;
      try {
        const decoded = msgpackDecode(data);
        result.set(msgIdHex, {
          packed: new Uint8Array(decoded.packed),
          method: decoded.method,
          desiredMethod: decoded.desiredMethod,
          attempts: decoded.attempts,
          nextAttempt: decoded.nextAttempt,
          propagationNodeHash: decoded.propagationNodeHash
            ? new Uint8Array(decoded.propagationNodeHash) : null,
          sourceHash: decoded.sourceHash ? new Uint8Array(decoded.sourceHash) : null,
          destinationHash: decoded.destinationHash
            ? new Uint8Array(decoded.destinationHash) : null,
          sourceIdentityHash: decoded.sourceIdentityHash
            ? new Uint8Array(decoded.sourceIdentityHash) : null,
          createdAt: decoded.createdAt,
        });
      } catch (err) {
        log(LOG_WARNING, TAG, `Failed to parse outbound entry ${msgIdHex}: ${err.message}`);
      }
    }
    if (result.size > 0) {
      log(LOG_DEBUG, TAG, `Loaded ${result.size} pending outbound LXMF entries`);
    }
    return result;
  }

  // --- Announce Cache ---

  async cacheAnnounce(packetHash, raw, interfaceName) {
    const key = `storage/cache/announces/${toHex(packetHash)}`;
    const packed = new Uint8Array(msgpackEncode([Array.from(raw), interfaceName]));
    await this.backend.set(key, packed);
  }

  async loadCachedAnnounce(packetHash) {
    const key = `storage/cache/announces/${toHex(packetHash)}`;
    const data = await this.backend.get(key);
    if (!data) return null;
    const [rawArr, interfaceName] = msgpackDecode(data);
    return { raw: new Uint8Array(rawArr), interfaceName };
  }

  /**
   * Prune announce cache to at most maxEntries, removing oldest first.
   * @param {number} maxEntries
   */
  async pruneAnnounceCache(maxEntries = 20000) {
    const prefix = 'storage/cache/announces/';
    const keys = await this.backend.list(prefix);
    if (keys.length <= maxEntries) return;

    // Sort by key (hex hash — not time-ordered, but stable).
    // For proper time-ordered eviction we'd need metadata, but this
    // is sufficient to bound disk usage. Remove the excess.
    const toRemove = keys.length - maxEntries;
    for (let i = 0; i < toRemove; i++) {
      await this.backend.delete(keys[i]);
    }
    log(LOG_INFO, TAG, `Pruned announce cache: removed ${toRemove} entries (${keys.length} → ${maxEntries})`);
  }

  // --- Packet Hashlist ---

  async saveHashlist(hashlist) {
    const arr = [...hashlist];
    const packed = new Uint8Array(msgpackEncode(arr));
    await this.backend.set('storage/packet_hashlist', packed);
  }

  async loadHashlist() {
    const data = await this.backend.get('storage/packet_hashlist');
    if (!data) return new Set();
    try {
      const arr = msgpackDecode(data);
      return new Set(arr);
    } catch (err) {
      log(LOG_WARNING, TAG, `Failed to parse packet_hashlist: ${err.message}`);
      return new Set();
    }
  }
}
