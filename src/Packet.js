/**
 * Packet — the fundamental unit of transmission on the RNS network.
 *
 * Wire format (from RNS/Packet.py):
 *
 * Flags byte (byte 0):
 *   Bit 7:    IFAC flag
 *   Bit 6:    Header type (0=HEADER_1, 1=HEADER_2)
 *   Bit 5:    Context flag (ratchet flag for announces)
 *   Bit 4:    Transport type (0=BROADCAST, 1=TRANSPORT)
 *   Bits 3-2: Destination type (SINGLE/GROUP/PLAIN/LINK)
 *   Bits 1-0: Packet type (DATA/ANNOUNCE/LINKREQUEST/PROOF)
 *
 * Byte 1:     hop count
 *
 * HEADER_1: bytes 2-17 = destination hash (16 bytes)
 * HEADER_2: bytes 2-17 = transport ID, bytes 18-33 = destination hash
 *
 * Next byte:  context
 * Remaining:  payload
 */

import {
  PACKET_DATA, PACKET_ANNOUNCE, PACKET_LINK_REQUEST, PACKET_PROOF,
  TRANSPORT_BROADCAST, TRANSPORT_TRANSPORT,
  HEADER_1, HEADER_2,
  DEST_SINGLE, DEST_GROUP, DEST_PLAIN, DEST_LINK,
  ADDR_SIZE, HEADER1_SIZE, HEADER2_SIZE,
  MTU, MAX_HOPS,
  CONTEXT_NONE, FLAG_UNSET,
} from './constants.js';
import { concat, toHex } from './utils/bytes.js';
import { sha256Hash } from './utils/crypto.js';

export class Packet {
  constructor() {
    this.ifacFlag = 0;                        // bit 7
    this.headerType = HEADER_1;               // bit 6
    this.contextFlag = FLAG_UNSET;            // bit 5 (ratchet flag for announces)
    this.transportType = TRANSPORT_BROADCAST; // bit 4
    this.destType = DEST_SINGLE;              // bits 3-2
    this.packetType = PACKET_DATA;            // bits 1-0

    this.hops = 0;
    this.destinationHash = null;  // Uint8Array(16)
    this.transportId = null;      // Uint8Array(16) or null (header type 2 only)
    this.context = CONTEXT_NONE;
    this.data = new Uint8Array(0);
    this.raw = null;              // Full wire-format bytes after pack/parse
    this.packetHash = null;       // SHA-256 of hashable part (for dedup)
    this.receivingInterface = null;
  }

  /**
   * Parse a raw packet from wire format.
   * @param {Uint8Array} raw - Raw packet bytes
   * @returns {Packet}
   */
  static parse(raw) {
    if (raw.length < HEADER1_SIZE) {
      throw new Error(`Packet too short: ${raw.length} bytes (min ${HEADER1_SIZE})`);
    }

    const packet = new Packet();
    packet.raw = new Uint8Array(raw); // defensive copy

    // Byte 0: flags
    const flags = raw[0];
    packet.ifacFlag      = (flags >> 7) & 0x01;  // bit 7
    packet.headerType    = (flags >> 6) & 0x01;  // bit 6
    packet.contextFlag   = (flags >> 5) & 0x01;  // bit 5
    packet.transportType = (flags >> 4) & 0x01;  // bit 4
    packet.destType      = (flags >> 2) & 0x03;  // bits 3-2
    packet.packetType    = flags & 0x03;          // bits 1-0

    // Byte 1: hops
    packet.hops = raw[1];

    // Addresses — layout differs between HEADER_1 and HEADER_2
    let offset = 2;

    if (packet.headerType === HEADER_2) {
      if (raw.length < HEADER2_SIZE) {
        throw new Error(`Header type 2 packet too short: ${raw.length} bytes`);
      }
      // HEADER_2: transport ID first, then destination hash
      packet.transportId = raw.slice(offset, offset + ADDR_SIZE);
      offset += ADDR_SIZE;
      packet.destinationHash = raw.slice(offset, offset + ADDR_SIZE);
      offset += ADDR_SIZE;
    } else {
      // HEADER_1: just destination hash
      packet.destinationHash = raw.slice(offset, offset + ADDR_SIZE);
      offset += ADDR_SIZE;
    }

    // Context byte
    packet.context = raw[offset];
    offset += 1;

    // Remaining data
    packet.data = raw.slice(offset);

    // Compute packet hash (transport-independent)
    packet.packetHash = packet._computeHash();

    return packet;
  }

  /**
   * Serialize this packet to wire format.
   * @returns {Uint8Array}
   */
  pack() {
    // Byte 0: flags
    // bits: [ifac:1][header:1][ctxflag:1][transport:1][destType:2][pktType:2]
    const flags = (
      ((this.ifacFlag & 0x01) << 7) |
      ((this.headerType & 0x01) << 6) |
      ((this.contextFlag & 0x01) << 5) |
      ((this.transportType & 0x01) << 4) |
      ((this.destType & 0x03) << 2) |
      (this.packetType & 0x03)
    );

    const header = new Uint8Array(2);
    header[0] = flags;
    header[1] = this.hops & 0xFF;

    const parts = [header];

    if (this.headerType === HEADER_2 && this.transportId) {
      // HEADER_2: transport ID first, then destination hash
      parts.push(this.transportId);
    }

    parts.push(this.destinationHash);
    parts.push(new Uint8Array([this.context]));
    parts.push(this.data);

    this.raw = concat(...parts);
    this.packetHash = this._computeHash();
    return this.raw;
  }

  /**
   * Compute the transport-independent packet hash.
   * Used for duplicate detection. Strips header type, context flag,
   * and transport type from the flags, and removes transport ID if present.
   * @returns {Uint8Array} 32-byte SHA-256 hash
   */
  _computeHash() {
    if (!this.raw) return null;

    // Only the lower 4 bits of flags (destType + packetType) are hashable
    const hashableFlags = new Uint8Array([this.raw[0] & 0x0F]);

    let hashableRest;
    if (this.headerType === HEADER_2) {
      // Skip flags(1) + hops(1) + transportId(16), keep destHash + context + data
      hashableRest = this.raw.slice(ADDR_SIZE + 2);
    } else {
      // Skip flags(1) + hops(1), keep destHash + context + data
      hashableRest = this.raw.slice(2);
    }

    return sha256Hash(concat(hashableFlags, hashableRest));
  }

  /**
   * Human-readable summary for debugging.
   * @returns {string}
   */
  toString() {
    const pktNames = ['DATA', 'ANNOUNCE', 'LINK_REQ', 'PROOF'];
    const transportNames = ['BROADCAST', 'TRANSPORT', 'RELAY', 'TUNNEL'];
    const destNames = ['SINGLE', 'GROUP', 'PLAIN', 'LINK'];
    return `Packet(${pktNames[this.packetType]}, ` +
      `${destNames[this.destType]}, ` +
      `${transportNames[this.transportType]}, ` +
      `hops=${this.hops}, ` +
      `dest=${this.destinationHash ? toHex(this.destinationHash) : 'null'}, ` +
      `ctx=0x${this.context.toString(16).padStart(2, '0')}, ` +
      `${this.data.length}b payload)`;
  }
}
