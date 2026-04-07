/**
 * Transport — the routing and forwarding layer.
 *
 * Matches the Python reference implementation (RNS/Transport.py) in structure,
 * simplified for initial implementation.
 *
 * Responsibilities:
 * - Receive packets from interfaces and dispatch by type
 * - Validate and process announces (cache identity → public key mappings)
 * - Maintain path table (destination → next hop)
 * - Duplicate packet detection via hash list
 * - Forward packets toward their destination (when transport is enabled)
 * - Transmit outgoing packets through appropriate interfaces
 */

import { EventEmitter } from './utils/events.js';
import { Packet } from './Packet.js';
import { validateAnnounce } from './Announce.js';
import { Identity } from './Identity.js';
import { Destination } from './Destination.js';
import { log, LOG_DEBUG, LOG_INFO, LOG_WARNING, LOG_ERROR, LOG_VERBOSE, LOG_EXTREME } from './utils/log.js';
import { toHex, equal, concat, randomBytes, fromUtf8 } from './utils/bytes.js';
import { sha256Hash, truncatedHash } from './utils/crypto.js';
import { hdlcEncode } from './utils/hdlc.js';
import { ifacMask, ifacUnmask } from './utils/ifac.js';
import {
  PACKET_DATA, PACKET_ANNOUNCE, PACKET_LINK_REQUEST, PACKET_PROOF,
  TRANSPORT_BROADCAST, TRANSPORT_TRANSPORT,
  HEADER_1, HEADER_2,
  DEST_SINGLE, DEST_PLAIN, DEST_GROUP, DEST_LINK,
  ADDR_SIZE, MAX_HOPS,
  CONTEXT_NONE,
  CONTEXT_KEEPALIVE, CONTEXT_LRPROOF, CONTEXT_LRRTT, CONTEXT_LINKCLOSE,
  CONTEXT_REQUEST, CONTEXT_RESPONSE, CONTEXT_CHANNEL,
  CONTEXT_RESOURCE, CONTEXT_RESOURCE_ADV, CONTEXT_RESOURCE_REQ, CONTEXT_RESOURCE_HMU, CONTEXT_RESOURCE_PRF,
  PATHFINDER_E, PATHFINDER_RW, PATHFINDER_R, PATHFINDER_G,
} from './constants.js';
import { Link } from './Link.js';

const TAG = 'Transport';

// Maximum entries in the packet hash list (for dedup)
const HASHLIST_MAXSIZE = 1000000;

// Table maintenance intervals (matching Python Transport.py)
const TABLES_CULL_INTERVAL = 5;      // seconds — cull stale entries every 5s
const ANNOUNCES_CHECK_INTERVAL = 1;  // seconds — process rebroadcast queue every 1s
const REVERSE_TIMEOUT = 8 * 60;      // seconds — reverse table entry lifetime (8 min)
const DESTINATION_TIMEOUT = 7 * 24 * 60 * 60; // seconds — announce table lifetime (7 days)

// Table size caps (prevent unbounded growth on long-running nodes)
const MAX_PATH_TABLE_SIZE = 50000;
const MAX_ANNOUNCE_TABLE_SIZE = 50000;
const MAX_REVERSE_TABLE_SIZE = 10000;
const MAX_ANNOUNCE_CACHE_SIZE = 20000;

export class Transport extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {boolean} [options.enableTransport=false] - Enable packet forwarding
   */
  constructor(options = {}) {
    super();
    this.enableTransport = options.enableTransport || false;

    /** @type {import('./interfaces/Interface.js').Interface[]} */
    this.interfaces = [];

    /** @type {Map<string, Destination>} destination hexhash → registered local destination */
    this.destinations = new Map();

    /**
     * Path table: destination hexhash → path info
     * @type {Map<string, { timestamp: number, nextHop: Uint8Array, hops: number,
     *   expires: number, interface: import('./interfaces/Interface.js').Interface,
     *   announcePacketHash: Uint8Array }>}
     */
    this.pathTable = new Map();

    /**
     * Identity/announce cache: destination hexhash → { identity, appData, hops, timestamp }
     * @type {Map<string, { identity: Identity, appData: Uint8Array|null, hops: number, timestamp: number }>}
     */
    this.announceTable = new Map();

    /**
     * Active links: link_id hexhash → Link
     * @type {Map<string, import('./Link.js').Link>}
     */
    this.linkTable = new Map();

    /**
     * Pending links (initiator side, waiting for proof): link_id hexhash → Link
     * @type {Map<string, import('./Link.js').Link>}
     */
    this.pendingLinks = new Map();

    /**
     * Reverse table: truncated packet hash hex → { receivedOn, forwardedOn, timestamp }
     * Used to route proofs back to the originating interface.
     * @type {Map<string, { receivedOn: import('./interfaces/Interface.js').Interface,
     *   forwardedOn: import('./interfaces/Interface.js').Interface, timestamp: number }>}
     */
    this.reverseTable = new Map();

    /** Our identity hash — set when transport is enabled */
    this.identityHash = null;

    /** Packet hash dedup set */
    this.packetHashlist = new Set();
    this.packetHashlistPrev = new Set();

    /**
     * Pending path requests: dest hex → { timestamp, tag, callback }
     * @type {Map<string, { timestamp: number, tag: Uint8Array, callback: Function|null }>}
     */
    this.pendingPathRequests = new Map();

    /**
     * Pending announce rebroadcasts: destHex → { retransmitAt, retries, packet, receivedOn }
     * Matches Python Transport.announce_table rebroadcast scheduling.
     * @type {Map<string, { retransmitAt: number, retries: number, packet: Packet,
     *   receivedOn: import('./interfaces/Interface.js').Interface }>}
     */
    this.pendingAnnounces = new Map();

    /** Path request destination (well-known PLAIN) */
    this._pathRequestDest = null;

    /** Storage reference (set by Reticulum) */
    this.storage = null;

    /** Table cleanup and announce rebroadcast timers */
    this._announceCheckTimer = null;
    this._tableCleanupTimer = null;

    /** Statistics */
    this.stats = {
      packetsReceived: 0,
      packetsSent: 0,
      announcesReceived: 0,
      announcesValidated: 0,
      duplicatesDropped: 0,
      packetsForwarded: 0,
    };
  }

  /**
   * Register an interface with the transport layer.
   * @param {import('./interfaces/Interface.js').Interface} iface
   */
  registerInterface(iface) {
    this.interfaces.push(iface);
    iface.on('packet', (raw) => this.inbound(raw, iface));
    log(LOG_INFO, TAG, `Registered interface: ${iface.name}`);
  }

  /**
   * Register a local destination for packet delivery.
   * @param {Destination} destination
   */
  registerDestination(destination) {
    if (destination.hash) {
      const key = toHex(destination.hash);
      this.destinations.set(key, destination);
      log(LOG_DEBUG, TAG, `Registered destination: ${key}`);
    }
  }

  /**
   * Look up a cached identity by destination hash.
   * @param {Uint8Array} destHash - 16-byte destination hash
   * @returns {Identity|null}
   */
  getIdentity(destHash) {
    const entry = this.announceTable.get(toHex(destHash));
    return entry ? entry.identity : null;
  }

  /**
   * Register a link (both pending and active).
   * @param {import('./Link.js').Link} link
   */
  registerLink(link) {
    const key = toHex(link.linkId);
    this.linkTable.set(key, link);
    link.on('closed', () => {
      this.linkTable.delete(key);
      this.pendingLinks.delete(key);
    });
  }

  /**
   * Register a pending link (initiator waiting for proof).
   * @param {import('./Link.js').Link} link
   */
  registerPendingLink(link) {
    const key = toHex(link.linkId);
    this.pendingLinks.set(key, link);
    this.registerLink(link);
  }

  /**
   * Transmit a packet on the appropriate interface(s).
   * @param {Packet} packet
   * @param {import('./interfaces/Interface.js').Interface} [excludeInterface] - Don't send back on this interface
   */
  transmit(packet, excludeInterface = null) {
    const raw = packet.pack();

    for (const iface of this.interfaces) {
      if (iface === excludeInterface) continue;
      if (!iface.online) continue;

      // Apply IFAC masking if the interface has it configured
      const toSend = iface.ifacConfig ? ifacMask(raw, iface.ifacConfig) : raw;

      iface.send(toSend);
      this.stats.packetsSent++;
      log(LOG_DEBUG, TAG, `Transmitted ${packet.toString()} via ${iface.name}`);
    }
  }

  /**
   * Process an incoming raw packet from an interface.
   * This is the main packet processing pipeline matching Python Transport.inbound().
   *
   * @param {Uint8Array} raw - Raw packet bytes (after HDLC deframing)
   * @param {import('./interfaces/Interface.js').Interface} fromInterface
   */
  inbound(raw, fromInterface) {
    this.stats.packetsReceived++;

    // --- IFAC handling ---
    const hasIfacFlag = (raw[0] & 0x80) !== 0;

    if (fromInterface.ifacConfig) {
      // Interface has IFAC enabled
      if (!hasIfacFlag) {
        // Packet doesn't have IFAC but interface requires it — drop
        log(LOG_DEBUG, TAG, 'Dropped packet without IFAC on IFAC-enabled interface');
        return;
      }
      // Unmask and verify
      const unmasked = ifacUnmask(raw, fromInterface.ifacConfig);
      if (!unmasked) {
        log(LOG_DEBUG, TAG, 'Dropped packet with invalid IFAC');
        return;
      }
      raw = unmasked;
    } else {
      // Interface does NOT have IFAC
      if (hasIfacFlag) {
        // Packet has IFAC but interface doesn't expect it — drop
        log(LOG_DEBUG, TAG, 'Dropped IFAC packet on non-IFAC interface');
        return;
      }
    }

    // Parse the packet
    let packet;
    try {
      packet = Packet.parse(raw);
    } catch (err) {
      log(LOG_WARNING, TAG, `Failed to parse packet: ${err.message}`);
      return;
    }

    packet.receivingInterface = fromInterface;
    packet.hops++;

    log(LOG_EXTREME, TAG, `Received ${packet.toString()} from ${fromInterface.name}`);

    // --- Packet filter ---

    // PLAIN destination with hops > 1: drop (PLAIN is local-only)
    if (packet.destType === DEST_PLAIN && packet.hops > 1) {
      log(LOG_DEBUG, TAG, 'Dropped PLAIN packet with hops > 1');
      return;
    }

    // GROUP destination with hops > 1: drop
    if (packet.destType === DEST_GROUP && packet.hops > 1) {
      log(LOG_DEBUG, TAG, 'Dropped GROUP packet with hops > 1');
      return;
    }

    // Duplicate check (skip for ANNOUNCE — they have their own dedup via random_blobs)
    if (packet.packetType !== PACKET_ANNOUNCE) {
      if (this._isDuplicate(packet.packetHash)) {
        this.stats.duplicatesDropped++;
        log(LOG_EXTREME, TAG, 'Dropped duplicate packet');
        return;
      }
      this._addToHashlist(packet.packetHash);
    }

    // --- Dispatch by packet type ---
    switch (packet.packetType) {
      case PACKET_ANNOUNCE:
        this._handleAnnounce(packet);
        break;
      case PACKET_DATA:
        this._handleData(packet);
        break;
      case PACKET_LINK_REQUEST:
        this._handleLinkRequest(packet);
        break;
      case PACKET_PROOF:
        this._handleProof(packet);
        break;
      default:
        log(LOG_WARNING, TAG, `Unknown packet type: ${packet.packetType}`);
    }
  }

  /**
   * Handle an incoming announce packet.
   * @param {Packet} packet
   */
  _handleAnnounce(packet) {
    this.stats.announcesReceived++;

    const destHex = toHex(packet.destinationHash);
    log(LOG_VERBOSE, TAG, `Announce for ${destHex} (hops: ${packet.hops})`);

    // Validate the announce
    const result = validateAnnounce(packet);
    if (!result) {
      log(LOG_DEBUG, TAG, `Invalid announce for ${destHex}`);
      return;
    }

    this.stats.announcesValidated++;

    const { identity, nameHash, randomBlob, appData, timestamp, destinationHash } = result;

    // Check if we should accept this announce (compare with existing path)
    const existing = this.pathTable.get(destHex);
    if (existing) {
      // Accept if fewer hops or if existing path has expired
      const now = Date.now() / 1000;
      if (packet.hops >= existing.hops && now < existing.expires) {
        log(LOG_DEBUG, TAG, `Announce for ${destHex} not better than existing path (${packet.hops} >= ${existing.hops})`);
        return;
      }
    }

    // Cache the identity
    this.announceTable.set(destHex, {
      identity,
      appData,
      hops: packet.hops,
      timestamp,
    });

    // Update path table
    const now = Date.now() / 1000;
    this.pathTable.set(destHex, {
      timestamp: now,
      nextHop: packet.destinationHash,
      hops: packet.hops,
      expires: now + PATHFINDER_E,
      interface: packet.receivingInterface,
      announcePacketHash: packet.packetHash,
    });

    log(LOG_INFO, TAG, `Validated announce for ${destHex} from ${identity.hexHash} (hops: ${packet.hops}${appData ? ', app_data: ' + appData.length + 'b' : ''})`);

    // Emit event for application-level handlers
    this.emit('announce', {
      destinationHash,
      identity,
      nameHash,
      appData,
      hops: packet.hops,
      timestamp,
      interface: packet.receivingInterface,
    });

    // If transport is enabled, schedule rebroadcast with random delay
    // (matching Python Transport.py PATHFINDER_RW logic)
    if (this.enableTransport && packet.hops < MAX_HOPS) {
      this._scheduleAnnounceRebroadcast(packet);
    }
  }

  /**
   * Schedule an announce for delayed rebroadcast.
   * Matches Python: initial delay = rand() * PATHFINDER_RW (0-0.5s),
   * retry after PATHFINDER_G + PATHFINDER_RW (5.5s), max PATHFINDER_R retries.
   * @param {Packet} packet
   */
  _scheduleAnnounceRebroadcast(packet) {
    const destHex = toHex(packet.destinationHash);
    const now = Date.now() / 1000;
    const retransmitAt = now + (Math.random() * PATHFINDER_RW);

    this.pendingAnnounces.set(destHex, {
      retransmitAt,
      retries: 0,
      packet,
      receivedOn: packet.receivingInterface,
    });
  }

  /**
   * Process pending announce rebroadcasts (called on interval).
   * Matches Python Transport.py lines 518-577.
   */
  _processAnnounceRebroadcasts() {
    const now = Date.now() / 1000;

    for (const [destHex, entry] of this.pendingAnnounces) {
      if (now >= entry.retransmitAt) {
        if (entry.retries <= PATHFINDER_R) {
          // Rebroadcast on all interfaces except the one it came from
          const raw = entry.packet.raw;
          for (const iface of this.interfaces) {
            if (iface === entry.receivedOn) continue;
            if (!iface.online) continue;
            const toSend = iface.ifacConfig ? ifacMask(raw, iface.ifacConfig) : raw;
            iface.send(toSend);
          }

          log(LOG_DEBUG, TAG, `Rebroadcast announce for ${destHex} (retry ${entry.retries})`);

          // Schedule retry
          entry.retries++;
          entry.retransmitAt = now + PATHFINDER_G + PATHFINDER_RW;
        } else {
          // Max retries reached, remove from queue
          this.pendingAnnounces.delete(destHex);
        }
      }
    }
  }

  /**
   * Handle an incoming data packet.
   * @param {Packet} packet
   */
  _handleData(packet) {
    const destHex = toHex(packet.destinationHash);

    // Check if this is for an active link
    if (packet.destType === DEST_LINK) {
      const link = this.linkTable.get(destHex);
      if (link) {
        this._handleLinkData(link, packet);
        return;
      }
    }

    // Check if this is a path request (PLAIN destination for rnstransport.path.request)
    if (packet.destType === DEST_PLAIN && this.enableTransport) {
      const pathReqHash = truncatedHash(
        truncatedHash(fromUtf8('rnstransport.path.request'), 10),
        16
      );
      if (equal(packet.destinationHash, pathReqHash)) {
        this._handlePathRequest(packet);
        // Don't return — still deliver to local destinations if registered
      }
    }

    // Check if we have a local destination registered
    const dest = this.destinations.get(destHex);
    if (dest && dest._callbacks.packet) {
      log(LOG_DEBUG, TAG, `Delivering data packet to local destination ${destHex}`);
      dest._callbacks.packet(packet.data, packet);
      return;
    }

    // If transport enabled, try to forward
    if (this.enableTransport && packet.transportType === TRANSPORT_TRANSPORT) {
      this._forwardPacket(packet);
      return;
    }

    log(LOG_DEBUG, TAG, `No destination for data packet ${destHex}`);
  }

  /**
   * Handle data on an established link.
   * @param {import('./Link.js').Link} link
   * @param {Packet} packet
   */
  async _handleLinkData(link, packet) {
    link.lastInbound = Date.now();

    switch (packet.context) {
      case CONTEXT_LRRTT:
        link.handleRtt(packet.data);
        break;
      case CONTEXT_KEEPALIVE:
        link.handleKeepalive(packet.data);
        break;
      case CONTEXT_LINKCLOSE:
        link.handleClose(packet.data);
        break;
      case CONTEXT_REQUEST:
      case CONTEXT_RESPONSE: {
        try {
          const plaintext = await link.decrypt(packet.data);
          if (packet.context === CONTEXT_REQUEST) {
            link._handleRequest(plaintext, packet);
          } else {
            link._handleResponse(plaintext);
          }
        } catch (err) {
          log(LOG_WARNING, TAG, `Link decrypt failed: ${err.message}`);
        }
        break;
      }
      case CONTEXT_CHANNEL: {
        try {
          const plaintext = await link.decrypt(packet.data);
          link.emit('channel', plaintext, packet);
        } catch (err) {
          log(LOG_WARNING, TAG, `Channel decrypt failed: ${err.message}`);
        }
        break;
      }
      case CONTEXT_RESOURCE_ADV:
      case CONTEXT_RESOURCE_REQ:
      case CONTEXT_RESOURCE_HMU: {
        // RESOURCE_ADV, RESOURCE_REQ, and RESOURCE_HMU are encrypted per-packet
        try {
          const plaintext = await link.decrypt(packet.data);
          if (packet.context === CONTEXT_RESOURCE_ADV) {
            link._handleResourceAdv(plaintext);
          } else if (packet.context === CONTEXT_RESOURCE_HMU) {
            link._handleResourceHmu(plaintext);
          } else {
            link.emit('resource_req', plaintext, packet);
          }
        } catch (err) {
          log(LOG_WARNING, TAG, `Resource control decrypt failed: ${err.message}`);
        }
        break;
      }
      case CONTEXT_RESOURCE: {
        // RESOURCE data parts are NOT encrypted per-packet —
        // the Resource encrypts the entire stream itself.
        link._handleResourcePart(packet.data);
        break;
      }
      case CONTEXT_RESOURCE_PRF: {
        // Resource proofs are NOT encrypted
        link.emit('resource_proof', packet.data, packet);
        break;
      }
      default: {
        try {
          const plaintext = await link.decrypt(packet.data);
          link.emit('data', plaintext, packet);
        } catch (err) {
          log(LOG_WARNING, TAG, `Link data decrypt failed: ${err.message}`);
        }
        break;
      }
    }
  }

  /**
   * Handle an incoming link request.
   * @param {Packet} packet
   */
  _handleLinkRequest(packet) {
    const destHex = toHex(packet.destinationHash);
    const dest = this.destinations.get(destHex);

    if (dest) {
      log(LOG_DEBUG, TAG, `Link request for local destination ${destHex}`);

      // Create responder-side Link
      const link = Link.validateRequest(packet, dest, this);
      if (link) {
        this.registerLink(link);

        // Notify destination callback
        if (dest._callbacks.link) {
          const accepted = dest._callbacks.link(link);
          if (!accepted) {
            link.close();
            return;
          }
        }

        this.emit('linkEstablished', link);
      }
    } else if (this.enableTransport) {
      this._forwardPacket(packet);
    }
  }

  /**
   * Handle an incoming proof packet.
   * Matches Python Transport.py proof handling:
   * - LRPROOF: check pendingLinks (initiator side)
   * - Other proofs: route via reverse table when transport enabled
   * @param {Packet} packet
   */
  _handleProof(packet) {
    const destHex = toHex(packet.destinationHash);

    // Check if this is a link request proof (LRPROOF)
    if (packet.context === CONTEXT_LRPROOF) {
      const pendingLink = this.pendingLinks.get(destHex);
      if (pendingLink) {
        // Find the destination identity to verify the proof
        const destIdentity = this.getIdentity(pendingLink.destination.hash);
        if (destIdentity) {
          // handleProof is async (encryption for RTT packet)
          pendingLink.handleProof(packet, destIdentity).then((ok) => {
            if (ok) {
              this.pendingLinks.delete(destHex);
              log(LOG_INFO, TAG, `Link proof accepted for ${destHex}`);
              this.emit('linkEstablished', pendingLink);
            } else {
              log(LOG_WARNING, TAG, `Link proof verification failed for ${destHex}`);
            }
          });
        } else {
          log(LOG_WARNING, TAG, `No identity for link proof destination ${destHex}`);
        }
        return;
      }
    }

    // Route proof via reverse table (matching Python Transport.py lines 2085-2100)
    if (this.enableTransport && this.reverseTable.has(destHex)) {
      const reverseEntry = this.reverseTable.get(destHex);
      this.reverseTable.delete(destHex); // one-shot, pop entry

      // Verify proof arrived on the interface we forwarded the original packet to
      if (packet.receivingInterface === reverseEntry.forwardedOn) {
        // Route proof back on the interface we received the original packet from
        const raw = packet.raw;
        const backIface = reverseEntry.receivedOn;
        if (backIface && backIface.online) {
          const toSend = backIface.ifacConfig ? ifacMask(raw, backIface.ifacConfig) : raw;
          backIface.send(toSend);
          log(LOG_DEBUG, TAG, `Routed proof for ${destHex} back via ${backIface.name}`);
        }
      } else {
        log(LOG_DEBUG, TAG, `Proof for ${destHex} arrived on wrong interface, not routing`);
      }
      return;
    }

    log(LOG_DEBUG, TAG, `Received proof for ${destHex}`);
    this.emit('proof', { destinationHash: packet.destinationHash, packet });
  }

  /**
   * Forward a packet toward its destination using the path table.
   *
   * Matches Python Transport routing:
   * - Look up destination in path table
   * - If remaining_hops > 1: wrap in HEADER_2, set transport ID to next hop
   * - If remaining_hops == 1: convert to HEADER_1 BROADCAST (final hop)
   * - Save reverse table entry for proof routing
   *
   * @param {Packet} packet
   */
  _forwardPacket(packet) {
    const destHex = toHex(packet.destinationHash);
    const path = this.pathTable.get(destHex);

    if (!path) {
      log(LOG_DEBUG, TAG, `No path for ${destHex}, cannot forward`);
      return;
    }

    // Check if path has expired
    const now = Date.now() / 1000;
    if (now > path.expires) {
      log(LOG_DEBUG, TAG, `Path expired for ${destHex}`);
      this.pathTable.delete(destHex);
      return;
    }

    const remainingHops = MAX_HOPS - packet.hops;
    if (remainingHops <= 0) {
      log(LOG_DEBUG, TAG, `Max hops exceeded for ${destHex}`);
      return;
    }

    // Save reverse table entry for proof routing
    if (packet.packetHash) {
      const reverseKey = toHex(packet.packetHash).slice(0, 32); // truncated
      this.reverseTable.set(reverseKey, {
        receivedOn: packet.receivingInterface,
        forwardedOn: path.interface,
        timestamp: now,
      });
    }

    // Build forwarded packet
    const fwd = new Packet();
    fwd.packetType = packet.packetType;
    fwd.destType = packet.destType;
    fwd.contextFlag = packet.contextFlag;
    fwd.hops = packet.hops;
    fwd.destinationHash = packet.destinationHash;
    fwd.context = packet.context;
    fwd.data = packet.data;

    if (remainingHops === 1 || path.hops <= 1) {
      // Final hop: convert to HEADER_1 BROADCAST
      fwd.headerType = HEADER_1;
      fwd.transportType = TRANSPORT_BROADCAST;
      fwd.transportId = null;
    } else {
      // Multi-hop: wrap in HEADER_2 with next hop transport ID
      fwd.headerType = HEADER_2;
      fwd.transportType = TRANSPORT_TRANSPORT;
      fwd.transportId = path.nextHop;
    }

    const raw = fwd.pack();

    // Send on the path's interface (or if IFAC, apply masking)
    const iface = path.interface;
    if (iface && iface.online) {
      const toSend = iface.ifacConfig ? ifacMask(raw, iface.ifacConfig) : raw;
      iface.send(toSend);
      this.stats.packetsForwarded++;
      log(LOG_DEBUG, TAG, `Forwarded packet for ${destHex} via ${iface.name} (${remainingHops} hops remaining)`);
    }
  }

  // --- Path Requests ---

  /**
   * Request a path to a destination. Sends a PATH_REQUEST packet
   * on all interfaces. The response comes as a normal announce.
   *
   * @param {Uint8Array} destinationHash - 16-byte destination hash
   * @param {Function} [callback] - Called when path is found (via announce)
   * @param {number} [timeout=15000] - Timeout in ms
   * @returns {Promise<boolean>} true if path was found within timeout
   */
  requestPath(destinationHash, callback, timeout = 15000) {
    const destHex = toHex(destinationHash);

    // Check if we already have a path
    if (this.pathTable.has(destHex)) {
      if (callback) callback(this.pathTable.get(destHex));
      return Promise.resolve(true);
    }

    // Build path request data: destination_hash(16) + request_tag(16)
    const tag = randomBytes(16);
    const requestData = concat(destinationHash, tag);

    // Build the path request packet
    // Destination: well-known PLAIN "rnstransport.path.request"
    const pathRequestHash = truncatedHash(
      concat(
        truncatedHash(fromUtf8('rnstransport.path.request'), 10)
      ),
      16
    );

    const pkt = new Packet();
    pkt.headerType = HEADER_1;
    pkt.packetType = PACKET_DATA;
    pkt.destType = DEST_PLAIN;
    pkt.transportType = TRANSPORT_BROADCAST;
    pkt.destinationHash = pathRequestHash;
    pkt.context = CONTEXT_NONE;
    pkt.data = requestData;

    // Register pending request
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPathRequests.delete(destHex);
        resolve(false);
      }, timeout);

      this.pendingPathRequests.set(destHex, {
        timestamp: Date.now() / 1000,
        tag,
        callback: (pathInfo) => {
          clearTimeout(timer);
          this.pendingPathRequests.delete(destHex);
          if (callback) callback(pathInfo);
          resolve(true);
        },
      });

      // Listen for announces for this destination
      const announceHandler = (info) => {
        if (toHex(info.destinationHash) === destHex) {
          const pending = this.pendingPathRequests.get(destHex);
          if (pending && pending.callback) {
            this.off('announce', announceHandler);
            pending.callback(this.pathTable.get(destHex));
          }
        }
      };
      this.on('announce', announceHandler);

      // Transmit the path request
      this.transmit(pkt);

      log(LOG_INFO, TAG, `Sent path request for ${destHex}`);
    });
  }

  /**
   * Handle an incoming path request (if we're a transport node with the cached announce).
   * @param {Packet} packet - PATH_REQUEST data packet to the well-known destination
   */
  _handlePathRequest(packet) {
    if (packet.data.length < 32) return; // need at least dest_hash(16) + tag(16)

    const requestedDest = packet.data.slice(0, 16);
    const destHex = toHex(requestedDest);

    // Do we have a cached announce for this destination?
    const path = this.pathTable.get(destHex);
    const cachedIdentity = this.announceTable.get(destHex);

    if (path && cachedIdentity && this.storage) {
      log(LOG_DEBUG, TAG, `Responding to path request for ${destHex}`);

      // Load the cached announce packet and re-transmit it
      this.storage.loadCachedAnnounce(path.announcePacketHash).then((cached) => {
        if (cached) {
          // Re-transmit the cached announce on the requesting interface
          const iface = packet.receivingInterface;
          if (iface && iface.online) {
            const toSend = iface.ifacConfig
              ? ifacMask(cached.raw, iface.ifacConfig)
              : cached.raw;
            iface.send(toSend);
            log(LOG_DEBUG, TAG, `Sent cached announce for ${destHex} as path response`);
          }
        }
      }).catch(() => {});
    }
  }

  // --- Table maintenance (matching Python Transport.py cull_tables) ---

  /**
   * Start table maintenance timers. Called by Reticulum on startup.
   */
  startMaintenance() {
    this.stopMaintenance();

    // Announce rebroadcast check every 1s (matching Python announces_check_interval)
    this._announceCheckTimer = setInterval(
      () => this._processAnnounceRebroadcasts(),
      ANNOUNCES_CHECK_INTERVAL * 1000
    );

    // Table cull every 5s (matching Python tables_cull_interval)
    this._tableCleanupTimer = setInterval(
      () => this._cullTables(),
      TABLES_CULL_INTERVAL * 1000
    );
  }

  /**
   * Stop table maintenance timers.
   */
  stopMaintenance() {
    if (this._announceCheckTimer) {
      clearInterval(this._announceCheckTimer);
      this._announceCheckTimer = null;
    }
    if (this._tableCleanupTimer) {
      clearInterval(this._tableCleanupTimer);
      this._tableCleanupTimer = null;
    }
  }

  /**
   * Cull stale entries from all routing tables, and enforce size caps.
   * Matches Python Transport.py lines 599-821, with added size limits.
   */
  _cullTables() {
    const now = Date.now() / 1000;

    // Cull reverse table (REVERSE_TIMEOUT = 8 min)
    for (const [key, entry] of this.reverseTable) {
      if (now > entry.timestamp + REVERSE_TIMEOUT) {
        this.reverseTable.delete(key);
      } else if (!this.interfaces.includes(entry.forwardedOn)) {
        this.reverseTable.delete(key);
      } else if (!this.interfaces.includes(entry.receivedOn)) {
        this.reverseTable.delete(key);
      }
    }

    // Cull expired path table entries
    for (const [key, entry] of this.pathTable) {
      if (!entry || now > entry.expires) {
        this.pathTable.delete(key);
      }
    }

    // Cull stale announce table entries (DESTINATION_TIMEOUT = 7 days)
    for (const [key, entry] of this.announceTable) {
      if (!entry || now > entry.timestamp + DESTINATION_TIMEOUT) {
        this.announceTable.delete(key);
      }
    }

    // Cull expired pending announce rebroadcasts
    for (const [key, entry] of this.pendingAnnounces) {
      if (entry.retries > PATHFINDER_R) {
        this.pendingAnnounces.delete(key);
      }
    }

    // Enforce size caps — evict oldest entries when over limit
    this._evictOldest(this.reverseTable, MAX_REVERSE_TABLE_SIZE, 'timestamp');
    this._evictOldest(this.pathTable, MAX_PATH_TABLE_SIZE, 'timestamp');
    this._evictOldest(this.announceTable, MAX_ANNOUNCE_TABLE_SIZE, 'timestamp');
  }

  /**
   * Evict oldest entries from a Map when it exceeds maxSize.
   * @param {Map} table
   * @param {number} maxSize
   * @param {string} timestampField
   */
  _evictOldest(table, maxSize, timestampField) {
    if (table.size <= maxSize) return;

    // Sort by timestamp ascending, remove oldest
    const entries = [...table.entries()]
      .sort((a, b) => (a[1][timestampField] || 0) - (b[1][timestampField] || 0));

    const toRemove = entries.length - maxSize;
    for (let i = 0; i < toRemove; i++) {
      table.delete(entries[i][0]);
    }

    log(LOG_DEBUG, TAG, `Evicted ${toRemove} oldest entries from table (was ${entries.length}, now ${table.size})`);
  }

  // --- Dedup helpers ---

  _isDuplicate(packetHash) {
    if (!packetHash) return false;
    const hex = toHex(packetHash);
    return this.packetHashlist.has(hex) || this.packetHashlistPrev.has(hex);
  }

  _addToHashlist(packetHash) {
    if (!packetHash) return;
    const hex = toHex(packetHash);

    if (this.packetHashlist.size >= HASHLIST_MAXSIZE) {
      this.packetHashlistPrev = this.packetHashlist;
      this.packetHashlist = new Set();
    }

    this.packetHashlist.add(hex);
  }
}
