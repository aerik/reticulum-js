/**
 * Link — virtual encrypted channel to a Single destination.
 *
 * Matches the Python reference implementation (RNS/Link.py).
 *
 * Provides:
 * - Forward secrecy via ephemeral X25519 key exchange
 * - Authenticated encryption (AES-256-CBC + HMAC-SHA256)
 * - Request/response API
 * - Keepalive mechanism
 *
 * Handshake:
 *   1. Initiator sends LINKREQUEST with ephemeral X25519 + Ed25519 public keys
 *   2. Responder proves ownership with identity signature + its own ephemeral X25519 pub
 *   3. Both sides derive session keys via ECDH + HKDF(salt=link_id, info=empty)
 *   4. Initiator sends encrypted RTT packet to confirm
 *   5. Link is ACTIVE — bidirectional encrypted channel
 */

import { EventEmitter } from './utils/events.js';
import {
  generateX25519Keypair,
  generateEd25519Keypair,
  x25519SharedSecret,
  ed25519Sign,
  ed25519Verify,
  hkdfDerive,
  hmacSha256,
  aesCbcEncrypt,
  aesCbcDecrypt,
  truncatedHash,
  sha256Hash,
} from './utils/crypto.js';
import { concat, toHex, equal, randomBytes } from './utils/bytes.js';
import { Packet } from './Packet.js';
import { ResourceReceiver, ResourceSender, RESOURCE_COMPLETE, RESOURCE_FAILED } from './Resource.js';
import { log, LOG_DEBUG, LOG_INFO, LOG_WARNING, LOG_VERBOSE } from './utils/log.js';
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import {
  PACKET_DATA, PACKET_LINK_REQUEST, PACKET_PROOF,
  TRANSPORT_BROADCAST, HEADER_1,
  DEST_SINGLE, DEST_LINK,
  FLAG_UNSET,
  CONTEXT_NONE, CONTEXT_LRPROOF, CONTEXT_LRRTT,
  CONTEXT_KEEPALIVE, CONTEXT_LINKCLOSE, CONTEXT_LINKPROOF,
  CONTEXT_REQUEST, CONTEXT_RESPONSE,
  CONTEXT_RESOURCE_PRF, CONTEXT_RESOURCE_ICL, CONTEXT_RESOURCE_RCL,
  IDENTITY_HASH_LENGTH,
  IDENTITY_DERIVED_KEY_LENGTH,
} from './constants.js';

const TAG = 'Link';

// Link states
export const LINK_PENDING   = 0x00;
export const LINK_HANDSHAKE = 0x01;
export const LINK_ACTIVE    = 0x02;
export const LINK_STALE     = 0x03;
export const LINK_CLOSED    = 0x04;

// Teardown reasons
export const TIMEOUT            = 0x01;
export const INITIATOR_CLOSED   = 0x02;
export const DESTINATION_CLOSED = 0x03;

// Resource acceptance strategies — match Python RNS/Link.py:120-122.
export const ACCEPT_NONE = 0x00;
export const ACCEPT_APP  = 0x01;
export const ACCEPT_ALL  = 0x02;

// RequestReceipt states — match Python RNS/Link.py:1349-1356.
export const REQUEST_FAILED    = 0x00;
export const REQUEST_SENT      = 0x01;
export const REQUEST_DELIVERED = 0x02;
export const REQUEST_RECEIVING = 0x03;
export const REQUEST_READY     = 0x04;

// Sizes
const ECPUBSIZE = 64; // 32 X25519 + 32 Ed25519

// Default establishment timeout per hop
const ESTABLISHMENT_TIMEOUT_PER_HOP = 6; // seconds
const DEFAULT_FIRST_HOP_TIMEOUT = 15;    // seconds

// Keepalive / stale detection (matching Python RNS/Link.py)
const KEEPALIVE_MAX = 360;                // 6 min — upper bound for keepalive interval
const KEEPALIVE_MIN = 5;                  // lower bound
const KEEPALIVE_MAX_RTT = 1.75;          // RTT at which keepalive hits KEEPALIVE_MAX
const STALE_FACTOR = 2;                   // stale_time = keepalive * STALE_FACTOR
const STALE_GRACE = 5;                    // seconds added after entering STALE
const KEEPALIVE_TIMEOUT_FACTOR = 4;       // RTT multiplier for post-STALE timeout
const WATCHDOG_INTERVAL = 5;              // seconds — max sleep between watchdog checks

export class Link extends EventEmitter {
  /**
   * Create a link. Usually called via Link.init() (initiator) or Link.validateRequest() (responder).
   */
  constructor() {
    super();
    this.status = LINK_PENDING;
    this.linkId = null;           // 16 bytes
    this.destination = null;

    // Ephemeral keys (initiator side)
    this._encPriv = null;         // X25519 private key
    this._encPub = null;          // X25519 public key
    this._sigPriv = null;         // Ed25519 private key (initiator only)
    this._sigPub = null;          // Ed25519 public key (initiator only)

    // Peer keys
    this._peerEncPub = null;      // Peer's X25519 public key

    // Derived session keys
    this._sharedKey = null;       // Raw ECDH output
    this._derivedKey = null;      // HKDF output (64 bytes)
    this._signingKey = null;      // derived[0:32] — HMAC key
    this._encryptionKey = null;   // derived[32:64] — AES-256-CBC key

    // Timing
    this.rtt = null;
    this.establishedAt = null;
    this.lastInbound = null;
    this.lastOutbound = null;

    // Transport reference (for sending)
    this._transport = null;

    // Request handlers
    this._requestHandlers = new Map();
    this._pendingRequests = new Map();

    // Pending packet proofs — map from hex(packetHash) → { resolve, reject, timer }
    // Used by sendWithProof() on the initiator side to wait for PROOF of a sent packet.
    this._pendingProofs = new Map();

    // Outgoing resources keyed by hex(resource.hash). Each entry tracks a
    // ResourceSender that's been advertised on this link. We dispatch
    // RESOURCE_REQ and RESOURCE_PRF inbound packets to the matching sender.
    this._outgoingResources = new Map();

    // Incoming resource tracking
    this._activeResource = null;

    // Resource acceptance strategy — matches Python RNS/Link.py:120-122,242.
    // Default is ACCEPT_NONE (ignore all incoming resource advertisements).
    // LXMF sets ACCEPT_APP with a callback so the router can check size limits.
    this.resourceStrategy = ACCEPT_NONE;
    this._resourceCallback = null;          // callback(adv) → bool, for ACCEPT_APP
    this._resourceConcludedCallback = null; // callback(resource)

    // Keepalive / stale detection (matching Python RNS/Link.py watchdog)
    this._initiator = false;
    this.keepalive = KEEPALIVE_MAX;
    this.staleTime = KEEPALIVE_MAX * STALE_FACTOR;
    this._lastKeepalive = 0;
    this._watchdogTimer = null;
  }

  /**
   * Initiate a link to a destination.
   * @param {import('./Destination.js').Destination} destination
   * @param {Transport} transport
   * @returns {Link}
   */
  static init(destination, transport) {
    const link = new Link();
    link.destination = destination;
    link._transport = transport;
    link._initiator = true;

    // Generate ephemeral keypairs
    const enc = generateX25519Keypair();
    link._encPriv = enc.privateKey;
    link._encPub = enc.publicKey;

    const sig = generateEd25519Keypair();
    link._sigPriv = sig.privateKey;
    link._sigPub = sig.publicKey;

    // Build and send the link request
    link._sendLinkRequest();

    return link;
  }

  /**
   * Validate an incoming link request and create the responder-side Link.
   * @param {Packet} packet - The LINKREQUEST packet
   * @param {import('./Destination.js').Destination} destination - Our destination
   * @param {Transport} transport
   * @returns {Link|null} The new link, or null if validation fails
   */
  static validateRequest(packet, destination, transport) {
    if (packet.packetType !== PACKET_LINK_REQUEST) return null;
    if (!destination.identity || !destination.identity.hasPrivateKey()) return null;

    const data = packet.data;
    if (data.length < ECPUBSIZE) {
      log(LOG_WARNING, TAG, 'Link request too short');
      return null;
    }

    // Extract initiator's ephemeral keys
    const peerEncPub = data.slice(0, 32);
    const peerSigPub = data.slice(32, 64);
    const signalling = data.length > ECPUBSIZE ? data.slice(ECPUBSIZE) : null;

    // Compute link ID from the packet
    const linkId = Link.linkIdFromPacket(packet);

    // Create the responder-side Link
    const link = new Link();
    link.linkId = linkId;
    link.destination = destination;
    link._transport = transport;
    link._peerEncPub = peerEncPub;
    link._identity = destination.identity; // for signing proofs
    link.status = LINK_HANDSHAKE;

    // Generate our ephemeral X25519 keypair
    const enc = generateX25519Keypair();
    link._encPriv = enc.privateKey;
    link._encPub = enc.publicKey;

    // Perform ECDH
    link._deriveSessionKeys();

    // Send proof
    link._sendProof(signalling);

    log(LOG_INFO, TAG, `Accepted link request ${toHex(linkId).slice(0, 16)}..`);

    return link;
  }

  /**
   * Compute link_id from a LINKREQUEST packet.
   * link_id = SHA256(hashable_part_without_signalling)[:16]
   * @param {Packet} packet
   * @returns {Uint8Array} 16-byte link ID
   */
  static linkIdFromPacket(packet) {
    if (!packet.raw) packet.pack();

    // hashable_part = (flags & 0x0F) + raw[2:]
    const hashableFlags = new Uint8Array([packet.raw[0] & 0x0F]);
    let hashableRest = packet.raw.slice(2);

    // Strip signalling bytes if present
    if (packet.data.length > ECPUBSIZE) {
      const diff = packet.data.length - ECPUBSIZE;
      hashableRest = hashableRest.slice(0, hashableRest.length - diff);
    }

    return truncatedHash(concat(hashableFlags, hashableRest), IDENTITY_HASH_LENGTH);
  }

  /**
   * Handle an incoming proof packet (initiator side).
   * @param {Packet} packet - PROOF with LRPROOF context
   * @param {import('./Identity.js').Identity} destinationIdentity - The destination's public identity
   * @returns {boolean} true if proof is valid
   */
  async handleProof(packet, destinationIdentity) {
    if (this.status !== LINK_PENDING) return false;

    const data = packet.data;
    if (data.length < 96) { // 64 sig + 32 pub minimum
      log(LOG_WARNING, TAG, 'Link proof too short');
      return false;
    }

    const signature = data.slice(0, 64);
    const peerEncPub = data.slice(64, 96);
    const signalling = data.length > 96 ? data.slice(96) : null;

    // Reconstruct signed data: link_id + peer_enc_pub + peer_sig_pub + signalling
    // Note: responder includes its own sig_pub in signed data but that's actually
    // not sent — the permanent identity key is used. Let me re-check...
    // Actually, signed_data = link_id + responder_pub + responder_sig_pub + signalling
    // But responder doesn't have separate sig_pub in proof — it uses identity's sig key.
    // Re-reading: signed_data = self.link_id + self.peer_pub_bytes + self.peer_sig_pub_bytes + signalling
    // In responder context: peer_pub = responder's own enc pub, peer_sig_pub = responder's identity sig pub?
    // No — the responder's "peer" is the initiator. Let me trace more carefully.
    //
    // Actually from the proof construction in Python:
    //   signed_data = self.link_id + self.pub_bytes + self.sig_pub_bytes
    //   where self.pub_bytes = responder's ephemeral X25519 pub
    //   and self.sig_pub_bytes = responder's ephemeral Ed25519 pub (but for responder,
    //   this is the IDENTITY's signing key, not ephemeral)
    //
    // Wait — looking more carefully at the Python code:
    //   For responder (incoming link), sig_pub is set to destination.identity.sig_pub_bytes
    //   signed_data includes responder's pub_bytes + sig_pub_bytes + signalling if present
    //   BUT sig_pub_bytes is NOT included in the proof_data sent over the wire
    //
    // So the initiator needs to reconstruct signed_data using:
    //   link_id + peer_enc_pub (from proof) + destination_sig_pub (known from announce/identity)
    //   + signalling (if present)

    // Build signed_data as responder would have
    const signedParts = [this.linkId, peerEncPub, destinationIdentity.signingPublicKey];
    if (signalling) signedParts.push(signalling);
    const signedData = concat(...signedParts);

    // Verify with destination's permanent identity key
    if (!destinationIdentity.verify(signedData, signature)) {
      log(LOG_WARNING, TAG, 'Link proof signature verification failed');
      return false;
    }

    // Proof is valid — complete ECDH
    this._peerEncPub = peerEncPub;
    this._deriveSessionKeys();

    this.status = LINK_ACTIVE;
    this.establishedAt = Date.now();
    this.lastInbound = Date.now();
    this._updateKeepalive();
    this._startWatchdog();

    log(LOG_INFO, TAG, `Link established: ${toHex(this.linkId).slice(0, 16)}..`);

    // Send RTT packet
    await this._sendRtt();

    this.emit('established', this);
    return true;
  }

  /**
   * Handle an incoming RTT packet (responder side).
   * Transitions from HANDSHAKE to ACTIVE.
   * @param {Uint8Array} encryptedData
   */
  handleRtt(encryptedData) {
    if (this.status !== LINK_HANDSHAKE) return;

    try {
      // Decrypt — if this succeeds, the session keys are correct
      const _plaintext = this.decrypt(encryptedData);
      this.status = LINK_ACTIVE;
      this.establishedAt = Date.now();
      this.lastInbound = Date.now();
      this._updateKeepalive();
      this._startWatchdog();

      log(LOG_INFO, TAG, `Link active (responder): ${toHex(this.linkId).slice(0, 16)}..`);
      this.emit('established', this);
    } catch (err) {
      log(LOG_WARNING, TAG, `RTT decryption failed: ${err.message}`);
    }
  }

  /**
   * Encrypt data for sending over this link.
   * Format: IV(16) + AES-256-CBC(PKCS7(plaintext)) + HMAC-SHA256(IV + ciphertext)
   * @param {Uint8Array} plaintext
   * @returns {Promise<Uint8Array>}
   */
  async encrypt(plaintext) {
    if (!this._encryptionKey) throw new Error('Link has no session keys');

    const iv = randomBytes(16);
    const ciphertext = await aesCbcEncrypt(plaintext, this._encryptionKey, iv);
    const signedParts = concat(iv, ciphertext);
    const mac = hmacSha256(this._signingKey, signedParts);

    return concat(signedParts, mac);
  }

  /**
   * Decrypt data received over this link.
   * @param {Uint8Array} token - IV(16) + ciphertext + HMAC(32)
   * @returns {Promise<Uint8Array>} plaintext
   */
  async decrypt(token) {
    if (!this._encryptionKey) throw new Error('Link has no session keys');
    if (token.length < 48) throw new Error('Token too short');

    const iv = token.slice(0, 16);
    const ciphertext = token.slice(16, token.length - 32);
    const receivedMac = token.slice(token.length - 32);

    // Verify HMAC
    const signedParts = concat(iv, ciphertext);
    const expectedMac = hmacSha256(this._signingKey, signedParts);

    if (!equal(receivedMac, expectedMac)) {
      throw new Error('HMAC verification failed');
    }

    return aesCbcDecrypt(ciphertext, this._encryptionKey, iv);
  }

  /**
   * Send data over the link (encrypted).
   * @param {Uint8Array} data
   * @param {number} [context=CONTEXT_NONE]
   */
  async send(data, context = CONTEXT_NONE) {
    if (this.status !== LINK_ACTIVE) {
      throw new Error('Link is not active');
    }

    const encrypted = await this.encrypt(data);
    const pkt = new Packet();
    pkt.headerType = HEADER_1;
    pkt.packetType = PACKET_DATA;
    pkt.destType = DEST_LINK;
    pkt.transportType = TRANSPORT_BROADCAST;
    pkt.destinationHash = this.linkId;
    pkt.context = context;
    pkt.data = encrypted;
    this._transport.transmit(pkt);
    this.lastOutbound = Date.now();
  }

  /**
   * Send data over the link WITHOUT per-packet encryption.
   *
   * Used for resource parts (CONTEXT_RESOURCE) and resource proofs
   * (CONTEXT_RESOURCE_PRF) — Python's Packet.pack() skips encryption for
   * these contexts because the Resource encrypts its own stream and the
   * proof is a hash. We must match that on the wire.
   *
   * @param {Uint8Array} data
   * @param {number} context
   * @param {number} [packetType=PACKET_DATA] - PACKET_DATA or PACKET_PROOF
   */
  sendRaw(data, context, packetType = PACKET_DATA) {
    if (this.status !== LINK_ACTIVE) {
      throw new Error('Link is not active');
    }
    const pkt = new Packet();
    pkt.headerType = HEADER_1;
    pkt.packetType = packetType;
    pkt.destType = DEST_LINK;
    pkt.transportType = TRANSPORT_BROADCAST;
    pkt.destinationHash = this.linkId;
    pkt.context = context;
    pkt.data = data;

    this._transport.transmit(pkt);
    this.lastOutbound = Date.now();
  }

  /**
   * Send a request over the link.
   *
   * Wire format (msgpack-encoded, then encrypted):
   *   [timestamp_float, path_hash_10bytes, data_bytes_or_null]
   *
   * path_hash = SHA256(path_utf8)[:10]  (NAME_HASH_LENGTH, matching Python)
   *
   * The request_id is the truncated hash of the sent packet (matching Python's
   * packet.getTruncatedHash()), used to correlate responses.
   *
   * @param {string} path - Request path (e.g. "/page/index.mu")
   * @param {Uint8Array|null} [data=null] - Request data
   * @param {number} [timeout=10000] - Response timeout in ms
   * @returns {Promise<Uint8Array|null>} Response data, or null on timeout
   */
  /**
   * Send a request to the remote peer via the link, matching Python's
   * `Link.request()` in RNS/Link.py:478.
   *
   * Returns a Promise that resolves to the response data (Uint8Array) or
   * `null` on timeout/failure — so `await link.request(...)` works exactly
   * as before. The returned Promise also has a `.receipt` property for
   * callers who want the full `RequestReceipt` state machine + callbacks.
   *
   * @param {string} path - Request path (hashed to 16 bytes internally)
   * @param {Uint8Array|null} [data] - Request payload
   * @param {number|object} [optionsOrTimeout] - Timeout in ms (legacy) or options:
   *   @param {number} [optionsOrTimeout.timeout=10000]
   *   @param {function(RequestReceipt):void} [optionsOrTimeout.onResponse]
   *   @param {function(RequestReceipt):void} [optionsOrTimeout.onFailed]
   *   @param {function(RequestReceipt):void} [optionsOrTimeout.onProgress]
   * @returns {Promise<Uint8Array|null> & {receipt: RequestReceipt}}
   */
  request(path, data = null, optionsOrTimeout = {}) {
    if (this.status !== LINK_ACTIVE) {
      return Promise.reject(new Error('Link is not active'));
    }

    const opts = typeof optionsOrTimeout === 'number'
      ? { timeout: optionsOrTimeout }
      : optionsOrTimeout;
    const timeout = opts.timeout || 10000;

    const receipt = new RequestReceipt(this, null, Date.now() / 1000, timeout, opts);

    const dataPromise = (async () => {
      // Path hash: SHA256(path_utf8)[:16]
      const pathHash = truncatedHash(new TextEncoder().encode(path), IDENTITY_HASH_LENGTH);
      const timestamp = Date.now() / 1000;

      const packed = msgpackEncode([timestamp, pathHash, data]);
      const packedBytes = new Uint8Array(packed);

      const encrypted = await this.encrypt(packedBytes);
      const pkt = new Packet();
      pkt.headerType = HEADER_1;
      pkt.packetType = PACKET_DATA;
      pkt.destType = DEST_LINK;
      pkt.transportType = TRANSPORT_BROADCAST;
      pkt.destinationHash = this.linkId;
      pkt.context = CONTEXT_REQUEST;
      pkt.data = encrypted;
      pkt.pack();

      const requestId = pkt.packetHash.slice(0, IDENTITY_HASH_LENGTH);
      const requestIdHex = toHex(requestId);

      receipt.requestId = requestId;
      receipt.hash = requestId;

      this._transport.transmit(pkt);
      this.lastOutbound = Date.now();

      this._pendingRequests.set(requestIdHex, {
        receipt,
        resolve: (responseData) => {
          this._pendingRequests.delete(requestIdHex);
          receipt._responseReceived(responseData);
        },
      });

      return receipt.promise;
    })();

    dataPromise.receipt = receipt;
    return dataPromise;
  }

  /**
   * Register a request handler for a path.
   * @param {string} path - Request path
   * @param {function(Uint8Array|null, Link): Promise<Uint8Array|null>} handler
   */
  registerRequestHandler(path, handler) {
    const pathHash = truncatedHash(new TextEncoder().encode(path), IDENTITY_HASH_LENGTH);
    this._requestHandlers.set(toHex(pathHash), handler);
  }

  /**
   * Handle an incoming request packet (responder side).
   * @param {Uint8Array} plaintext - Decrypted request data
   * @param {Packet} packet
   */
  async _handleRequest(plaintext, packet) {
    try {
      const unpacked = msgpackDecode(plaintext);
      if (!Array.isArray(unpacked) || unpacked.length < 3) return;

      const [timestamp, pathHash, requestData] = unpacked;
      const pathHashHex = toHex(new Uint8Array(pathHash));

      const handler = this._requestHandlers.get(pathHashHex);
      if (!handler) {
        log(LOG_DEBUG, TAG, `No handler for request path ${pathHashHex}`);
        return;
      }

      // request_id = packetHash[:16] — matches Python's getTruncatedHash()
      const requestId = packet.packetHash
        ? packet.packetHash.slice(0, IDENTITY_HASH_LENGTH)
        : truncatedHash(new Uint8Array(plaintext), IDENTITY_HASH_LENGTH);

      // Call handler
      const responseData = await handler(
        requestData ? new Uint8Array(requestData) : null,
        this
      );

      // Send response: msgpack([request_id, response_data])
      const responsePacked = msgpackEncode([requestId, responseData]);
      await this.send(new Uint8Array(responsePacked), CONTEXT_RESPONSE);

    } catch (err) {
      log(LOG_WARNING, TAG, `Request handling error: ${err.message}`);
    }
  }

  /**
   * Handle an incoming response packet (initiator side).
   * @param {Uint8Array} plaintext - Decrypted response data
   */
  _handleResponse(plaintext) {
    try {
      const unpacked = msgpackDecode(plaintext);
      if (!Array.isArray(unpacked) || unpacked.length < 2) return;

      const [requestId, responseData] = unpacked;
      const requestIdHex = toHex(new Uint8Array(requestId));

      const pending = this._pendingRequests.get(requestIdHex);
      if (pending && pending.resolve) {
        pending.resolve(responseData ? new Uint8Array(responseData) : null);
      }
    } catch (err) {
      log(LOG_WARNING, TAG, `Response handling error: ${err.message}`);
    }
  }

  // --- Incoming Resource handling ---

  /**
   * Handle an incoming resource advertisement on this link.
   *
   * Dispatches according to `this.resourceStrategy`, matching Python
   * RNS/Link.py:1069-1102:
   *   ACCEPT_NONE → silently ignore
   *   ACCEPT_APP  → call `_resourceCallback(adv)`, accept if true, reject if false
   *   ACCEPT_ALL  → auto-accept
   *
   * @param {Uint8Array} plaintext - Decrypted RESOURCE_ADV data
   */
  _handleResourceAdv(plaintext) {
    try {
      // Parse the advertisement just enough to inspect size / hash for the
      // strategy callback. If the strategy rejects, we never fully construct
      // the receiver — just send an RCL with the resource hash.
      const receiver = new ResourceReceiver(this, plaintext);

      log(LOG_INFO, TAG, `Resource advertised: ${receiver.totalParts} parts, ${receiver.dataSize} bytes`);

      // --- Strategy dispatch ---
      if (this.resourceStrategy === ACCEPT_NONE) {
        log(LOG_DEBUG, TAG, 'Resource ignored (strategy=ACCEPT_NONE)');
        return;
      }

      if (this.resourceStrategy === ACCEPT_APP) {
        if (!this._resourceCallback) {
          log(LOG_DEBUG, TAG, 'Resource ignored (strategy=ACCEPT_APP, no callback)');
          return;
        }
        const advInfo = {
          dataSize: receiver.dataSize,
          totalParts: receiver.totalParts,
          hash: receiver.hash,
          link: this,
        };
        let accepted = false;
        try {
          accepted = this._resourceCallback(advInfo);
        } catch (err) {
          log(LOG_WARNING, TAG, `Resource accept callback error: ${err.message}`);
        }
        if (!accepted) {
          log(LOG_DEBUG, TAG, `Resource rejected by callback (${receiver.dataSize} bytes)`);
          this.send(receiver.hash, CONTEXT_RESOURCE_RCL).catch(() => {});
          return;
        }
      }
      // ACCEPT_ALL (or ACCEPT_APP that returned true) → accept the resource.

      this._activeResource = receiver;

      receiver.onComplete((data) => {
        log(LOG_INFO, TAG, `Resource complete: ${data.length} bytes, requestId=${receiver.requestId ? toHex(receiver.requestId).slice(0,16) : 'null'}, pendingRequests=${this._pendingRequests.size}`);

        // Check if this is a response to a pending request
        if (receiver.requestId || this._pendingRequests.size > 0) {
          try {
            const unpacked = msgpackDecode(data);
            if (Array.isArray(unpacked) && unpacked.length >= 2) {
              log(LOG_DEBUG, TAG, `Resource response: request_id=${toHex(new Uint8Array(unpacked[0])).slice(0,16)}, data=${unpacked[1] ? unpacked[1].length + 'b' : 'null'}`);
              this._handleResponse(data);
              return;
            }
          } catch (err) {
            log(LOG_WARNING, TAG, `Resource response parse failed: ${err.message}`);
          }
        }

        // Otherwise emit as generic resource data
        this.emit('resource_complete', data, receiver);
        this._activeResource = null;
      });

      receiver.accept().catch(err => {
        log(LOG_WARNING, TAG, `Resource accept failed: ${err.message}`);
      });

    } catch (err) {
      log(LOG_WARNING, TAG, `Resource ADV error: ${err.message}`);
    }
  }

  /**
   * Handle an incoming resource data part.
   * @param {Uint8Array} plaintext - Decrypted RESOURCE part data
   */
  _handleResourcePart(plaintext) {
    if (this._activeResource) {
      this._activeResource.receivePart(plaintext);
    }
  }

  /**
   * Handle a resource hashmap update.
   * @param {Uint8Array} plaintext - Decrypted RESOURCE_HMU data
   */
  _handleResourceHmu(plaintext) {
    if (this._activeResource && this._activeResource.handleHashmapUpdate) {
      this._activeResource.handleHashmapUpdate(plaintext);
    } else {
      log(LOG_WARNING, TAG, 'Resource HMU received but no active resource to handle it');
    }
  }

  /**
   * Handle an inbound RESOURCE_ICL (initiator cancel) packet.
   * The payload is the 32-byte resource hash of the incoming resource the
   * sender wants to cancel. Matches Python RNS/Link.py:1135.
   * @param {Uint8Array} plaintext
   */
  _handleResourceIcl(plaintext) {
    if (!plaintext || plaintext.length < 32) return;
    const resourceHash = plaintext.slice(0, 32);
    const receiver = this._activeResource;
    if (receiver && receiver.hash && equal(receiver.hash, resourceHash)) {
      receiver.cancel('Sender cancelled transfer');
      this._activeResource = null;
    } else {
      log(LOG_DEBUG, TAG, `RESOURCE_ICL for unknown incoming resource ${toHex(resourceHash).slice(0,16)}..`);
    }
  }

  /**
   * Handle an inbound RESOURCE_RCL (receiver-side reject) packet.
   * The payload is the 32-byte resource hash of an outgoing resource the
   * peer is rejecting (e.g. because it exceeds the receiver's limit).
   * Matches Python RNS/Link.py:1144.
   * @param {Uint8Array} plaintext
   */
  _handleResourceRcl(plaintext) {
    if (!plaintext || plaintext.length < 32) return;
    const resourceHash = plaintext.slice(0, 32);
    const hashHex = toHex(resourceHash);
    const entry = this._outgoingResources.get(hashHex);
    if (!entry) {
      log(LOG_DEBUG, TAG, `RESOURCE_RCL for unknown outgoing resource ${hashHex.slice(0,16)}..`);
      return;
    }
    log(LOG_INFO, TAG, `Outgoing resource ${hashHex.slice(0,16)}.. rejected by receiver`);
    entry.sender._rejected('Resource rejected by receiver (possibly exceeds delivery limit)');
  }

  /**
   * Set the resource acceptance strategy for this link.
   * Matches Python `Link.set_resource_strategy` in RNS/Link.py:1296.
   * @param {number} strategy - ACCEPT_NONE, ACCEPT_APP, or ACCEPT_ALL
   */
  setResourceStrategy(strategy) {
    if (strategy !== ACCEPT_NONE && strategy !== ACCEPT_APP && strategy !== ACCEPT_ALL) {
      throw new TypeError('Unsupported resource strategy');
    }
    this.resourceStrategy = strategy;
  }

  /**
   * Set the callback invoked when a resource advertisement arrives on this
   * link (only used when strategy is ACCEPT_APP). The callback receives a
   * lightweight advertisement object `{ dataSize, totalParts, hash, link }`
   * and must return `true` to accept or `false` to reject.
   * Matches Python `Link.set_resource_callback` in RNS/Link.py:1268.
   * @param {function({dataSize:number, totalParts:number, hash:Uint8Array, link:Link}):boolean} callback
   */
  setResourceCallback(callback) {
    this._resourceCallback = callback;
  }

  /**
   * Set the callback invoked when an accepted resource transfer concludes
   * (success or failure).
   * @param {function} callback
   */
  setResourceConcludedCallback(callback) {
    this._resourceConcludedCallback = callback;
  }

  /**
   * Close the link.
   */
  async close() {
    if (this.status === LINK_CLOSED) return;

    if (this._encryptionKey) {
      try {
        // Send close packet with encrypted link_id as proof
        const encrypted = await this.encrypt(this.linkId);
        const pkt = new Packet();
        pkt.headerType = HEADER_1;
        pkt.packetType = PACKET_DATA;
        pkt.destType = DEST_LINK;
        pkt.transportType = TRANSPORT_BROADCAST;
        pkt.destinationHash = this.linkId;
        pkt.context = CONTEXT_LINKCLOSE;
        pkt.data = encrypted;
        this._transport.transmit(pkt);
      } catch {
        // Best effort
      }
    }

    this._teardown(INITIATOR_CLOSED);
  }

  /**
   * Handle an incoming close packet.
   * @param {Uint8Array} encryptedData
   */
  async handleClose(encryptedData) {
    try {
      const plaintext = await this.decrypt(encryptedData);
      if (equal(plaintext, this.linkId)) {
        this._teardown(DESTINATION_CLOSED);
      }
    } catch {
      // Invalid close, ignore
    }
  }

  /**
   * Handle an incoming keepalive packet.
   * @param {Uint8Array} data - Single byte: 0xFF=request, 0xFE=response
   */
  handleKeepalive(data) {
    this.lastInbound = Date.now();

    if (data.length > 0 && data[0] === 0xFF) {
      // Keepalive request — send response
      const pkt = new Packet();
      pkt.headerType = HEADER_1;
      pkt.packetType = PACKET_DATA;
      pkt.destType = DEST_LINK;
      pkt.transportType = TRANSPORT_BROADCAST;
      pkt.destinationHash = this.linkId;
      pkt.context = CONTEXT_KEEPALIVE;
      pkt.data = new Uint8Array([0xFE]);
      this._transport.transmit(pkt);
    }
  }

  // --- Keepalive / Stale detection (matching Python RNS/Link.py watchdog) ---

  /**
   * Update keepalive interval based on current RTT.
   * Matches Python Link.__update_keepalive():
   *   keepalive = clamp(rtt * KEEPALIVE_MAX/KEEPALIVE_MAX_RTT, KEEPALIVE_MIN, KEEPALIVE_MAX)
   *   stale_time = keepalive * STALE_FACTOR
   */
  _updateKeepalive() {
    if (this.rtt && this.rtt > 0) {
      this.keepalive = Math.max(
        Math.min(this.rtt * (KEEPALIVE_MAX / KEEPALIVE_MAX_RTT), KEEPALIVE_MAX),
        KEEPALIVE_MIN
      );
    } else {
      this.keepalive = KEEPALIVE_MAX;
    }
    this.staleTime = this.keepalive * STALE_FACTOR;
  }

  /**
   * Start the watchdog timer that monitors link health.
   * Matches Python Link.__watchdog_job() behavior.
   */
  _startWatchdog() {
    this._stopWatchdog();
    this._watchdogTimer = setInterval(() => this._watchdogCheck(), WATCHDOG_INTERVAL * 1000);
  }

  _stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  /**
   * Watchdog check — called every WATCHDOG_INTERVAL seconds.
   * Matching Python Link.__watchdog_job():
   * - If ACTIVE and no inbound for keepalive period: initiator sends keepalive
   * - If ACTIVE and no inbound for stale_time: transition to STALE
   * - If STALE and timeout expires: teardown with TIMEOUT
   */
  _watchdogCheck() {
    if (this.status === LINK_CLOSED) {
      this._stopWatchdog();
      return;
    }

    const now = Date.now();
    const lastIn = this.lastInbound || this.establishedAt || now;
    const silenceMs = now - lastIn;

    if (this.status === LINK_ACTIVE) {
      // Check if we need to send keepalive (initiator only)
      if (this._initiator && silenceMs >= this.keepalive * 1000) {
        if (now - this._lastKeepalive >= this.keepalive * 1000) {
          this._sendKeepalive();
          this._lastKeepalive = now;
        }
      }

      // Check for stale
      if (silenceMs >= this.staleTime * 1000) {
        this.status = LINK_STALE;
        log(LOG_INFO, TAG, `Link stale: ${toHex(this.linkId).slice(0, 16)}.. (no inbound for ${(silenceMs / 1000).toFixed(0)}s)`);
        this.emit('stale', this);

        // Schedule final timeout: rtt * KEEPALIVE_TIMEOUT_FACTOR + STALE_GRACE
        const rttMs = (this.rtt || 1) * KEEPALIVE_TIMEOUT_FACTOR * 1000;
        const graceMs = STALE_GRACE * 1000;
        this._staleTimeout = setTimeout(() => {
          if (this.status === LINK_STALE) {
            log(LOG_INFO, TAG, `Link timeout: ${toHex(this.linkId).slice(0, 16)}..`);
            this._teardown(TIMEOUT);
          }
        }, rttMs + graceMs);
      }
    } else if (this.status === LINK_STALE) {
      // If a packet arrived, the handleKeepalive/handleLinkData code sets
      // lastInbound, but we also need to recover from STALE → ACTIVE
      if (silenceMs < this.staleTime * 1000) {
        this.status = LINK_ACTIVE;
        if (this._staleTimeout) {
          clearTimeout(this._staleTimeout);
          this._staleTimeout = null;
        }
        log(LOG_INFO, TAG, `Link recovered from stale: ${toHex(this.linkId).slice(0, 16)}..`);
      }
    }
  }

  /**
   * Send a keepalive request (0xFF). Only the initiator sends these.
   * Responder echoes back 0xFE (handled in handleKeepalive).
   */
  _sendKeepalive() {
    const pkt = new Packet();
    pkt.headerType = HEADER_1;
    pkt.packetType = PACKET_DATA;
    pkt.destType = DEST_LINK;
    pkt.transportType = TRANSPORT_BROADCAST;
    pkt.destinationHash = this.linkId;
    pkt.context = CONTEXT_KEEPALIVE;
    pkt.data = new Uint8Array([0xFF]);
    this._transport.transmit(pkt);
    log(LOG_DEBUG, TAG, `Sent keepalive for ${toHex(this.linkId).slice(0, 16)}..`);
  }

  /**
   * Send data on the link and return a Promise that resolves when a packet
   * proof is received. Matching Python Packet.send() + prove() flow where the
   * responder calls link.prove_packet() after receiving the data.
   *
   * @param {Uint8Array} data - Plaintext data to send
   * @param {number} [timeoutMs=15000] - Proof wait timeout
   * @returns {Promise<void>} Resolves on proof, rejects on timeout or link close
   */
  async sendWithProof(data, timeoutMs = 15000) {
    if (this.status !== LINK_ACTIVE) {
      throw new Error('Link is not active');
    }

    // Build the packet manually so we can capture its hash before transmit.
    const encrypted = await this.encrypt(data);
    const pkt = new Packet();
    pkt.headerType = HEADER_1;
    pkt.packetType = PACKET_DATA;
    pkt.destType = DEST_LINK;
    pkt.transportType = TRANSPORT_BROADCAST;
    pkt.destinationHash = this.linkId;
    pkt.context = CONTEXT_NONE;
    pkt.data = encrypted;
    pkt.pack(); // computes packetHash = SHA256(hashable_part)

    const hashHex = toHex(pkt.packetHash);

    const proofPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingProofs.delete(hashHex);
        reject(new Error(`Packet proof timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this._pendingProofs.set(hashHex, {
        resolve: () => {
          clearTimeout(timer);
          this._pendingProofs.delete(hashHex);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          this._pendingProofs.delete(hashHex);
          reject(err);
        },
      });
    });

    this._transport.transmit(pkt);
    this.lastOutbound = Date.now();

    return proofPromise;
  }

  /**
   * Handle an inbound proof packet arriving on this link.
   *
   * Routes by context:
   *   - CONTEXT_RESOURCE_PRF → resource transfer proof (64 bytes:
   *     resource_hash + sha256(data + resource_hash))
   *   - default → packet proof for sendWithProof() (96 bytes:
   *     packet_hash + Ed25519_sign(packet_hash))
   *
   * @param {Packet} packet - Incoming PROOF packet with destHash == linkId
   */
  _handlePacketProof(packet) {
    // Resource proofs use the RESOURCE_PRF context and are 64 bytes (no
    // signature — verified by hash chain). Dispatch them to the resource
    // sender directly.
    if (packet.context === CONTEXT_RESOURCE_PRF) {
      this._handleResourceProof(packet.data);
      return;
    }

    if (!packet.data || packet.data.length < 96) {
      log(LOG_DEBUG, TAG, `Packet proof too short: ${packet.data?.length || 0}`);
      return;
    }

    const packetHash = packet.data.slice(0, 32);
    const signature = packet.data.slice(32, 96);
    const hashHex = toHex(packetHash);

    const pending = this._pendingProofs.get(hashHex);
    if (!pending) {
      // Not one we're waiting for — harmless, ignore.
      return;
    }

    // Verify signature using the destination identity's signing public key.
    // For the initiator, destination.identity is the remote peer we connected to.
    const sigPub = this.destination && this.destination.identity
      ? this.destination.identity.signingPublicKey
      : null;

    if (!sigPub) {
      log(LOG_WARNING, TAG, `Cannot verify packet proof: no destination signing key`);
      pending.reject(new Error('No signing key to verify proof'));
      return;
    }

    try {
      // ed25519Verify(signature, message, publicKey)
      const valid = ed25519Verify(signature, packetHash, sigPub);
      if (!valid) {
        log(LOG_WARNING, TAG, `Packet proof signature invalid for ${hashHex.slice(0, 16)}..`);
        pending.reject(new Error('Invalid packet proof signature'));
        return;
      }
      log(LOG_DEBUG, TAG, `Packet proof verified for ${hashHex.slice(0, 16)}..`);
      pending.resolve();
    } catch (err) {
      log(LOG_WARNING, TAG, `Packet proof verification error: ${err.message}`);
      pending.reject(err);
    }
  }

  /**
   * Send data as a Resource over this link, for messages too large to fit in
   * a single link packet. Mirrors Python's `RNS.Resource(data, link, ...)`
   * constructor flow.
   *
   * Internally creates a `ResourceSender`, registers it in
   * `_outgoingResources` so inbound RESOURCE_REQ / RESOURCE_PRF packets can
   * be routed to it, calls `advertise()` to start the transfer, and returns a
   * Promise that resolves with the byte count when the receiver sends a
   * verified proof, or rejects on link close / failure.
   *
   * @param {Uint8Array} data - The full payload to send
   * @param {object} [options]
   * @param {number} [options.timeoutMs=120000] - Max time to wait for proof
   * @param {function(number)} [options.onProgress] - Called with [0..1]
   * @returns {Promise<number>} Resolves with bytes sent on success
   */
  async sendResource(data, options = {}) {
    if (this.status !== LINK_ACTIVE) {
      throw new Error('Link is not active');
    }

    const sender = new ResourceSender(this, data);
    const hashHex = toHex(sender.hash);
    const timeoutMs = options.timeoutMs || 120_000;

    if (options.onProgress) sender.onProgress(options.onProgress);

    // Make sure we're listening for 'resource_req' / 'resource_proof' events
    // dispatched from Transport when the corresponding context arrives.
    if (!this._resourceListenersAttached) {
      this._resourceListenersAttached = true;
      this.on('resource_req', (plaintext) => this._handleResourceReq(plaintext));
      this.on('resource_proof', (proofData) => this._handleResourceProof(proofData));
    }

    const transferPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._outgoingResources.delete(hashHex);
        reject(new Error(`Resource transfer timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      sender.onComplete(() => {
        clearTimeout(timer);
        this._outgoingResources.delete(hashHex);
        resolve(data.length);
      });

      // Receiver rejection (RESOURCE_RCL) or local cancel wakes the promise
      // up immediately instead of waiting for the full timeout.
      sender.onFailed((err) => {
        clearTimeout(timer);
        this._outgoingResources.delete(hashHex);
        reject(err);
      });

      // Stash a rejector so _teardown / unrelated failures can wake us up
      this._outgoingResources.set(hashHex, {
        sender,
        reject: (err) => {
          clearTimeout(timer);
          this._outgoingResources.delete(hashHex);
          reject(err);
        },
      });
    });

    log(LOG_INFO, TAG, `Advertising outgoing resource ${hashHex.slice(0, 16)}.. (${data.length}b, ${sender.totalParts} parts)`);
    await sender.advertise();

    return transferPromise;
  }

  /**
   * Dispatch an inbound RESOURCE_REQ to the appropriate outgoing ResourceSender.
   * Called from Transport when CONTEXT_RESOURCE_REQ is decrypted on this link.
   * @param {Uint8Array} plaintext
   */
  _handleResourceReq(plaintext) {
    // Request format: flag(1) [+ last_map_hash(4)] + resource_hash(32) + requested_hashes(4*N)
    let offset = 1;
    if (plaintext[0] !== 0x00) offset += 4;
    if (plaintext.length < offset + 32) return;

    const resourceHash = plaintext.slice(offset, offset + 32);
    const hashHex = toHex(resourceHash);
    const entry = this._outgoingResources.get(hashHex);
    if (!entry) {
      log(LOG_DEBUG, TAG, `RESOURCE_REQ for unknown resource ${hashHex.slice(0, 16)}..`);
      return;
    }
    entry.sender.handleRequest(plaintext).catch((err) => {
      log(LOG_WARNING, TAG, `Resource request handling error: ${err.message}`);
    });
  }

  /**
   * Dispatch an inbound RESOURCE_PRF to the appropriate outgoing ResourceSender.
   * @param {Uint8Array} proofData - 64 bytes: resource_hash(32) + proof_hash(32)
   */
  _handleResourceProof(proofData) {
    if (proofData.length < 64) return;
    const resourceHash = proofData.slice(0, 32);
    const hashHex = toHex(resourceHash);
    const entry = this._outgoingResources.get(hashHex);
    if (!entry) {
      log(LOG_DEBUG, TAG, `RESOURCE_PRF for unknown resource ${hashHex.slice(0, 16)}..`);
      return;
    }
    const ok = entry.sender.handleProof(proofData);
    if (!ok) {
      log(LOG_WARNING, TAG, `Invalid resource proof for ${hashHex.slice(0, 16)}..`);
      entry.reject(new Error('Invalid resource proof'));
    }
  }

  /**
   * Send a proof for a received packet.
   * Matching Python Link.prove_packet():
   *   proof_data = packet_hash(32) + Ed25519_sign(packet_hash)(64)
   *   Sent as PROOF packet on the link.
   *
   * @param {import('./Packet.js').Packet} packet - The packet to prove
   */
  provePacket(packet) {
    if (!packet || !packet.packetHash) {
      log(LOG_WARNING, TAG, `Cannot prove packet: no packet hash`);
      return;
    }

    try {
      // Sign the packet hash with our signing key
      // Responder uses the destination identity's Ed25519 key
      // Initiator uses the ephemeral Ed25519 key
      const signingKey = this._sigPriv || (this._identity && this._identity.signingPrivateKey);
      if (!signingKey) {
        log(LOG_WARNING, TAG, `Cannot prove packet: no signing key`);
        return;
      }

      const signature = ed25519Sign(packet.packetHash, signingKey);
      const proofData = concat(packet.packetHash, signature);

      const pkt = new Packet();
      pkt.headerType = HEADER_1;
      pkt.packetType = PACKET_PROOF;
      pkt.destType = DEST_LINK;
      pkt.transportType = TRANSPORT_BROADCAST;
      pkt.destinationHash = this.linkId;
      pkt.context = CONTEXT_NONE;
      pkt.data = proofData;

      this._transport.transmit(pkt);
      log(LOG_INFO, TAG, `Sent packet proof for ${toHex(packet.packetHash).slice(0, 16)}..`);
    } catch (err) {
      log(LOG_WARNING, TAG, `Failed to prove packet: ${err.message}`);
    }
  }

  // --- Internal methods ---

  _sendLinkRequest() {
    const requestData = concat(this._encPub, this._sigPub);

    const pkt = new Packet();
    pkt.headerType = HEADER_1;
    pkt.packetType = PACKET_LINK_REQUEST;
    pkt.destType = DEST_SINGLE;
    pkt.transportType = TRANSPORT_BROADCAST;
    pkt.destinationHash = this.destination.hash;
    pkt.context = CONTEXT_NONE;
    pkt.data = requestData;

    // Compute link ID before sending
    pkt.pack();
    this.linkId = Link.linkIdFromPacket(pkt);

    this._transport.transmit(pkt);
    this.status = LINK_PENDING;

    log(LOG_INFO, TAG, `Sent link request to ${toHex(this.destination.hash).slice(0, 16)}.. (link_id: ${toHex(this.linkId).slice(0, 16)}..)`);
  }

  _sendProof(signalling) {
    const identity = this.destination.identity;

    // Sign: link_id + our_enc_pub + identity_sig_pub [+ signalling]
    const signedParts = [this.linkId, this._encPub, identity.signingPublicKey];
    if (signalling) signedParts.push(signalling);
    const signedData = concat(...signedParts);
    const signature = identity.sign(signedData);

    // Proof data: signature(64) + our_enc_pub(32) [+ signalling]
    const proofParts = [signature, this._encPub];
    if (signalling) proofParts.push(signalling);
    const proofData = concat(...proofParts);

    const pkt = new Packet();
    pkt.headerType = HEADER_1;
    pkt.packetType = PACKET_PROOF;
    pkt.destType = DEST_LINK;
    pkt.transportType = TRANSPORT_BROADCAST;
    pkt.destinationHash = this.linkId;
    pkt.context = CONTEXT_LRPROOF;
    pkt.data = proofData;

    this._transport.transmit(pkt);
    log(LOG_DEBUG, TAG, `Sent link proof for ${toHex(this.linkId).slice(0, 16)}..`);
  }

  async _sendRtt() {
    // Calculate RTT from link request to proof receipt
    this.rtt = this.establishedAt ? (Date.now() - this.establishedAt) / 1000 : 0;

    // Pack RTT as msgpack-encoded float (matching Python RNS/Link.py)
    const rttBytes = msgpackEncode(this.rtt);

    try {
      await this.send(new Uint8Array(rttBytes), CONTEXT_LRRTT);
      log(LOG_DEBUG, TAG, `Sent RTT packet: ${this.rtt}s`);
    } catch (err) {
      log(LOG_WARNING, TAG, `Failed to send RTT: ${err.message}`);
    }
  }

  _deriveSessionKeys() {
    // ECDH
    this._sharedKey = x25519SharedSecret(this._encPriv, this._peerEncPub);

    // HKDF: salt = link_id, info = empty, 64 bytes output
    this._derivedKey = hkdfDerive(
      this._sharedKey,
      IDENTITY_DERIVED_KEY_LENGTH, // 64 bytes
      this.linkId,                  // salt = link_id (16 bytes)
      new Uint8Array(0)             // info = empty
    );

    // Split into signing and encryption keys
    this._signingKey = this._derivedKey.slice(0, 32);
    this._encryptionKey = this._derivedKey.slice(32, 64);

    log(LOG_DEBUG, TAG, `Derived session keys for link ${toHex(this.linkId).slice(0, 16)}..`);
  }

  _teardown(reason) {
    this._stopWatchdog();
    this.status = LINK_CLOSED;

    // Reject any pending packet-proof waiters so callers unblock
    if (this._pendingProofs && this._pendingProofs.size > 0) {
      for (const pending of this._pendingProofs.values()) {
        try { pending.reject(new Error('Link closed before proof received')); } catch {}
      }
      this._pendingProofs.clear();
    }

    // Fail any pending request receipts
    if (this._pendingRequests && this._pendingRequests.size > 0) {
      for (const pending of this._pendingRequests.values()) {
        if (pending.receipt) pending.receipt._failed('Link closed');
      }
      this._pendingRequests.clear();
    }

    // Reject any in-flight outgoing resources
    if (this._outgoingResources && this._outgoingResources.size > 0) {
      for (const entry of this._outgoingResources.values()) {
        try { entry.reject(new Error('Link closed during resource transfer')); } catch {}
      }
      this._outgoingResources.clear();
    }

    // Zero out keys
    this._encPriv = null;
    this._encPub = null;
    this._sigPriv = null;
    this._sigPub = null;
    this._peerEncPub = null;
    this._sharedKey = null;
    this._derivedKey = null;
    this._signingKey = null;
    this._encryptionKey = null;

    const reasons = { [TIMEOUT]: 'timeout', [INITIATOR_CLOSED]: 'initiator_closed', [DESTINATION_CLOSED]: 'destination_closed' };
    log(LOG_INFO, TAG, `Link ${this.linkId ? toHex(this.linkId).slice(0, 16) + '..' : 'unknown'} closed: ${reasons[reason] || 'unknown'}`);

    this.emit('closed', reason);
  }
}

/**
 * Tracks the lifecycle of a request sent via `Link.request()`.
 *
 * Matches Python's `RequestReceipt` in RNS/Link.py:1349-1542. States:
 *   SENT      → request transmitted, awaiting delivery or response
 *   DELIVERED → (reserved for future packet-receipt integration)
 *   RECEIVING → (reserved for large-response progress tracking)
 *   READY     → response received, available via `getResponse()`
 *   FAILED    → timed out or link closed
 *
 * The receipt is a thenable (has `.then()` / `.catch()`), so callers can
 * `await link.request(path, data)` for backward compatibility. The promise
 * resolves with the response data or `null` on timeout/failure.
 */
export class RequestReceipt {
  /**
   * @param {Link} link
   * @param {Uint8Array} requestId - 16-byte request identifier
   * @param {number} sentAt - Unix timestamp (seconds)
   * @param {number} timeoutMs - Max wait time in milliseconds
   * @param {object} callbacks
   * @param {function} [callbacks.onResponse]
   * @param {function} [callbacks.onFailed]
   * @param {function} [callbacks.onProgress]
   */
  constructor(link, requestId, sentAt, timeoutMs, callbacks = {}) {
    this.link = link;
    this.requestId = requestId;
    this.hash = requestId;
    this.status = REQUEST_SENT;
    this.sentAt = sentAt;
    this.response = null;
    this.responseSize = 0;
    this.progress = 0;
    this.concludedAt = null;

    this._responseCallback = callbacks.onResponse || null;
    this._failedCallback = callbacks.onFailed || null;
    this._progressCallback = callbacks.onProgress || null;

    this._resolve = null;
    this._reject = null;
    this.promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });

    this._timer = setTimeout(() => this._timedOut(), timeoutMs);
    if (this._timer && typeof this._timer.unref === 'function') {
      this._timer.unref();
    }
  }

  then(onFulfilled, onRejected) { return this.promise.then(onFulfilled, onRejected); }
  catch(onRejected) { return this.promise.catch(onRejected); }

  /**
   * Called when the response data arrives from the remote peer.
   * Matches Python `RequestReceipt.response_received` in RNS/Link.py:1471.
   * @param {Uint8Array|null} data
   */
  _responseReceived(data) {
    if (this.status >= REQUEST_READY) return;
    clearTimeout(this._timer);
    this.response = data;
    this.responseSize = data ? data.length : 0;
    this.status = REQUEST_READY;
    this.progress = 1.0;
    this.concludedAt = Date.now() / 1000;
    if (this._progressCallback) try { this._progressCallback(this); } catch {}
    if (this._responseCallback) try { this._responseCallback(this); } catch {}
    if (this._resolve) this._resolve(data);
  }

  _timedOut() {
    if (this.status >= REQUEST_READY) return;
    this.status = REQUEST_FAILED;
    this.concludedAt = Date.now() / 1000;
    if (this._failedCallback) try { this._failedCallback(this); } catch {}
    if (this._resolve) this._resolve(null);
  }

  _failed(reason) {
    if (this.status >= REQUEST_READY) return;
    clearTimeout(this._timer);
    this.status = REQUEST_FAILED;
    this.concludedAt = Date.now() / 1000;
    if (this._failedCallback) try { this._failedCallback(this); } catch {}
    if (this._resolve) this._resolve(null);
  }

  getResponse() { return this.status === REQUEST_READY ? this.response : null; }
  getStatus() { return this.status; }

  onResponse(fn) { this._responseCallback = fn; return this; }
  onFailed(fn) { this._failedCallback = fn; return this; }
  onProgress(fn) { this._progressCallback = fn; return this; }
}
