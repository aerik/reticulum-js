/**
 * LXMRouter — LXMF message routing, delivery, and propagation.
 *
 * Matches the Python reference implementation (LXMF/LXMRouter.py).
 *
 * Two modes:
 *   1. Delivery: accepts direct messages via Link to lxmf.delivery destination
 *   2. Propagation: stores messages for offline recipients, serves via /get endpoint
 *
 * Usage:
 *   const router = new LXMRouter(transport);
 *   router.registerDeliveryIdentity(myIdentity, { displayName: 'My Node' });
 *   router.onMessage((message) => console.log(message.content));
 *   router.enablePropagation({ storagePath: '/path/to/store' });
 */

import { EventEmitter } from '../utils/events.js';
import { Destination } from '../Destination.js';
import { Identity } from '../Identity.js';
import { Link, ACCEPT_APP } from '../Link.js';
import { Packet } from '../Packet.js';
import {
  LXMessage, LXMF_OVERHEAD, DESTINATION_LENGTH, SIGNATURE_LENGTH,
  DIRECT, PROPAGATED, OPPORTUNISTIC,
  OUTBOUND, SENDING, SENT, DELIVERED, FAILED,
} from './LXMessage.js';
import { APP_NAME, MESSAGE_GET_PATH, MESSAGE_EXPIRY,
         ERROR_NO_IDENTITY, ERROR_NO_ACCESS, PROPAGATION_LIMIT,
         DELIVERY_LIMIT } from './constants.js';
import { sha256Hash, truncatedHash } from '../utils/crypto.js';
import { concat, toHex, equal, fromUtf8 } from '../utils/bytes.js';
import { log, LOG_DEBUG, LOG_INFO, LOG_WARNING, LOG_ERROR } from '../utils/log.js';
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import { createAnnounce } from '../Announce.js';
import {
  DEST_IN, DEST_OUT, DEST_SINGLE,
  PACKET_DATA, HEADER_1, TRANSPORT_BROADCAST, CONTEXT_NONE,
} from '../constants.js';

const TAG = 'LXMRouter';

// Stamp size (matching Python LXStamper.STAMP_SIZE)
const STAMP_SIZE = 32;

export class LXMRouter extends EventEmitter {
  /**
   * @param {import('../Transport.js').Transport} transport
   * @param {object} [options]
   * @param {string} [options.storagePath] - Path for propagation message storage
   * @param {number} [options.messageExpiry] - Message expiry in seconds (default 30 days)
   * @param {number} [options.propagationLimit] - Max KB per propagation transfer
   */
  constructor(transport, options = {}) {
    super();
    this.transport = transport;
    this.storagePath = options.storagePath || null;
    // Storage instance (from Reticulum.start) used to persist the outbound
    // queue across restarts. Optional: when omitted, the queue is RAM-only.
    this.storage = options.storage || null;
    this.messageExpiry = options.messageExpiry || MESSAGE_EXPIRY;
    this.propagationLimit = (options.propagationLimit || PROPAGATION_LIMIT) * 1000;

    // Maximum data size accepted for a single inbound delivery resource, in KB.
    // Matches Python LXMF/LXMRouter.py:56 DELIVERY_LIMIT = 1000.
    this.deliveryPerTransferLimit = options.deliveryLimit || DELIVERY_LIMIT;

    // Delivery destinations: destHashHex → { identity, destination, displayName, stampCost }
    this.deliveryDestinations = new Map();

    // Propagation node state
    this.propagationNode = false;
    this.propagationIdentity = null;
    this.propagationDestination = null;

    // Message storage: transientIdHex → { destinationHash, data, received, size, stampValue }
    this.propagationEntries = new Map();

    // Dedup tracking
    this.locallyDeliveredIds = new Map();   // transientIdHex → timestamp
    this.locallyProcessedIds = new Map();   // transientIdHex → timestamp

    // Delivered messages (for web interface / retrieval)
    this.deliveredMessages = [];

    // Callbacks
    this._messageCallback = null;
    this._deliveryCallbacks = new Map(); // destHashHex → callback

    // Peering state — matches Python LXMRouter peers dict
    this.peers = new Map();              // destHashHex → LXMPeer
    this.peerDistributionQueue = [];     // [{ transientIdHex, fromPeerHex }]

    // Active links for delivery
    this._deliveryLinks = new Map(); // destHashHex → link

    // --- Outbound state (matching Python LXMRouter) ---
    // pendingOutbound: msgIdHex → { message, nextAttempt, method, destHex, targetHex, sourceIdentity }
    this.pendingOutbound = new Map();
    // outboundLinks: destHex → { link, state: 'opening'|'open'|'closing', queue: [msgIdHex], openedAt }
    this.outboundLinks = new Map();

    this.DELIVERY_RETRY_WAIT  = options.deliveryRetryWait  || 10_000; // ms
    this.MAX_DELIVERY_ATTEMPTS = options.maxDeliveryAttempts || 5;
    this.LINK_MAX_INACTIVITY  = options.linkMaxInactivity  || 30_000; // ms
    this.OPPORTUNISTIC_MAX_BYTES = options.opportunisticMaxBytes || 368; // packed size cutoff

    // Outbound processing interval (matches Python's process_outbound 5-second tick)
    this._outboundInterval = null;
    if (options.autoStart !== false) {
      this._outboundInterval = setInterval(() => {
        try { this._processOutbound(); } catch (err) {
          log(LOG_WARNING, TAG, `Outbound processor error: ${err.message}`);
        }
      }, 5000);
      if (this._outboundInterval.unref) this._outboundInterval.unref();
    }
  }

  /**
   * Stop background tasks (outbound processor, etc). Call before teardown.
   */
  stop() {
    if (this._outboundInterval) {
      clearInterval(this._outboundInterval);
      this._outboundInterval = null;
    }
  }

  /**
   * Register an identity for LXMF delivery.
   * Creates an lxmf.delivery destination and announces it.
   *
   * Matching Python LXMRouter.register_delivery_identity().
   *
   * @param {Identity} identity - Identity with private key
   * @param {object} [options]
   * @param {string} [options.displayName] - Display name for announce
   * @param {number} [options.stampCost] - Required PoW stamp cost (null = no stamp required)
   * @returns {Destination} The delivery destination
   */
  registerDeliveryIdentity(identity, options = {}) {
    const destination = new Destination(
      identity, DEST_IN, DEST_SINGLE, APP_NAME, 'delivery'
    );
    const destHex = toHex(destination.hash);

    this.deliveryDestinations.set(destHex, {
      identity,
      destination,
      displayName: options.displayName || null,
      stampCost: options.stampCost || null,
    });

    // Register with transport
    this.transport.registerDestination(destination);

    // Set up link callback for direct delivery
    destination.setLinkCallback((link) => {
      this._deliveryLinkEstablished(link, destHex);
      return true; // accept the link
    });

    // Set up packet callback for opportunistic delivery
    destination.setPacketCallback((data, packet) => {
      this._deliveryPacket(data, packet, destination);
    });

    log(LOG_INFO, TAG, `Registered delivery identity: ${destHex}`);
    return destination;
  }

  /**
   * Announce a delivery destination.
   * App data format: msgpack([displayName, stampCost])
   * Matching Python LXMRouter announce format.
   * @param {Uint8Array} destHash
   */
  announceDelivery(destHash) {
    const destHex = toHex(destHash);
    const entry = this.deliveryDestinations.get(destHex);
    if (!entry) return;

    const displayNameBytes = entry.displayName
      ? new TextEncoder().encode(entry.displayName)
      : null;
    const appData = new Uint8Array(msgpackEncode([displayNameBytes, entry.stampCost]));

    const pkt = createAnnounce(entry.destination, appData);
    this.transport.transmit(pkt);
    log(LOG_INFO, TAG, `Announced delivery destination: ${destHex}`);
  }

  /**
   * Announce all registered delivery destinations.
   */
  announceAll() {
    for (const [destHex, entry] of this.deliveryDestinations) {
      this.announceDelivery(entry.destination.hash);
    }
    if (this.propagationDestination) {
      this.announcePropagation();
    }
  }

  /**
   * Announce the propagation destination.
   */
  announcePropagation() {
    if (!this.propagationDestination) return;
    const appData = new Uint8Array(msgpackEncode([
      null,   // peering key
      0,      // timebase
      true,   // propagation enabled
      PROPAGATION_LIMIT, // transfer limit KB
      PROPAGATION_LIMIT * 40, // sync limit KB
      [0, 0, 0], // [stamp_cost, flexibility, peering_cost]
      {},     // metadata
    ]));
    const pkt = createAnnounce(this.propagationDestination, appData);
    this.transport.transmit(pkt);
    log(LOG_INFO, TAG, `Announced propagation destination: ${toHex(this.propagationDestination.hash)}`);
  }

  /**
   * Set the callback for received messages.
   * @param {function(LXMessage): void} callback
   */
  onMessage(callback) {
    this._messageCallback = callback;
  }

  /**
   * Set a per-destination delivery callback.
   * @param {Uint8Array} destHash
   * @param {function(LXMessage): void} callback
   */
  onDeliveryTo(destHash, callback) {
    this._deliveryCallbacks.set(toHex(destHash), callback);
  }

  // --- Delivery via Link ---

  /**
   * Handle a new link established to a delivery destination.
   * Matching Python LXMRouter.delivery_link_established().
   * @param {import('../Link.js').Link} link
   * @param {string} destHex
   */
  _deliveryLinkEstablished(link, destHex) {
    log(LOG_INFO, TAG, `Delivery link established for ${destHex}`);

    this._deliveryLinks.set(destHex, link);

    // Resource acceptance strategy with delivery-limit check, matching Python
    // LXMRouter.delivery_link_established() → sets ACCEPT_APP with
    // delivery_resource_advertised callback (LXMRouter.py:1846-1868).
    const limit = this.deliveryPerTransferLimit * 1000; // KB → bytes
    link.setResourceStrategy(ACCEPT_APP);
    link.setResourceCallback((adv) => {
      if (limit != null && adv.dataSize > limit) {
        log(LOG_DEBUG, TAG,
          `Rejecting incoming delivery resource: ${adv.dataSize} bytes ` +
          `exceeds limit of ${limit} bytes`);
        return false;
      }
      return true;
    });

    // Set up to receive messages as packets or resources on this link
    link.on('data', (plaintext, packet) => {
      // Send delivery proof (matching Python delivery_packet → packet.prove())
      if (packet) link.provePacket(packet);
      this._deliveryLinkData(plaintext, destHex, DIRECT);
    });

    link.on('resource_complete', (data) => {
      this._deliveryLinkData(data, destHex, DIRECT);
    });

    link.on('closed', () => {
      this._deliveryLinks.delete(destHex);
    });
  }

  /**
   * Handle data received on a delivery link (a direct LXMF message).
   * @param {Uint8Array} data
   * @param {string} destHex
   * @param {number} method
   */
  _deliveryLinkData(data, destHex, method) {
    try {
      this._lxmfDelivery(data, method);
    } catch (err) {
      log(LOG_WARNING, TAG, `Failed to process delivery link data: ${err.message}`);
    }
  }

  // --- Outbound (handleOutbound + dispatchers) ---

  /**
   * Accept an LXMessage for delivery. Matches Python LXMRouter.handle_outbound().
   *
   * The message must have destinationHash set. If sourceHash is not set, the
   * first registered delivery destination will be used as the source.
   *
   * This method returns immediately; the message is queued and processed on
   * the next outbound tick (or immediately for opportunistic with known path).
   * Callers observe progress via `message.state` and the `deliveryCallback` /
   * `failedCallback` fields, or by listening for the router's 'outbound' event.
   *
   * @param {LXMessage} message
   * @param {object} [options]
   * @param {Identity} [options.sourceIdentity] - Override source identity
   * @param {Uint8Array} [options.propagationNodeHash] - Required for PROPAGATED
   * @returns {LXMessage} The same message (for chaining)
   */
  handleOutbound(message, options = {}) {
    if (!message.destinationHash) {
      throw new Error('LXMessage.destinationHash is required');
    }

    // Resolve source identity & source destination hash
    let sourceIdentity = options.sourceIdentity || null;
    let sourceDest = null;

    if (!sourceIdentity) {
      // Default: first delivery destination with a private key
      for (const entry of this.deliveryDestinations.values()) {
        if (entry.identity && entry.identity.hasPrivateKey()) {
          sourceIdentity = entry.identity;
          sourceDest = entry.destination;
          break;
        }
      }
    } else {
      // Find the matching delivery destination for this identity (if any)
      for (const entry of this.deliveryDestinations.values()) {
        if (entry.identity === sourceIdentity) {
          sourceDest = entry.destination;
          break;
        }
      }
    }

    if (!sourceIdentity) {
      throw new Error('No source identity available — register a delivery identity first');
    }

    // sourceHash must be the sender's lxmf.delivery destination hash
    if (!message.sourceHash) {
      if (sourceDest) {
        message.sourceHash = sourceDest.hash;
      } else {
        // Caller provided a raw identity with no registered destination — build one
        const impliedDest = new Destination(
          sourceIdentity, DEST_IN, DEST_SINGLE, APP_NAME, 'delivery'
        );
        message.sourceHash = impliedDest.hash;
      }
    }

    // Pack the message (populates .packed and .hash)
    try {
      message.pack(sourceIdentity);
    } catch (err) {
      log(LOG_ERROR, TAG, `Failed to pack outbound message: ${err.message}`);
      message.state = FAILED;
      if (message.failedCallback) {
        try { message.failedCallback(message); } catch {}
      }
      throw err;
    }

    // Select delivery method
    const desired = message.desiredMethod;
    let method;
    if (desired === PROPAGATED) {
      if (!options.propagationNodeHash) {
        message.state = FAILED;
        if (message.failedCallback) { try { message.failedCallback(message); } catch {} }
        throw new Error('PROPAGATED method requires propagationNodeHash');
      }
      method = PROPAGATED;
    } else if (desired === DIRECT) {
      method = DIRECT;
    } else if (desired === OPPORTUNISTIC) {
      method = OPPORTUNISTIC;
    } else {
      // Auto: opportunistic for small, direct for large
      method = message.packed.length <= this.OPPORTUNISTIC_MAX_BYTES ? OPPORTUNISTIC : DIRECT;
    }

    message.method = method;
    message.state = OUTBOUND;

    const msgIdHex = toHex(message.hash);
    const destHex = toHex(message.destinationHash);

    // For propagated, targetHex is the propagation node; for the others it's the destination
    const targetHex = method === PROPAGATED
      ? toHex(options.propagationNodeHash)
      : destHex;

    const entry = {
      message,
      method,
      destHex,
      targetHex,
      targetHash: method === PROPAGATED ? options.propagationNodeHash : message.destinationHash,
      sourceIdentity,
      attempts: 0,
      nextAttempt: Date.now(),
      createdAt: Date.now() / 1000,
    };
    this.pendingOutbound.set(msgIdHex, entry);

    // Persist immediately so an rnsd crash before delivery preserves the
    // message. Best-effort — if storage isn't wired up we just stay in RAM.
    this._persistEntry(msgIdHex, entry).catch((err) => {
      log(LOG_WARNING, TAG, `Failed to persist outbound entry: ${err.message}`);
    });

    log(LOG_INFO, TAG, `Queued outbound ${msgIdHex.slice(0, 16)}.. ` +
      `(${method === OPPORTUNISTIC ? 'opportunistic' : method === DIRECT ? 'direct' : 'propagated'}, ` +
      `${message.packed.length}b) → ${destHex.slice(0, 16)}..`);

    // Kick off immediately
    this._dispatch(msgIdHex).catch((err) => {
      log(LOG_WARNING, TAG, `Dispatch error for ${msgIdHex.slice(0, 16)}..: ${err.message}`);
    });

    return message;
  }

  /**
   * Write an outbound entry to persistent storage. Best-effort no-op if
   * `this.storage` was not provided.
   * @param {string} msgIdHex
   * @param {object} entry
   */
  async _persistEntry(msgIdHex, entry) {
    if (!this.storage) return;
    await this.storage.saveOutboundEntry(msgIdHex, {
      packed: entry.message.packed,
      method: entry.method,
      desiredMethod: entry.message.desiredMethod,
      attempts: entry.attempts,
      nextAttempt: entry.nextAttempt,
      propagationNodeHash: entry.method === PROPAGATED ? entry.targetHash : null,
      sourceHash: entry.message.sourceHash,
      destinationHash: entry.message.destinationHash,
      sourceIdentityHash: entry.sourceIdentity ? entry.sourceIdentity.hash : null,
      createdAt: entry.createdAt,
    });
  }

  /**
   * Remove an outbound entry from persistent storage.
   * @param {string} msgIdHex
   */
  async _unpersistEntry(msgIdHex) {
    if (!this.storage) return;
    try {
      await this.storage.deleteOutboundEntry(msgIdHex);
    } catch (err) {
      log(LOG_DEBUG, TAG, `deleteOutboundEntry failed: ${err.message}`);
    }
  }

  /**
   * Restore previously-persisted outbound entries from disk and re-queue them.
   * Should be called after registerDeliveryIdentity() so that source identity
   * lookup can succeed. Returns the number of restored entries.
   *
   * @returns {Promise<number>}
   */
  async loadOutboundQueue() {
    if (!this.storage) return 0;
    const entries = await this.storage.loadOutboundEntries();
    let restored = 0;
    for (const [msgIdHex, persisted] of entries) {
      try {
        // Reconstruct the LXMessage from its packed bytes. We need an identity
        // lookup function so signature verification can run; the transport's
        // announce table is the right source.
        const identityLookup = (h) => this.transport.getIdentity(h);
        const message = LXMessage.unpackFromBytes(persisted.packed, identityLookup, persisted.method);
        message.method = persisted.method;
        message.desiredMethod = persisted.desiredMethod;
        message.state = OUTBOUND;
        message.deliveryAttempts = persisted.attempts;
        message.incoming = false; // outbound, not received

        // Find the matching local source identity by identity hash so the
        // dispatcher has a private key when needed (e.g. for re-pack on retry).
        let sourceIdentity = null;
        if (persisted.sourceIdentityHash) {
          for (const e of this.deliveryDestinations.values()) {
            if (e.identity && e.identity.hash &&
                toHex(e.identity.hash) === toHex(persisted.sourceIdentityHash)) {
              sourceIdentity = e.identity;
              break;
            }
          }
        }
        if (!sourceIdentity) {
          log(LOG_WARNING, TAG,
            `Skipping restored outbound ${msgIdHex.slice(0, 16)}.. — source identity not registered`);
          await this._unpersistEntry(msgIdHex);
          continue;
        }

        const destHex = toHex(message.destinationHash);
        const entry = {
          message,
          method: persisted.method,
          destHex,
          targetHex: persisted.propagationNodeHash
            ? toHex(persisted.propagationNodeHash) : destHex,
          targetHash: persisted.propagationNodeHash || message.destinationHash,
          sourceIdentity,
          attempts: persisted.attempts || 0,
          nextAttempt: Date.now(), // retry immediately on restart
          createdAt: persisted.createdAt,
        };
        this.pendingOutbound.set(msgIdHex, entry);
        restored++;
      } catch (err) {
        log(LOG_WARNING, TAG, `Failed to restore outbound entry ${msgIdHex}: ${err.message}`);
        await this._unpersistEntry(msgIdHex);
      }
    }
    if (restored > 0) {
      log(LOG_INFO, TAG, `Restored ${restored} pending outbound LXMF message(s) from disk`);
    }
    return restored;
  }

  /**
   * Periodic outbound processor — retries pending messages and expires failures.
   */
  _processOutbound() {
    const now = Date.now();
    for (const [msgIdHex, entry] of this.pendingOutbound) {
      if (entry.message.state === SENT || entry.message.state === DELIVERED) {
        this.pendingOutbound.delete(msgIdHex);
        this._unpersistEntry(msgIdHex).catch(() => {});
        continue;
      }
      if (entry.message.state === FAILED) {
        this.pendingOutbound.delete(msgIdHex);
        this._unpersistEntry(msgIdHex).catch(() => {});
        continue;
      }
      if (entry.message.state === SENDING) {
        // Already in flight (link opening, etc) — leave alone
        continue;
      }
      if (now < entry.nextAttempt) continue;
      if (entry.attempts >= this.MAX_DELIVERY_ATTEMPTS) {
        this._failMessage(msgIdHex, 'max delivery attempts exceeded');
        continue;
      }
      this._dispatch(msgIdHex).catch((err) => {
        log(LOG_WARNING, TAG, `Retry dispatch error: ${err.message}`);
      });
    }

    // Close idle outbound links
    for (const [destHex, entry] of this.outboundLinks) {
      if (entry.state === 'open' && entry.queue.length === 0 &&
          now - entry.lastActive > this.LINK_MAX_INACTIVITY) {
        try { entry.link.close(); } catch {}
        this.outboundLinks.delete(destHex);
      }
    }
  }

  /**
   * Dispatch a single pending message to the appropriate method handler.
   * @param {string} msgIdHex
   */
  async _dispatch(msgIdHex) {
    const entry = this.pendingOutbound.get(msgIdHex);
    if (!entry) return;
    entry.attempts += 1;
    entry.message.deliveryAttempts = entry.attempts;
    // Persist the bumped attempt count so a restart between retries doesn't
    // reset progress.
    this._persistEntry(msgIdHex, entry).catch(() => {});

    switch (entry.method) {
      case OPPORTUNISTIC: return this._sendOpportunistic(entry);
      case DIRECT:        return this._sendDirect(entry);
      case PROPAGATED:    return this._sendPropagated(entry);
      default:
        this._failMessage(msgIdHex, `unknown delivery method ${entry.method}`);
    }
  }

  /**
   * Opportunistic dispatcher — single-packet encrypted to the destination identity.
   * Matches Python LXMRouter.process_outbound deliver_opportunistic path.
   * @param {object} entry
   */
  async _sendOpportunistic(entry) {
    const { message, targetHash } = entry;
    const msgIdHex = toHex(message.hash);

    // Resolve destination identity
    const destIdentity = this.transport.getIdentity(targetHash);
    if (!destIdentity) {
      log(LOG_DEBUG, TAG, `No identity for ${entry.destHex.slice(0, 16)}.., requesting path`);
      try { this.transport.requestPath(targetHash); } catch {}
      entry.nextAttempt = Date.now() + this.DELIVERY_RETRY_WAIT;
      return;
    }

    if (!this.transport.pathTable.has(entry.destHex)) {
      log(LOG_DEBUG, TAG, `No path for ${entry.destHex.slice(0, 16)}.., requesting`);
      try { this.transport.requestPath(targetHash); } catch {}
      entry.nextAttempt = Date.now() + this.DELIVERY_RETRY_WAIT;
      return;
    }

    // Encrypt payload: everything after the destination hash.
    // message.packed = dest_hash(16) + src_hash(16) + sig(64) + msgpack_payload
    // The destination hash is implicit in the packet's destinationHash field.
    const plaintext = message.packed.slice(DESTINATION_LENGTH);
    let encrypted;
    try {
      encrypted = await destIdentity.encrypt(plaintext);
    } catch (err) {
      log(LOG_WARNING, TAG, `Opportunistic encrypt failed: ${err.message}`);
      entry.nextAttempt = Date.now() + this.DELIVERY_RETRY_WAIT;
      return;
    }

    // Wrap in a Packet destined for the remote lxmf.delivery destination
    const pkt = new Packet();
    pkt.headerType = HEADER_1;
    pkt.packetType = PACKET_DATA;
    pkt.destType = DEST_SINGLE;
    pkt.transportType = TRANSPORT_BROADCAST;
    pkt.destinationHash = message.destinationHash;
    pkt.context = CONTEXT_NONE;
    pkt.data = encrypted;

    this.transport.transmit(pkt);

    message.state = SENT;
    log(LOG_INFO, TAG, `Opportunistic sent ${msgIdHex.slice(0, 16)}.. → ${entry.destHex.slice(0, 16)}..`);

    if (message.deliveryCallback) {
      try { message.deliveryCallback(message); } catch (err) {
        log(LOG_WARNING, TAG, `deliveryCallback error: ${err.message}`);
      }
    }
    this.emit('outbound', message);
    this.pendingOutbound.delete(msgIdHex);
    this._unpersistEntry(msgIdHex).catch(() => {});
  }

  /**
   * Direct dispatcher — open a link to the destination and send with proof.
   * Matches Python LXMRouter.deliver_direct().
   * @param {object} entry
   */
  async _sendDirect(entry) {
    const { message, targetHash, destHex } = entry;
    const msgIdHex = toHex(message.hash);

    // Resolve destination identity
    const destIdentity = this.transport.getIdentity(targetHash);
    if (!destIdentity) {
      log(LOG_DEBUG, TAG, `No identity for direct send to ${destHex.slice(0, 16)}.., requesting path`);
      try { this.transport.requestPath(targetHash); } catch {}
      entry.nextAttempt = Date.now() + this.DELIVERY_RETRY_WAIT;
      return;
    }

    // Look up or open an outbound link
    let linkEntry = this.outboundLinks.get(destHex);
    if (!linkEntry) {
      const destination = new Destination(
        destIdentity, DEST_OUT, DEST_SINGLE, APP_NAME, 'delivery'
      );
      try {
        const link = Link.init(destination, this.transport);
        this.transport.registerPendingLink(link);
        linkEntry = {
          link,
          state: 'opening',
          queue: [msgIdHex],
          lastActive: Date.now(),
        };
        this.outboundLinks.set(destHex, linkEntry);

        link.on('established', () => {
          linkEntry.state = 'open';
          linkEntry.lastActive = Date.now();
          this._drainDirectQueue(destHex);
        });
        link.on('closed', () => {
          // Any queued messages fail so they can be retried
          for (const qId of linkEntry.queue) {
            const qEntry = this.pendingOutbound.get(qId);
            if (qEntry && qEntry.message.state === SENDING) {
              qEntry.message.state = OUTBOUND;
              qEntry.nextAttempt = Date.now() + this.DELIVERY_RETRY_WAIT;
            }
          }
          this.outboundLinks.delete(destHex);
        });
      } catch (err) {
        log(LOG_WARNING, TAG, `Failed to open direct link: ${err.message}`);
        entry.nextAttempt = Date.now() + this.DELIVERY_RETRY_WAIT;
        return;
      }
    } else if (linkEntry.state === 'opening') {
      // Link is still handshaking — queue and wait
      if (!linkEntry.queue.includes(msgIdHex)) linkEntry.queue.push(msgIdHex);
      return;
    } else if (linkEntry.state === 'open') {
      if (!linkEntry.queue.includes(msgIdHex)) linkEntry.queue.push(msgIdHex);
      return this._drainDirectQueue(destHex);
    }

    message.state = SENDING;
  }

  /**
   * Flush any pending DIRECT messages over an open link.
   * Uses sendWithProof for messages that fit in a single link packet, and
   * sendResource for larger ones (matching Python's PACKET vs RESOURCE
   * representation choice in LXMessage.pack).
   *
   * @param {string} destHex
   */
  async _drainDirectQueue(destHex) {
    const linkEntry = this.outboundLinks.get(destHex);
    if (!linkEntry || linkEntry.state !== 'open') return;

    while (linkEntry.queue.length > 0) {
      const msgIdHex = linkEntry.queue.shift();
      const entry = this.pendingOutbound.get(msgIdHex);
      if (!entry || entry.message.state === DELIVERED || entry.message.state === FAILED) continue;

      entry.message.state = SENDING;
      linkEntry.lastActive = Date.now();

      // LINK_PACKET_MAX_CONTENT in Python is link.MDU - LXMF_OVERHEAD ≈ 327
      // bytes. We compare against the *packed* LXMF size (which already
      // includes the LXMF header), so use link.MDU directly. Anything larger
      // goes over a Resource.
      const linkMdu = linkEntry.link.mtu ? linkEntry.link.mtu - 73 : 320;
      const useResource = entry.message.packed.length > linkMdu;

      try {
        if (useResource) {
          log(LOG_INFO, TAG,
            `Direct sending ${msgIdHex.slice(0, 16)}.. as Resource ` +
            `(${entry.message.packed.length}b > ${linkMdu})`);
          await linkEntry.link.sendResource(entry.message.packed, {
            onProgress: (p) => { entry.message.progress = p; },
          });
        } else {
          await linkEntry.link.sendWithProof(entry.message.packed);
        }
        entry.message.state = DELIVERED;
        log(LOG_INFO, TAG, `Direct delivered ${msgIdHex.slice(0, 16)}.. → ${destHex.slice(0, 16)}..`);
        if (entry.message.deliveryCallback) {
          try { entry.message.deliveryCallback(entry.message); } catch (err) {
            log(LOG_WARNING, TAG, `deliveryCallback error: ${err.message}`);
          }
        }
        this.emit('outbound', entry.message);
        this.pendingOutbound.delete(msgIdHex);
        this._unpersistEntry(msgIdHex).catch(() => {});
      } catch (err) {
        log(LOG_WARNING, TAG, `Direct send failed for ${msgIdHex.slice(0, 16)}..: ${err.message}`);
        entry.message.state = OUTBOUND;
        entry.nextAttempt = Date.now() + this.DELIVERY_RETRY_WAIT;
        this._persistEntry(msgIdHex, entry).catch(() => {});
      }
    }
  }

  /**
   * Propagated dispatcher — open a link to a propagation node and deliver the
   * encrypted envelope.
   *
   * Matches Python LXMRouter.propagation_transfer() / deliver_propagated.
   *
   * @param {object} entry
   */
  async _sendPropagated(entry) {
    const { message, targetHash, destHex } = entry;
    const msgIdHex = toHex(message.hash);

    // The recipient identity is needed for the end-to-end encryption envelope
    const recipientIdentity = this.transport.getIdentity(message.destinationHash);
    if (!recipientIdentity) {
      log(LOG_DEBUG, TAG, `No recipient identity for ${destHex.slice(0, 16)}.., requesting path`);
      try { this.transport.requestPath(message.destinationHash); } catch {}
      entry.nextAttempt = Date.now() + this.DELIVERY_RETRY_WAIT;
      return;
    }

    // Resolve propagation node identity
    const propIdentity = this.transport.getIdentity(targetHash);
    if (!propIdentity) {
      log(LOG_DEBUG, TAG, `No identity for propagation node ${entry.targetHex.slice(0, 16)}..`);
      try { this.transport.requestPath(targetHash); } catch {}
      entry.nextAttempt = Date.now() + this.DELIVERY_RETRY_WAIT;
      return;
    }

    // Build the propagation wrapper (msgpack([timestamp, [encrypted_lxmf_data]]))
    // Python LXMF propagation nodes require a proof-of-work stamp (default
    // cost 16, minimum 13). Default to 13 here so unstamped messages don't get
    // rejected; callers can override via entry.stampCost.
    let propagationData;
    try {
      const stampCost = entry.stampCost || 13;
      propagationData = await message.packForPropagation(recipientIdentity, { stampCost });
    } catch (err) {
      log(LOG_WARNING, TAG, `packForPropagation failed: ${err.message}`);
      entry.nextAttempt = Date.now() + this.DELIVERY_RETRY_WAIT;
      return;
    }

    const linkKey = 'prop:' + entry.targetHex;
    let linkEntry = this.outboundLinks.get(linkKey);
    if (!linkEntry) {
      const destination = new Destination(
        propIdentity, DEST_OUT, DEST_SINGLE, APP_NAME, 'propagation'
      );
      try {
        const link = Link.init(destination, this.transport);
        this.transport.registerPendingLink(link);
        linkEntry = {
          link,
          state: 'opening',
          queue: [msgIdHex],
          payloads: new Map([[msgIdHex, propagationData]]),
          lastActive: Date.now(),
        };
        this.outboundLinks.set(linkKey, linkEntry);

        link.on('established', () => {
          linkEntry.state = 'open';
          linkEntry.lastActive = Date.now();
          this._drainPropagationQueue(linkKey);
        });
        link.on('closed', () => {
          for (const qId of linkEntry.queue) {
            const qEntry = this.pendingOutbound.get(qId);
            if (qEntry && qEntry.message.state === SENDING) {
              qEntry.message.state = OUTBOUND;
              qEntry.nextAttempt = Date.now() + this.DELIVERY_RETRY_WAIT;
            }
          }
          this.outboundLinks.delete(linkKey);
        });
      } catch (err) {
        log(LOG_WARNING, TAG, `Failed to open propagation link: ${err.message}`);
        entry.nextAttempt = Date.now() + this.DELIVERY_RETRY_WAIT;
        return;
      }
    } else {
      if (!linkEntry.queue.includes(msgIdHex)) {
        linkEntry.queue.push(msgIdHex);
        linkEntry.payloads.set(msgIdHex, propagationData);
      }
      if (linkEntry.state === 'open') return this._drainPropagationQueue(linkKey);
    }

    message.state = SENDING;
  }

  /**
   * Flush any pending PROPAGATED messages over an open propagation link.
   * @param {string} linkKey
   */
  async _drainPropagationQueue(linkKey) {
    const linkEntry = this.outboundLinks.get(linkKey);
    if (!linkEntry || linkEntry.state !== 'open') return;

    while (linkEntry.queue.length > 0) {
      const msgIdHex = linkEntry.queue.shift();
      const entry = this.pendingOutbound.get(msgIdHex);
      const payload = linkEntry.payloads.get(msgIdHex);
      linkEntry.payloads.delete(msgIdHex);
      if (!entry || !payload) continue;
      if (entry.message.state === DELIVERED || entry.message.state === FAILED) continue;

      entry.message.state = SENDING;
      linkEntry.lastActive = Date.now();

      try {
        // Propagation nodes acknowledge with a packet proof for each received
        // envelope (Python's LXMRouter.propagation_transfer uses link.set_packet_callback
        // on the receiving side and calls prove_packet there). We therefore
        // send with proof just like DIRECT, but treat a proof timeout as SENT
        // rather than FAILED, since some servers do not prove every packet.
        // Use Resource for envelopes too large for a single link packet.
        const linkMdu = linkEntry.link.mtu ? linkEntry.link.mtu - 73 : 320;
        if (payload.length > linkMdu) {
          log(LOG_INFO, TAG,
            `Propagating ${msgIdHex.slice(0, 16)}.. as Resource ` +
            `(${payload.length}b > ${linkMdu})`);
          await linkEntry.link.sendResource(payload, {
            onProgress: (p) => { entry.message.progress = p; },
          });
        } else {
          await linkEntry.link.sendWithProof(payload, 10_000).catch((err) => {
            log(LOG_DEBUG, TAG, `Propagation proof wait: ${err.message} — marking SENT`);
          });
        }
        entry.message.state = DELIVERED;
        log(LOG_INFO, TAG, `Propagated ${msgIdHex.slice(0, 16)}.. via ${linkKey}`);
        if (entry.message.deliveryCallback) {
          try { entry.message.deliveryCallback(entry.message); } catch (err) {
            log(LOG_WARNING, TAG, `deliveryCallback error: ${err.message}`);
          }
        }
        this.emit('outbound', entry.message);
        this.pendingOutbound.delete(msgIdHex);
        this._unpersistEntry(msgIdHex).catch(() => {});
      } catch (err) {
        log(LOG_WARNING, TAG, `Propagated send failed for ${msgIdHex.slice(0, 16)}..: ${err.message}`);
        entry.message.state = OUTBOUND;
        entry.nextAttempt = Date.now() + this.DELIVERY_RETRY_WAIT;
        this._persistEntry(msgIdHex, entry).catch(() => {});
      }
    }
  }

  /**
   * Mark a pending message FAILED and fire its failed callback.
   * @param {string} msgIdHex
   * @param {string} reason
   */
  _failMessage(msgIdHex, reason) {
    const entry = this.pendingOutbound.get(msgIdHex);
    if (!entry) return;
    entry.message.state = FAILED;
    log(LOG_WARNING, TAG, `Outbound ${msgIdHex.slice(0, 16)}.. FAILED: ${reason}`);
    if (entry.message.failedCallback) {
      try { entry.message.failedCallback(entry.message); } catch (err) {
        log(LOG_WARNING, TAG, `failedCallback error: ${err.message}`);
      }
    }
    this.emit('outbound', entry.message);
    this.pendingOutbound.delete(msgIdHex);
    this._unpersistEntry(msgIdHex).catch(() => {});
  }

  /**
   * Get a snapshot of pending outbound messages (for HTTP API / debugging).
   */
  getPendingOutbound() {
    const out = [];
    for (const [id, entry] of this.pendingOutbound) {
      out.push({
        id,
        state: entry.message.state,
        method: entry.method,
        destinationHash: entry.destHex,
        attempts: entry.attempts,
        nextAttempt: entry.nextAttempt,
      });
    }
    return out;
  }

  /**
   * Handle an opportunistic (single-packet) delivery.
   * Matching Python LXMRouter.delivery_packet().
   *
   * Wire format from the sender:
   *   Packet.data = Identity.encrypt(source_hash + signature + msgpack_payload)
   *
   * The destination hash is implicit from the packet's destinationHash field
   * (it's also our local destination's hash), so we prepend it after decryption.
   *
   * @param {Uint8Array} data - Encrypted packet payload
   * @param {import('../Packet.js').Packet} packet
   * @param {Destination} destination - Our local lxmf.delivery destination
   */
  async _deliveryPacket(data, packet, destination) {
    try {
      const plaintext = await destination.identity.decrypt(data);
      if (!plaintext) {
        log(LOG_DEBUG, TAG, `Opportunistic packet decrypt returned null`);
        return;
      }
      const lxmfData = concat(destination.hash, plaintext);
      this._lxmfDelivery(lxmfData, OPPORTUNISTIC);
    } catch (err) {
      log(LOG_DEBUG, TAG, `Opportunistic packet decrypt failed: ${err.message}`);
    }
  }

  /**
   * Core message delivery handler.
   * Matching Python LXMRouter.lxmf_delivery().
   *
   * @param {Uint8Array} lxmfData - Raw LXMF message bytes
   * @param {number} method - Delivery method (DIRECT, OPPORTUNISTIC, PROPAGATED)
   */
  _lxmfDelivery(lxmfData, method) {
    if (lxmfData.length < LXMF_OVERHEAD) {
      log(LOG_WARNING, TAG, `LXMF data too short: ${lxmfData.length}`);
      return;
    }

    // Look up source identity for signature verification
    const identityLookup = (hash) => {
      return this.transport.getIdentity(hash);
    };

    const message = LXMessage.unpackFromBytes(lxmfData, identityLookup, method);
    message.method = method;

    // Set transport encryption info
    if (method === DIRECT) {
      message.transportEncrypted = true;
      message.transportEncryption = 'Curve25519';
    } else if (method === OPPORTUNISTIC) {
      message.transportEncrypted = true;
      message.transportEncryption = 'Curve25519';
    } else if (method === PROPAGATED) {
      message.transportEncrypted = true;
      message.transportEncryption = 'Curve25519';
    }

    // Dedup check
    const msgHex = toHex(message.hash);
    if (this.locallyDeliveredIds.has(msgHex)) {
      log(LOG_DEBUG, TAG, `Duplicate message ${msgHex}, dropping`);
      return;
    }
    this.locallyDeliveredIds.set(msgHex, Date.now() / 1000);

    log(LOG_INFO, TAG, `Received ${message.toString()} via ${['', 'opportunistic', 'direct', 'propagated'][method] || 'unknown'} ` +
      `from ${toHex(message.sourceHash).slice(0, 16)}.. "${message.title}"`);

    // Store for retrieval
    this.deliveredMessages.push({
      id: msgHex,
      message,
      timestamp: message.timestamp,
      received: Date.now() / 1000,
    });

    // Cap stored messages
    while (this.deliveredMessages.length > 10000) {
      this.deliveredMessages.shift();
    }

    // Fire callbacks
    const destHex = toHex(message.destinationHash);
    const destCallback = this._deliveryCallbacks.get(destHex);
    if (destCallback) destCallback(message);
    if (this._messageCallback) this._messageCallback(message);
    this.emit('message', message);
  }

  // --- Propagation Node ---

  /**
   * Enable propagation node mode.
   * Creates an lxmf.propagation destination and sets up /get request handler.
   *
   * @param {Identity} identity - Node identity
   * @param {object} [options]
   * @param {number} [options.storageLimit] - Max messages to store
   */
  enablePropagation(identity, options = {}) {
    this.propagationNode = true;
    this.propagationIdentity = identity;
    this.storageLimit = options.storageLimit || 50000;

    // Create propagation destination
    this.propagationDestination = new Destination(
      identity, DEST_IN, DEST_SINGLE, APP_NAME, 'propagation'
    );
    this.transport.registerDestination(this.propagationDestination);

    // Set up link callback for propagation connections
    this.propagationDestination.setLinkCallback((link) => {
      this._propagationLinkEstablished(link);
      return true;
    });

    log(LOG_INFO, TAG, `Propagation node enabled: ${toHex(this.propagationDestination.hash)}`);
  }

  /**
   * Handle a link to the propagation destination.
   * Sets up the /get request handler for client message download.
   * @param {import('../Link.js').Link} link
   */
  _propagationLinkEstablished(link) {
    log(LOG_INFO, TAG, `Propagation link established`);

    // Register /get request handler (matching Python message_get_request)
    link.onRequest(MESSAGE_GET_PATH, (data, requestId) => {
      return this._messageGetRequest(data, link);
    });

    // Accept resources (for incoming propagated messages)
    link.on('data', (plaintext) => {
      this._propagationReceiveData(plaintext);
    });
  }

  /**
   * Handle /get request from a client.
   * Matching Python LXMRouter.message_get_request().
   *
   * Protocol:
   *   Request [null, null] → returns list of transient_ids for this client
   *   Request [wanted_ids, have_ids, ?transfer_limit] → returns [lxmf_data, ...]
   *
   * @param {*} data - Decoded request data
   * @param {import('../Link.js').Link} link
   * @returns {*} Response data
   */
  _messageGetRequest(data, link) {
    // TODO: identify the remote client via link identification
    // For now, serve all messages (open access)
    // In production, this should check link.remoteIdentity

    try {
      if (data[0] === null && data[1] === null) {
        // List available messages
        const available = [];
        for (const [tid, entry] of this.propagationEntries) {
          available.push(new Uint8Array(Buffer.from(tid, 'hex')));
        }
        log(LOG_DEBUG, TAG, `Client requested message list: ${available.length} available`);
        return available;
      }

      // Process "have" messages (client already has these, can delete)
      if (data[1] && data[1].length > 0) {
        for (const tid of data[1]) {
          const tidHex = toHex(tid);
          if (this.propagationEntries.has(tidHex)) {
            this.propagationEntries.delete(tidHex);
            log(LOG_DEBUG, TAG, `Purged message ${tidHex.slice(0, 16)}..`);
          }
        }
      }

      // Process "want" messages
      const response = [];
      if (data[0] && data[0].length > 0) {
        let cumulativeSize = 24;
        const perMessageOverhead = 16;

        for (const tid of data[0]) {
          const tidHex = toHex(tid);
          const entry = this.propagationEntries.get(tidHex);
          if (entry) {
            const nextSize = cumulativeSize + entry.data.length + perMessageOverhead;
            if (nextSize > this.propagationLimit) break;

            // Strip propagation stamp (last STAMP_SIZE bytes) when serving to client
            const lxmfData = entry.data.length > STAMP_SIZE
              ? entry.data.slice(0, -STAMP_SIZE)
              : entry.data;
            response.push(lxmfData);
            cumulativeSize += lxmfData.length + perMessageOverhead;
          }
        }
      }

      log(LOG_DEBUG, TAG, `Serving ${response.length} messages to client`);
      return response;

    } catch (err) {
      log(LOG_ERROR, TAG, `Error handling /get request: ${err.message}`);
      return null;
    }
  }

  /**
   * Receive propagated message data (from a peer or client sending to the propagation node).
   * Matching Python LXMRouter.lxmf_propagation().
   *
   * @param {Uint8Array} data - Raw data (may be msgpack([timestamp, [lxmf_data, ...]]))
   */
  _propagationReceiveData(data) {
    try {
      const unpacked = msgpackDecode(data);
      if (!Array.isArray(unpacked) || unpacked.length < 2) return;

      const lxmDataList = unpacked[1];
      if (!Array.isArray(lxmDataList)) return;

      for (const lxmfData of lxmDataList) {
        this._lxmfPropagation(new Uint8Array(lxmfData));
      }
    } catch (err) {
      // May not be the propagation format — try as raw lxmf data
      this._lxmfPropagation(data);
    }
  }

  /**
   * Process a single propagated LXMF message.
   * Matching Python LXMRouter.lxmf_propagation().
   *
   * @param {Uint8Array} lxmfData - Raw LXMF data (dest_hash + encrypted_blob + ?propagation_stamp)
   * @returns {boolean}
   */
  _lxmfPropagation(lxmfData) {
    if (lxmfData.length < LXMF_OVERHEAD) return false;

    // Compute transient_id from the data WITHOUT the propagation stamp
    // The stamp is the last STAMP_SIZE bytes
    const dataWithoutStamp = lxmfData.length > STAMP_SIZE
      ? lxmfData.slice(0, -STAMP_SIZE)
      : lxmfData;
    const transientId = sha256Hash(dataWithoutStamp);
    const tidHex = toHex(transientId);

    // Dedup
    if (this.propagationEntries.has(tidHex) || this.locallyProcessedIds.has(tidHex)) {
      return false;
    }

    const received = Date.now() / 1000;
    const destinationHash = lxmfData.slice(0, DESTINATION_LENGTH);
    const destHex = toHex(destinationHash);

    this.locallyProcessedIds.set(tidHex, received);

    // Check if this is for a local delivery destination
    if (this.deliveryDestinations.has(destHex)) {
      const entry = this.deliveryDestinations.get(destHex);
      try {
        // Decrypt and deliver locally
        const encryptedData = dataWithoutStamp.slice(DESTINATION_LENGTH);
        const decrypted = entry.identity.decrypt(encryptedData);
        if (decrypted) {
          const deliveryData = concat(destinationHash, decrypted);
          this._lxmfDelivery(deliveryData, PROPAGATED);
          this.locallyDeliveredIds.set(tidHex, received);
          return true;
        }
      } catch (err) {
        log(LOG_WARNING, TAG, `Failed to decrypt propagated message for local delivery: ${err.message}`);
      }
    }

    // Store for propagation (if we're a propagation node)
    if (this.propagationNode) {
      this.propagationEntries.set(tidHex, {
        destinationHash,
        data: lxmfData,
        received,
        size: lxmfData.length,
        stampValue: 0,
        handledPeers: new Set(),
        unhandledPeers: new Set(),
      });

      // Enforce storage limit
      if (this.propagationEntries.size > this.storageLimit) {
        this._pruneOldestMessages();
      }

      log(LOG_INFO, TAG, `Stored propagated message ${tidHex.slice(0, 16)}.. for ${destHex.slice(0, 16)}..`);
      return true;
    }

    return false;
  }

  /**
   * Prune oldest messages when storage limit is exceeded.
   */
  _pruneOldestMessages() {
    const entries = [...this.propagationEntries.entries()]
      .sort((a, b) => a[1].received - b[1].received);

    const toRemove = entries.length - this.storageLimit;
    for (let i = 0; i < toRemove; i++) {
      this.propagationEntries.delete(entries[i][0]);
    }
    log(LOG_INFO, TAG, `Pruned ${toRemove} oldest propagation messages`);
  }

  /**
   * Expire old messages (called periodically).
   */
  expireMessages() {
    const now = Date.now() / 1000;
    const expiry = this.messageExpiry;

    for (const [tid, entry] of this.propagationEntries) {
      if (now - entry.received > expiry) {
        this.propagationEntries.delete(tid);
      }
    }

    // Also expire old dedup entries
    for (const [id, ts] of this.locallyDeliveredIds) {
      if (now - ts > expiry) this.locallyDeliveredIds.delete(id);
    }
    for (const [id, ts] of this.locallyProcessedIds) {
      if (now - ts > expiry) this.locallyProcessedIds.delete(id);
    }
  }

  /**
   * Get all delivered messages (for web interface).
   * @returns {Array<{id: string, message: LXMessage, timestamp: number, received: number}>}
   */
  getDeliveredMessages() {
    return this.deliveredMessages;
  }

  /**
   * Get propagation stats.
   */
  getStats() {
    return {
      deliveryDestinations: this.deliveryDestinations.size,
      propagationNode: this.propagationNode,
      propagationEntries: this.propagationEntries.size,
      deliveredMessages: this.deliveredMessages.length,
      locallyDeliveredIds: this.locallyDeliveredIds.size,
      locallyProcessedIds: this.locallyProcessedIds.size,
    };
  }
}
