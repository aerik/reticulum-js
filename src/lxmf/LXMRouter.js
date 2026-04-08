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
import { LXMessage, LXMF_OVERHEAD, DESTINATION_LENGTH, SIGNATURE_LENGTH,
         DIRECT, PROPAGATED, OPPORTUNISTIC } from './LXMessage.js';
import { APP_NAME, MESSAGE_GET_PATH, MESSAGE_EXPIRY,
         ERROR_NO_IDENTITY, ERROR_NO_ACCESS, PROPAGATION_LIMIT } from './constants.js';
import { sha256Hash, truncatedHash } from '../utils/crypto.js';
import { concat, toHex, equal, fromUtf8 } from '../utils/bytes.js';
import { log, LOG_DEBUG, LOG_INFO, LOG_WARNING, LOG_ERROR } from '../utils/log.js';
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import { createAnnounce } from '../Announce.js';
import {
  DEST_IN, DEST_OUT, DEST_SINGLE,
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
    this.messageExpiry = options.messageExpiry || MESSAGE_EXPIRY;
    this.propagationLimit = (options.propagationLimit || PROPAGATION_LIMIT) * 1000;

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

    // Active links for delivery
    this._deliveryLinks = new Map(); // destHashHex → link
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

    // Set up to receive messages as packets or resources on this link
    link.on('data', (plaintext, packet) => {
      // Send delivery proof (matching Python delivery_packet → packet.prove())
      if (packet) link.provePacket(packet);
      this._deliveryLinkData(plaintext, destHex, DIRECT);
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

  /**
   * Handle an opportunistic (single-packet) delivery.
   * Matching Python LXMRouter.delivery_packet().
   * @param {Uint8Array} data
   * @param {import('../Packet.js').Packet} packet
   * @param {Destination} destination
   */
  _deliveryPacket(data, packet, destination) {
    // Opportunistic: destination hash is implicit from the packet destination
    // Prepend it to get full LXMF data
    const lxmfData = concat(destination.hash, data);
    this._lxmfDelivery(lxmfData, OPPORTUNISTIC);
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
