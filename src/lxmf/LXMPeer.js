/**
 * LXMPeer — tracks a peered propagation node for message synchronization.
 *
 * Matches the Python reference implementation (LXMF/LXMPeer.py). Each peer
 * maintains sync state, transfer statistics, and tracks which messages have
 * been handled (synced to the peer) vs unhandled (pending sync).
 *
 * The handled/unhandled tracking is stored PER propagation entry in the
 * router's propagationEntries map (handledPeers / unhandledPeers Sets), not
 * duplicated inside the peer object. The peer provides convenience accessors
 * that scan the router's entries.
 */

import { Identity } from '../Identity.js';
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import { toHex, fromHex, equal } from '../utils/bytes.js';
import { log, LOG_DEBUG, LOG_WARNING } from '../utils/log.js';
import {
  PEER_IDLE, DEFAULT_SYNC_STRATEGY, STRATEGY_PERSISTENT,
  PEER_MAX_UNREACHABLE, PEER_SYNC_BACKOFF_STEP, PN_META_NAME,
} from './constants.js';

const TAG = 'LXMPeer';

export class LXMPeer {
  /**
   * @param {import('./LXMRouter.js').LXMRouter} router - Back-reference
   * @param {Uint8Array} destinationHash - 16-byte hash of the peer's propagation destination
   * @param {object} [options]
   * @param {number} [options.syncStrategy]
   */
  constructor(router, destinationHash, options = {}) {
    this.router = router;
    this.destinationHash = new Uint8Array(destinationHash);
    this.destinationHashHex = toHex(destinationHash);

    // Identity and destination (resolved from announce table)
    this.identity = null;
    this.destination = null;

    // State
    this.state = PEER_IDLE;
    this.alive = false;
    this.lastHeard = 0;
    this.syncStrategy = options.syncStrategy || DEFAULT_SYNC_STRATEGY;

    // Peering
    this.peeringKey = null;
    this.peeringCost = null;
    this.peeringTimebase = 0;
    this.metadata = null;

    // Sync timing
    this.nextSyncAttempt = 0;
    this.lastSyncAttempt = 0;
    this.syncBackoff = 0;

    // Transfer config (from remote announce)
    this.propagationTransferLimit = null;
    this.propagationSyncLimit = null;
    this.propagationStampCost = null;
    this.propagationStampCostFlexibility = null;

    // Transfer stats
    this.linkEstablishmentRate = 0;
    this.syncTransferRate = 0;
    this.offered = 0;
    this.outgoing = 0;
    this.incoming = 0;
    this.rxBytes = 0;
    this.txBytes = 0;

    // Link (active during sync)
    this.link = null;
    this.lastOffer = [];
    this.currentlyTransferringMessages = null;

    // Batching queues — items are transient ID hex strings
    this._handledQueue = [];
    this._unhandledQueue = [];

    // Cached counts (invalidated when queues modify entries)
    this._hmCount = 0;
    this._umCount = 0;
    this._hmCountsSynced = false;
    this._umCountsSynced = false;
  }

  // --- Handled / Unhandled message tracking ---
  //
  // These scan the router's propagationEntries to find messages relevant to
  // this peer. Each entry has `handledPeers` and `unhandledPeers` Sets
  // keyed by peer destination hash hex.

  /**
   * List of transient ID hex strings for messages that have been synced to
   * this peer. Matches Python LXMPeer.handled_messages property.
   * @returns {string[]}
   */
  get handledMessages() {
    const result = [];
    for (const [tidHex, entry] of this.router.propagationEntries) {
      if (entry.handledPeers && entry.handledPeers.has(this.destinationHashHex)) {
        result.push(tidHex);
      }
    }
    this._hmCount = result.length;
    this._hmCountsSynced = true;
    return result;
  }

  /**
   * List of transient ID hex strings for messages pending sync to this peer.
   * Matches Python LXMPeer.unhandled_messages property.
   * @returns {string[]}
   */
  get unhandledMessages() {
    const result = [];
    for (const [tidHex, entry] of this.router.propagationEntries) {
      if (entry.unhandledPeers && entry.unhandledPeers.has(this.destinationHashHex)) {
        result.push(tidHex);
      }
    }
    this._umCount = result.length;
    this._umCountsSynced = true;
    return result;
  }

  get handledMessageCount() {
    if (!this._hmCountsSynced) this._updateCounts();
    return this._hmCount;
  }

  get unhandledMessageCount() {
    if (!this._umCountsSynced) this._updateCounts();
    return this._umCount;
  }

  _updateCounts() {
    let hm = 0, um = 0;
    for (const [, entry] of this.router.propagationEntries) {
      if (entry.handledPeers && entry.handledPeers.has(this.destinationHashHex)) hm++;
      if (entry.unhandledPeers && entry.unhandledPeers.has(this.destinationHashHex)) um++;
    }
    this._hmCount = hm;
    this._umCount = um;
    this._hmCountsSynced = true;
    this._umCountsSynced = true;
  }

  get acceptanceRate() {
    return this.offered === 0 ? 0 : this.outgoing / this.offered;
  }

  get name() {
    if (this.metadata && typeof this.metadata === 'object' && PN_META_NAME in this.metadata) {
      try { return new TextDecoder().decode(new Uint8Array(this.metadata[PN_META_NAME])); }
      catch { return null; }
    }
    return null;
  }

  // --- Message set mutation ---

  addHandledMessage(transientIdHex) {
    const entry = this.router.propagationEntries.get(transientIdHex);
    if (!entry) return;
    if (!entry.handledPeers) entry.handledPeers = new Set();
    if (!entry.handledPeers.has(this.destinationHashHex)) {
      entry.handledPeers.add(this.destinationHashHex);
      this._hmCountsSynced = false;
    }
  }

  removeHandledMessage(transientIdHex) {
    const entry = this.router.propagationEntries.get(transientIdHex);
    if (!entry || !entry.handledPeers) return;
    if (entry.handledPeers.delete(this.destinationHashHex)) {
      this._hmCountsSynced = false;
    }
  }

  addUnhandledMessage(transientIdHex) {
    const entry = this.router.propagationEntries.get(transientIdHex);
    if (!entry) return;
    if (!entry.unhandledPeers) entry.unhandledPeers = new Set();
    if (!entry.unhandledPeers.has(this.destinationHashHex)) {
      entry.unhandledPeers.add(this.destinationHashHex);
      this._umCountsSynced = false;
    }
  }

  removeUnhandledMessage(transientIdHex) {
    const entry = this.router.propagationEntries.get(transientIdHex);
    if (!entry || !entry.unhandledPeers) return;
    if (entry.unhandledPeers.delete(this.destinationHashHex)) {
      this._umCountsSynced = false;
    }
  }

  // --- Batching queues ---
  //
  // Messages are queued for bulk processing rather than mutating the
  // propagation entries one at a time. Matches Python LXMPeer's
  // handled_messages_queue / unhandled_messages_queue deques.

  queueHandledMessage(transientIdHex) { this._handledQueue.push(transientIdHex); }
  queueUnhandledMessage(transientIdHex) { this._unhandledQueue.push(transientIdHex); }
  get queuedItems() { return this._handledQueue.length > 0 || this._unhandledQueue.length > 0; }

  /**
   * Drain both queues. For each handled item: add to handled, remove from
   * unhandled. For each unhandled item: add to unhandled if not already
   * handled. Matches Python LXMPeer.process_queues().
   */
  processQueues() {
    const handled = new Set(this.handledMessages);
    const unhandled = new Set(this.unhandledMessages);

    while (this._handledQueue.length > 0) {
      const tid = this._handledQueue.shift();
      if (!handled.has(tid)) this.addHandledMessage(tid);
      if (unhandled.has(tid)) this.removeUnhandledMessage(tid);
    }
    while (this._unhandledQueue.length > 0) {
      const tid = this._unhandledQueue.shift();
      if (!handled.has(tid) && !unhandled.has(tid)) {
        this.addUnhandledMessage(tid);
      }
    }
  }

  // --- Serialization ---
  //
  // Matches Python LXMPeer.to_bytes() / from_bytes() — msgpack dict with
  // the same keys so peer state files are cross-readable.

  toBytes() {
    const data = {
      peering_timebase: this.peeringTimebase,
      alive: this.alive,
      metadata: this.metadata,
      last_heard: this.lastHeard,
      sync_strategy: this.syncStrategy,
      peering_key: this.peeringKey ? Array.from(this.peeringKey) : null,
      destination_hash: Array.from(this.destinationHash),
      link_establishment_rate: this.linkEstablishmentRate,
      sync_transfer_rate: this.syncTransferRate,
      propagation_transfer_limit: this.propagationTransferLimit,
      propagation_sync_limit: this.propagationSyncLimit,
      propagation_stamp_cost: this.propagationStampCost,
      propagation_stamp_cost_flexibility: this.propagationStampCostFlexibility,
      peering_cost: this.peeringCost,
      last_sync_attempt: this.lastSyncAttempt,
      offered: this.offered,
      outgoing: this.outgoing,
      incoming: this.incoming,
      rx_bytes: this.rxBytes,
      tx_bytes: this.txBytes,
      handled_ids: this.handledMessages,
      unhandled_ids: this.unhandledMessages,
    };
    return new Uint8Array(msgpackEncode(data));
  }

  /**
   * Reconstruct an LXMPeer from serialized bytes. Matches Python
   * LXMPeer.from_bytes(). Only message IDs that still exist in the
   * router's propagationEntries are retained.
   *
   * @param {import('./LXMRouter.js').LXMRouter} router
   * @param {Uint8Array} bytes
   * @returns {LXMPeer|null}
   */
  static fromBytes(router, bytes) {
    try {
      const d = msgpackDecode(bytes);
      if (!d || !d.destination_hash) return null;

      const destHash = new Uint8Array(d.destination_hash);
      const peer = new LXMPeer(router, destHash, {
        syncStrategy: typeof d.sync_strategy === 'number' ? d.sync_strategy : DEFAULT_SYNC_STRATEGY,
      });

      peer.peeringTimebase = d.peering_timebase || 0;
      peer.alive = d.alive === true;
      peer.metadata = d.metadata || null;
      peer.lastHeard = d.last_heard || 0;
      peer.peeringKey = d.peering_key ? new Uint8Array(d.peering_key) : null;
      peer.linkEstablishmentRate = d.link_establishment_rate || 0;
      peer.syncTransferRate = d.sync_transfer_rate || 0;
      peer.propagationTransferLimit = d.propagation_transfer_limit != null
        ? Number(d.propagation_transfer_limit) : null;
      peer.propagationSyncLimit = d.propagation_sync_limit != null
        ? Number(d.propagation_sync_limit)
        : (peer.propagationTransferLimit || null);
      peer.propagationStampCost = d.propagation_stamp_cost != null
        ? Number(d.propagation_stamp_cost) : null;
      peer.propagationStampCostFlexibility = d.propagation_stamp_cost_flexibility != null
        ? Number(d.propagation_stamp_cost_flexibility) : null;
      peer.peeringCost = d.peering_cost != null ? Number(d.peering_cost) : null;
      peer.lastSyncAttempt = d.last_sync_attempt || 0;
      peer.offered = d.offered || 0;
      peer.outgoing = d.outgoing || 0;
      peer.incoming = d.incoming || 0;
      peer.rxBytes = d.rx_bytes || 0;
      peer.txBytes = d.tx_bytes || 0;

      // Reconstruct message sets — only keep IDs that exist in the router's store
      if (Array.isArray(d.handled_ids)) {
        for (const tid of d.handled_ids) {
          if (router.propagationEntries.has(tid)) {
            peer.addHandledMessage(tid);
          }
        }
      }
      if (Array.isArray(d.unhandled_ids)) {
        for (const tid of d.unhandled_ids) {
          if (router.propagationEntries.has(tid)) {
            peer.addUnhandledMessage(tid);
          }
        }
      }

      peer._hmCountsSynced = false;
      peer._umCountsSynced = false;

      return peer;
    } catch (err) {
      log(LOG_WARNING, TAG, `Failed to deserialize peer: ${err.message}`);
      return null;
    }
  }
}
