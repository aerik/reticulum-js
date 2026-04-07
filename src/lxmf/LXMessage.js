/**
 * LXMessage — LXMF message format.
 *
 * Matches the Python reference implementation (LXMF/LXMessage.py) wire format.
 *
 * Wire format (DIRECT / base):
 *   Offset  Length  Field
 *   0       16      destination_hash
 *   16      16      source_hash
 *   32      64      signature (Ed25519)
 *   96      var     msgpack([timestamp, title, content, fields, ?stamp])
 *
 * Hash computation (message_id):
 *   SHA256(destination_hash + source_hash + msgpack([timestamp, title, content, fields]))
 *   Note: stamp is EXCLUDED from hash computation.
 *
 * Signature:
 *   Ed25519_sign(source_private_key, hashed_part + message_hash)
 */

import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import { sha256Hash } from '../utils/crypto.js';
import { concat, toHex, equal } from '../utils/bytes.js';
import { log, LOG_DEBUG, LOG_INFO, LOG_WARNING } from '../utils/log.js';

const TAG = 'LXMessage';

// --- Constants (matching Python LXMF/LXMessage.py) ---

// Size constants
export const DESTINATION_LENGTH = 16;
export const SIGNATURE_LENGTH = 64;
export const LXMF_OVERHEAD = 2 * DESTINATION_LENGTH + SIGNATURE_LENGTH; // 96 bytes

// Message states
export const GENERATING = 0x00;
export const OUTBOUND   = 0x01;
export const SENDING    = 0x02;
export const SENT       = 0x04;
export const DELIVERED  = 0x08;
export const REJECTED   = 0xFD;
export const CANCELLED  = 0xFE;
export const FAILED     = 0xFF;

// Representations (how the message is carried)
export const UNKNOWN  = 0x00;
export const PACKET   = 0x01;
export const RESOURCE = 0x02;

// Delivery methods
export const OPPORTUNISTIC = 0x01;
export const DIRECT        = 0x02;
export const PROPAGATED    = 0x03;
export const PAPER         = 0x05;

// Signature verification failure reasons
export const SOURCE_UNKNOWN    = 0x01;
export const SIGNATURE_INVALID = 0x02;

// --- Field Constants (matching Python LXMF/LXMF.py) ---

export const APP_NAME = 'lxmf';

export const FIELD_EMBEDDED_LXMS    = 0x01;
export const FIELD_TELEMETRY        = 0x02;
export const FIELD_TELEMETRY_STREAM = 0x03;
export const FIELD_ICON_APPEARANCE  = 0x04;
export const FIELD_FILE_ATTACHMENTS = 0x05;
export const FIELD_IMAGE            = 0x06;
export const FIELD_AUDIO            = 0x07;
export const FIELD_THREAD           = 0x08;
export const FIELD_COMMANDS         = 0x09;
export const FIELD_RESULTS          = 0x0A;
export const FIELD_GROUP            = 0x0B;
export const FIELD_TICKET           = 0x0C;
export const FIELD_EVENT            = 0x0D;
export const FIELD_RNR_REFS         = 0x0E;
export const FIELD_RENDERER         = 0x0F;
export const FIELD_CUSTOM_TYPE      = 0xFB;
export const FIELD_CUSTOM_DATA      = 0xFC;
export const FIELD_CUSTOM_META      = 0xFD;
export const FIELD_NON_SPECIFIC     = 0xFE;
export const FIELD_DEBUG            = 0xFF;

// Renderer types
export const RENDERER_PLAIN    = 0x00;
export const RENDERER_MICRON   = 0x01;
export const RENDERER_MARKDOWN = 0x02;

export class LXMessage {
  /**
   * Create a new LXMessage.
   * @param {object} opts
   * @param {Uint8Array} [opts.destinationHash] - 16-byte destination hash
   * @param {Uint8Array} [opts.sourceHash] - 16-byte source hash
   * @param {string} [opts.title] - Message title
   * @param {string} [opts.content] - Message content
   * @param {object} [opts.fields] - Fields dict (integer keys)
   * @param {number} [opts.desiredMethod] - Delivery method
   * @param {number} [opts.timestamp] - Unix timestamp (auto-set if null)
   */
  constructor(opts = {}) {
    this.destinationHash = opts.destinationHash || null;
    this.sourceHash = opts.sourceHash || null;
    this.title = opts.title || '';
    this.content = opts.content || '';
    this.fields = opts.fields || {};
    this.timestamp = opts.timestamp || null;

    this.hash = null;           // 32 bytes — message ID
    this.messageId = null;      // alias for hash
    this.signature = null;      // 64 bytes Ed25519
    this.stamp = null;          // PoW stamp (optional)
    this.packed = null;         // complete wire-format bytes
    this.packedSize = 0;

    this.state = GENERATING;
    this.method = opts.desiredMethod || null;
    this.desiredMethod = opts.desiredMethod || null;
    this.representation = UNKNOWN;
    this.progress = 0;
    this.incoming = false;

    this.signatureValidated = false;
    this.unverifiedReason = null;

    // Propagation
    this.transientId = null;
    this.propagationPacked = null;
    this.propagationStamp = null;

    // Transport info
    this.transportEncrypted = false;
    this.transportEncryption = null;
  }

  /**
   * Get title as bytes (UTF-8 encoded).
   * @returns {Uint8Array}
   */
  get titleBytes() {
    return new TextEncoder().encode(this.title);
  }

  /**
   * Get content as bytes (UTF-8 encoded).
   * @returns {Uint8Array}
   */
  get contentBytes() {
    return new TextEncoder().encode(this.content);
  }

  /**
   * Pack the message into wire format.
   * Requires a source identity with private key for signing.
   *
   * Matching Python LXMessage.pack():
   *   1. Build payload = [timestamp, title_bytes, content_bytes, fields]
   *   2. Hash = SHA256(dest_hash + src_hash + msgpack(payload))
   *   3. Signature = sign(hash_input + hash)
   *   4. If stamp, append as payload[4]
   *   5. packed = dest_hash + src_hash + signature + msgpack(payload)
   *
   * @param {import('../Identity.js').Identity} sourceIdentity - Source identity (must have private key)
   * @returns {Uint8Array} packed message bytes
   */
  pack(sourceIdentity) {
    if (this.timestamp === null) {
      this.timestamp = Date.now() / 1000;
    }

    const titleBytes = this.titleBytes;
    const contentBytes = this.contentBytes;
    const payload = [this.timestamp, titleBytes, contentBytes, this.fields];

    // Hash computation (without stamp)
    const payloadPacked = new Uint8Array(msgpackEncode(payload));
    const hashedPart = concat(this.destinationHash, this.sourceHash, payloadPacked);
    this.hash = sha256Hash(hashedPart);
    this.messageId = this.hash;

    // Append stamp if present
    if (this.stamp) {
      payload.push(this.stamp);
    }

    // Signature: sign(hashed_part + hash)
    const signedPart = concat(hashedPart, this.hash);
    this.signature = sourceIdentity.sign(signedPart);
    this.signatureValidated = true;

    // Pack final payload (with stamp if present)
    const finalPayloadPacked = new Uint8Array(msgpackEncode(payload));

    // Wire format: dest_hash(16) + src_hash(16) + signature(64) + msgpack(payload)
    this.packed = concat(
      this.destinationHash,
      this.sourceHash,
      this.signature,
      finalPayloadPacked,
    );
    this.packedSize = this.packed.length;

    return this.packed;
  }

  /**
   * Pack for propagation (end-to-end encrypted wrapper).
   * Matching Python LXMessage.pack() PROPAGATED path.
   *
   * @param {import('../Identity.js').Identity} destinationIdentity - Destination's identity (for encryption)
   * @returns {Uint8Array} propagation_packed bytes: msgpack([timestamp, [lxmf_data]])
   */
  packForPropagation(destinationIdentity) {
    if (!this.packed) throw new Error('Message must be packed first');

    // Encrypt everything after destination_hash with destination's public key
    const toEncrypt = this.packed.slice(DESTINATION_LENGTH);
    const encrypted = destinationIdentity.encrypt(toEncrypt);

    // lxmf_data = destination_hash + encrypted_blob
    let lxmfData = concat(this.packed.slice(0, DESTINATION_LENGTH), encrypted);

    // Transient ID = SHA256(lxmf_data) — before propagation stamp is appended
    this.transientId = sha256Hash(lxmfData);

    // Append propagation stamp if present
    if (this.propagationStamp) {
      lxmfData = concat(lxmfData, this.propagationStamp);
    }

    // Propagation wire format: msgpack([timestamp, [lxmf_data]])
    this.propagationPacked = new Uint8Array(msgpackEncode([Date.now() / 1000, [lxmfData]]));
    return this.propagationPacked;
  }

  /**
   * Unpack a message from raw bytes.
   * Matching Python LXMessage.unpack_from_bytes().
   *
   * @param {Uint8Array} lxmfBytes - Raw LXMF message bytes
   * @param {function} [identityLookup] - Function(hash) → Identity, for signature verification
   * @param {number} [originalMethod] - Delivery method hint
   * @returns {LXMessage}
   */
  static unpackFromBytes(lxmfBytes, identityLookup = null, originalMethod = null) {
    if (lxmfBytes.length < LXMF_OVERHEAD) {
      throw new Error(`LXMF message too short: ${lxmfBytes.length} < ${LXMF_OVERHEAD}`);
    }

    const destinationHash = lxmfBytes.slice(0, DESTINATION_LENGTH);
    const sourceHash = lxmfBytes.slice(DESTINATION_LENGTH, 2 * DESTINATION_LENGTH);
    const signature = lxmfBytes.slice(2 * DESTINATION_LENGTH, 2 * DESTINATION_LENGTH + SIGNATURE_LENGTH);
    const packedPayload = lxmfBytes.slice(2 * DESTINATION_LENGTH + SIGNATURE_LENGTH);

    let unpackedPayload = msgpackDecode(packedPayload);

    // Extract stamp if present (5th element)
    let stamp = null;
    if (unpackedPayload.length > 4) {
      stamp = unpackedPayload[4];
      unpackedPayload = unpackedPayload.slice(0, 4);
    }

    // Re-pack payload without stamp for hash verification
    const stamplessPayloadPacked = new Uint8Array(msgpackEncode(unpackedPayload));

    // Verify hash
    const hashedPart = concat(destinationHash, sourceHash, stamplessPayloadPacked);
    const messageHash = sha256Hash(hashedPart);

    // Extract fields
    const timestamp = unpackedPayload[0];
    const titleBytes = unpackedPayload[1];
    const contentBytes = unpackedPayload[2];
    const fields = unpackedPayload[3];

    const message = new LXMessage({
      destinationHash,
      sourceHash,
      fields: fields || {},
      desiredMethod: originalMethod,
      timestamp,
    });

    message.hash = messageHash;
    message.messageId = messageHash;
    message.signature = signature;
    message.stamp = stamp;
    message.incoming = true;
    message.packed = lxmfBytes;
    message.packedSize = lxmfBytes.length;

    // Decode title and content from bytes
    if (titleBytes instanceof Uint8Array || titleBytes instanceof Buffer) {
      message.title = new TextDecoder().decode(titleBytes);
    } else if (typeof titleBytes === 'string') {
      message.title = titleBytes;
    }

    if (contentBytes instanceof Uint8Array || contentBytes instanceof Buffer) {
      message.content = new TextDecoder().decode(contentBytes);
    } else if (typeof contentBytes === 'string') {
      message.content = contentBytes;
    }

    // Verify signature if we can look up the source identity
    if (identityLookup) {
      const sourceIdentity = identityLookup(sourceHash);
      if (sourceIdentity) {
        const signedPart = concat(hashedPart, messageHash);
        if (sourceIdentity.verify(signedPart, signature)) {
          message.signatureValidated = true;
        } else {
          message.signatureValidated = false;
          message.unverifiedReason = SIGNATURE_INVALID;
        }
      } else {
        message.signatureValidated = false;
        message.unverifiedReason = SOURCE_UNKNOWN;
      }
    }

    return message;
  }

  /**
   * Get a hex representation of the message ID.
   * @returns {string}
   */
  get hexId() {
    return this.hash ? toHex(this.hash) : null;
  }

  /**
   * Summary string for logging.
   * @returns {string}
   */
  toString() {
    const id = this.hexId ? this.hexId.slice(0, 16) + '..' : 'unpacked';
    return `LXMessage<${id}>`;
  }
}
