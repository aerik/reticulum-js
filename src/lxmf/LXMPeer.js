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
import { Destination } from '../Destination.js';
import { Link } from '../Link.js';
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import { toHex, fromHex, equal, concat } from '../utils/bytes.js';
import { log, LOG_DEBUG, LOG_INFO, LOG_WARNING, LOG_VERBOSE } from '../utils/log.js';
import { generatePeeringKey } from './LXStamper.js';
import {
  PEER_IDLE, PEER_LINK_ESTABLISHING, PEER_LINK_READY, PEER_REQUEST_SENT,
  PEER_RESPONSE_RECEIVED, PEER_RESOURCE_TRANSFERRING,
  DEFAULT_SYNC_STRATEGY, STRATEGY_PERSISTENT,
  PEER_MAX_UNREACHABLE, PEER_SYNC_BACKOFF_STEP, PEER_PATH_REQUEST_GRACE,
  PN_META_NAME, OFFER_REQUEST_PATH,
  ERROR_NO_IDENTITY, ERROR_NO_ACCESS, ERROR_INVALID_KEY, ERROR_INVALID_DATA,
  ERROR_THROTTLED, APP_NAME,
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

  // --- Outbound sync state machine ---
  //
  // Matches Python LXMPeer.sync() + callbacks in LXMF/LXMPeer.py:267-542.
  // The Python version is synchronous with blocking sleeps and threading;
  // the JS version uses async/await and Link/RequestReceipt events while
  // preserving the same state transitions.

  /**
   * Whether it's OK to attempt a sync right now. Matches Python
   * `sync_checks` computation at the top of `sync()`.
   */
  get shouldSync() {
    const now = Date.now() / 1000;
    const syncTimeReached = now > this.nextSyncAttempt;
    const stampCostsKnown = this.propagationStampCost != null
      && this.propagationStampCostFlexibility != null
      && this.peeringCost != null;
    return syncTimeReached && stampCostsKnown;
  }

  /**
   * Resolve (or reuse) the outbound destination for this peer. Needs the
   * remote identity which is cached in Transport.announceTable after the
   * peer's announce was validated.
   */
  _resolveDestination() {
    if (this.destination) return this.destination;
    if (!this.identity) {
      const entry = this.router.transport.announceTable.get(this.destinationHashHex);
      if (entry && entry.identity) this.identity = entry.identity;
    }
    if (this.identity) {
      this.destination = new Destination(this.identity, 0x12 /* DEST_OUT */, 0x00 /* DEST_SINGLE */, APP_NAME, 'propagation');
    }
    return this.destination;
  }

  /**
   * Initiate a sync with this peer. Returns true if sync was attempted,
   * false if preconditions weren't met.
   *
   * Maps to Python LXMPeer.sync() at LXMF/LXMPeer.py:267. Phases:
   *   1. Check gates (timing, costs).
   *   2. Open link.
   *   3. Build offer from unhandled messages (respecting transfer limit).
   *   4. Send /offer request, await response.
   *   5. For the subset the peer wants, send a resource with the raw data.
   *   6. On resource complete, move messages to handled and optionally
   *      re-sync (persistent strategy).
   */
  async sync() {
    if (this.state !== PEER_IDLE) {
      log(LOG_DEBUG, TAG, `sync() called while peer state=${this.state}, skipping`);
      return false;
    }

    this.lastSyncAttempt = Date.now() / 1000;

    if (!this.shouldSync) {
      log(LOG_DEBUG, TAG, `sync postponed — gate not reached for ${this.destinationHashHex.slice(0,16)}..`);
      return false;
    }

    if (this.unhandledMessageCount === 0) {
      log(LOG_DEBUG, TAG, `No unhandled messages for ${this.destinationHashHex.slice(0,16)}.., nothing to sync`);
      return false;
    }

    // Resolve destination from cached identity
    const dest = this._resolveDestination();
    if (!dest) {
      log(LOG_DEBUG, TAG, `No identity cached for ${this.destinationHashHex.slice(0,16)}.., deferring sync`);
      return false;
    }

    // Increment backoff immediately so retry waits even on mid-flight failure
    this.syncBackoff += PEER_SYNC_BACKOFF_STEP;
    this.nextSyncAttempt = Date.now() / 1000 + this.syncBackoff;
    this.state = PEER_LINK_ESTABLISHING;

    try {
      // --- Establish link ---
      this.link = Link.init(dest, this.router.transport);
      this.router.transport.registerPendingLink(this.link);
      await new Promise((resolve, reject) => {
        this.link.on('established', resolve);
        this.link.on('closed', () => reject(new Error('Link closed before establishment')));
        setTimeout(() => reject(new Error('Link establishment timeout')), 30_000);
      });

      this.state = PEER_LINK_READY;
      this.alive = true;
      this.lastHeard = Date.now() / 1000;
      this.syncBackoff = 0;
      this.nextSyncAttempt = 0;

      // --- Build offer ---
      // Filter unhandled messages by transfer / sync limits (matches Python
      // LXMPeer.sync():358-379). Skip stamp-cost filtering since the JS
      // router defaults stamp_cost = 0.
      const perMessageOverhead = 16;
      const transferLimitBytes = (this.propagationTransferLimit || 256) * 1000;
      const syncLimitBytes = (this.propagationSyncLimit || transferLimitBytes / 1000) * 1000;
      let cumulativeSize = 24;

      const offeredIds = [];
      const offeredRawIds = [];
      for (const tidHex of this.unhandledMessages) {
        const entry = this.router.propagationEntries.get(tidHex);
        if (!entry) {
          this.removeUnhandledMessage(tidHex);
          continue;
        }
        const lxmTransferSize = entry.size + perMessageOverhead;
        // Drop messages that exceed the per-message transfer limit entirely.
        if (lxmTransferSize > transferLimitBytes) {
          log(LOG_DEBUG, TAG,
            `Message ${tidHex.slice(0,16)}.. exceeds peer transfer limit, marking handled`);
          this.removeUnhandledMessage(tidHex);
          this.addHandledMessage(tidHex);
          continue;
        }
        // Stop when per-sync cumulative limit would be exceeded.
        if (cumulativeSize + lxmTransferSize >= syncLimitBytes) break;
        cumulativeSize += lxmTransferSize;

        const rawId = fromHex(tidHex);
        offeredRawIds.push(rawId);
        offeredIds.push(tidHex);
      }

      if (offeredIds.length === 0) {
        this._teardown();
        return false;
      }

      this.lastOffer = offeredIds;

      // --- Generate peering key ---
      // Matches Python: peering_id = router.identity.hash + remote_identity.hash
      const localHash = this.router.propagationIdentity
        ? this.router.propagationIdentity.hash : new Uint8Array(16);
      const remoteHash = this.identity ? this.identity.hash : new Uint8Array(16);
      const peeringId = concat(localHash, remoteHash);
      const { stamp: peeringKey } = generatePeeringKey(peeringId, this.peeringCost || 0);
      this.peeringKey = peeringKey;

      // --- Send /offer request ---
      this.state = PEER_REQUEST_SENT;
      const offerPayload = [peeringKey, offeredRawIds];
      const offerBytes = new Uint8Array(msgpackEncode(offerPayload));

      // Note: the JS Link.request() encodes [timestamp, pathHash, data]
      // automatically, so we pass the already-msgpack'd offer as the data field.
      // The remote's /offer handler will receive and decode offerBytes.
      const response = await this.link.request(OFFER_REQUEST_PATH, offerBytes, { timeout: 30_000 });

      if (response == null) {
        log(LOG_WARNING, TAG, `Offer request to ${this.destinationHashHex.slice(0,16)}.. timed out`);
        this._teardown();
        return false;
      }

      this.state = PEER_RESPONSE_RECEIVED;

      // Decode the response (msgpack-encoded by the handler)
      let decoded;
      try { decoded = msgpackDecode(response); }
      catch (err) {
        log(LOG_WARNING, TAG, `Could not decode offer response: ${err.message}`);
        this._teardown();
        return false;
      }

      // --- Handle response ---
      let wantedIds;
      if (decoded === true) {
        wantedIds = offeredIds.slice();
      } else if (decoded === false) {
        // Peer already has all; mark them handled locally.
        for (const tidHex of this.lastOffer) {
          this.addHandledMessage(tidHex);
          this.removeUnhandledMessage(tidHex);
        }
        this.offered += this.lastOffer.length;
        this._teardown();
        return true;
      } else if (Array.isArray(decoded)) {
        const wantedSet = new Set(decoded.map((id) => toHex(new Uint8Array(id))));
        // Mark not-wanted messages as handled immediately (peer already has them)
        for (const tidHex of this.lastOffer) {
          if (!wantedSet.has(tidHex)) {
            this.addHandledMessage(tidHex);
            this.removeUnhandledMessage(tidHex);
          }
        }
        wantedIds = [...wantedSet];
      } else if (typeof decoded === 'number') {
        // Error code from remote
        log(LOG_WARNING, TAG, `Remote peer returned error 0x${decoded.toString(16)}`);
        if (decoded === ERROR_NO_ACCESS) {
          this.router.unpeer(this.destinationHash);
        }
        this._teardown();
        return false;
      } else {
        log(LOG_WARNING, TAG, `Unexpected offer response type: ${typeof decoded}`);
        this._teardown();
        return false;
      }

      if (wantedIds.length === 0) {
        this.offered += this.lastOffer.length;
        this._teardown();
        return true;
      }

      // --- Send wanted messages as a Resource ---
      const lxmList = [];
      for (const tidHex of wantedIds) {
        const entry = this.router.propagationEntries.get(tidHex);
        if (entry && entry.data) lxmList.push(entry.data);
      }

      const resourceData = new Uint8Array(
        msgpackEncode([Date.now() / 1000, lxmList.map((b) => Array.from(b))])
      );

      this.currentlyTransferringMessages = wantedIds;
      this.state = PEER_RESOURCE_TRANSFERRING;
      const transferStart = Date.now();

      try {
        await this.link.sendResource(resourceData, { timeoutMs: 120_000 });
      } catch (err) {
        log(LOG_WARNING, TAG, `Sync resource transfer to ${this.destinationHashHex.slice(0,16)}.. failed: ${err.message}`);
        this.currentlyTransferringMessages = null;
        this._teardown();
        return false;
      }

      // --- Resource concluded successfully ---
      // Move all transferred messages from unhandled → handled
      for (const tidHex of wantedIds) {
        this.addHandledMessage(tidHex);
        this.removeUnhandledMessage(tidHex);
      }

      const durationSec = (Date.now() - transferStart) / 1000;
      if (durationSec > 0) {
        this.syncTransferRate = (resourceData.length * 8) / durationSec;
      }

      this.alive = true;
      this.lastHeard = Date.now() / 1000;
      this.offered += this.lastOffer.length;
      this.outgoing += wantedIds.length;
      this.txBytes += resourceData.length;

      this.currentlyTransferringMessages = null;
      this._teardown();

      log(LOG_VERBOSE, TAG,
        `Synced ${wantedIds.length} messages to ${this.destinationHashHex.slice(0,16)}..`);

      // Persistent strategy: re-sync if more work remains
      if (this.syncStrategy === STRATEGY_PERSISTENT && this.unhandledMessageCount > 0) {
        setImmediate(() => this.sync().catch(() => {}));
      }

      return true;

    } catch (err) {
      log(LOG_WARNING, TAG, `Sync with ${this.destinationHashHex.slice(0,16)}.. failed: ${err.message}`);
      this._teardown();
      return false;
    }
  }

  _teardown() {
    if (this.link) {
      try { this.link.close(); } catch {}
      this.link = null;
    }
    this.state = PEER_IDLE;
  }
}
