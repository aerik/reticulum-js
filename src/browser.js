/**
 * Browser entry point — exports only browser-compatible modules.
 *
 * Excludes:
 * - TCPClientInterface, TCPServerInterface (require Node `net`)
 * - UDPInterface, AutoInterface (require Node `dgram`)
 * - NodeFileBackend (requires Node `fs`)
 * - Config file loading (requires Node `fs`)
 *
 * Includes:
 * - All crypto, protocol, and data transfer modules
 * - IndexedDBBackend and MemoryBackend for storage
 * - Storage class (with pluggable backend)
 */

// Core protocol
export { Identity } from './Identity.js';
export { Destination } from './Destination.js';
export { Packet } from './Packet.js';
export { Link } from './Link.js';
export { Channel } from './Channel.js';
export { ResourceSender, ResourceReceiver } from './Resource.js';
export { Transport } from './Transport.js';
export { createAnnounce, validateAnnounce } from './Announce.js';

// Storage (browser-compatible backends only)
export { Storage } from './utils/storage.js';
export { StorageBackend, IndexedDBBackend, MemoryBackend } from './utils/storage-backend.js';

// Utilities
export { EventEmitter } from './utils/events.js';
export * from './utils/bytes.js';
export * from './utils/crypto.js';
export { hdlcEncode, hdlcDecode, HdlcFrameBuffer } from './utils/hdlc.js';
export { kissEncode, KissFrameBuffer } from './utils/kiss.js';
export { computeIfac, ifacMask, ifacUnmask } from './utils/ifac.js';

// WebSocket client (browser-compatible — uses native WebSocket API)
export { WebSocketClientInterface } from './interfaces/WebSocketInterface.js';

// Constants
export {
  DEST_SINGLE, DEST_GROUP, DEST_PLAIN, DEST_LINK,
  DEST_IN, DEST_OUT,
  PACKET_DATA, PACKET_ANNOUNCE, PACKET_LINK_REQUEST, PACKET_PROOF,
  TRANSPORT_BROADCAST, TRANSPORT_TRANSPORT,
  HEADER_1, HEADER_2,
  MTU, MAX_HOPS,
} from './constants.js';
