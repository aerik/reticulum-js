import { describe, it, expect } from 'vitest';
import { Packet } from '../src/Packet.js';
import {
  PACKET_DATA, PACKET_ANNOUNCE, PACKET_LINK_REQUEST, PACKET_PROOF,
  TRANSPORT_BROADCAST, TRANSPORT_TRANSPORT,
  HEADER_1, HEADER_2,
  DEST_SINGLE, DEST_GROUP, DEST_PLAIN, DEST_LINK,
  FLAG_UNSET, FLAG_SET,
  CONTEXT_NONE,
} from '../src/constants.js';
import { equal, fromHex, toHex, randomBytes } from '../src/utils/bytes.js';

describe('Packet', () => {
  describe('flags byte bit layout', () => {
    it('encodes flags correctly: bit7=ifac, bit6=header, bit5=ctxflag, bit4=transport, bits3-2=destType, bits1-0=pktType', () => {
      const pkt = new Packet();
      pkt.ifacFlag = 0;
      pkt.headerType = HEADER_1;     // 0
      pkt.contextFlag = FLAG_UNSET;  // 0
      pkt.transportType = TRANSPORT_BROADCAST; // 0
      pkt.destType = DEST_SINGLE;    // 0
      pkt.packetType = PACKET_DATA;  // 0
      pkt.destinationHash = randomBytes(16);
      const raw = pkt.pack();
      expect(raw[0]).toBe(0x00);
    });

    it('sets header type in bit 6', () => {
      const pkt = new Packet();
      pkt.headerType = HEADER_2;
      pkt.destType = DEST_SINGLE;
      pkt.packetType = PACKET_DATA;
      pkt.destinationHash = randomBytes(16);
      pkt.transportId = randomBytes(16);
      const raw = pkt.pack();
      expect(raw[0] & 0x40).toBe(0x40);
    });

    it('sets context flag in bit 5', () => {
      const pkt = new Packet();
      pkt.contextFlag = FLAG_SET;
      pkt.destType = DEST_SINGLE;
      pkt.packetType = PACKET_ANNOUNCE;
      pkt.destinationHash = randomBytes(16);
      const raw = pkt.pack();
      expect(raw[0] & 0x20).toBe(0x20);
    });

    it('sets transport type in bit 4', () => {
      const pkt = new Packet();
      pkt.transportType = TRANSPORT_TRANSPORT;
      pkt.destType = DEST_SINGLE;
      pkt.packetType = PACKET_DATA;
      pkt.destinationHash = randomBytes(16);
      const raw = pkt.pack();
      expect(raw[0] & 0x10).toBe(0x10);
    });

    it('sets dest type in bits 3-2', () => {
      for (const [type, expected] of [
        [DEST_SINGLE, 0x00],
        [DEST_GROUP, 0x04],
        [DEST_PLAIN, 0x08],
        [DEST_LINK, 0x0C],
      ]) {
        const pkt = new Packet();
        pkt.destType = type;
        pkt.packetType = PACKET_DATA;
        pkt.destinationHash = randomBytes(16);
        const raw = pkt.pack();
        expect(raw[0] & 0x0C).toBe(expected);
      }
    });

    it('sets packet type in bits 1-0', () => {
      for (const [type, expected] of [
        [PACKET_DATA, 0x00],
        [PACKET_ANNOUNCE, 0x01],
        [PACKET_LINK_REQUEST, 0x02],
        [PACKET_PROOF, 0x03],
      ]) {
        const pkt = new Packet();
        pkt.destType = DEST_SINGLE;
        pkt.packetType = type;
        pkt.destinationHash = randomBytes(16);
        const raw = pkt.pack();
        expect(raw[0] & 0x03).toBe(expected);
      }
    });

    it('encodes a complex flags byte correctly', () => {
      // HEADER_2, TRANSPORT, GROUP dest, ANNOUNCE = 0b0_1_0_1_01_01 = 0x55
      const pkt = new Packet();
      pkt.ifacFlag = 0;
      pkt.headerType = HEADER_2;              // bit 6 = 1
      pkt.contextFlag = FLAG_UNSET;           // bit 5 = 0
      pkt.transportType = TRANSPORT_TRANSPORT; // bit 4 = 1
      pkt.destType = DEST_GROUP;              // bits 3-2 = 01
      pkt.packetType = PACKET_ANNOUNCE;       // bits 1-0 = 01
      pkt.destinationHash = randomBytes(16);
      pkt.transportId = randomBytes(16);
      const raw = pkt.pack();
      expect(raw[0]).toBe(0x55);
    });
  });

  describe('pack/parse round-trip', () => {
    it('round-trips a basic DATA packet', () => {
      const pkt = new Packet();
      pkt.headerType = HEADER_1;
      pkt.packetType = PACKET_DATA;
      pkt.destType = DEST_SINGLE;
      pkt.transportType = TRANSPORT_BROADCAST;
      pkt.hops = 0;
      pkt.destinationHash = randomBytes(16);
      pkt.context = CONTEXT_NONE;
      pkt.data = new Uint8Array([0x01, 0x02, 0x03]);

      const raw = pkt.pack();
      const parsed = Packet.parse(raw);

      expect(parsed.headerType).toBe(HEADER_1);
      expect(parsed.packetType).toBe(PACKET_DATA);
      expect(parsed.destType).toBe(DEST_SINGLE);
      expect(parsed.transportType).toBe(TRANSPORT_BROADCAST);
      expect(parsed.hops).toBe(0);
      expect(equal(parsed.destinationHash, pkt.destinationHash)).toBe(true);
      expect(parsed.context).toBe(CONTEXT_NONE);
      expect(equal(parsed.data, pkt.data)).toBe(true);
    });

    it('round-trips an ANNOUNCE packet with context flag', () => {
      const pkt = new Packet();
      pkt.headerType = HEADER_1;
      pkt.packetType = PACKET_ANNOUNCE;
      pkt.destType = DEST_SINGLE;
      pkt.contextFlag = FLAG_SET; // ratchet present
      pkt.transportType = TRANSPORT_BROADCAST;
      pkt.hops = 5;
      pkt.destinationHash = randomBytes(16);
      pkt.context = 0x00;
      pkt.data = randomBytes(180); // announce with ratchet

      const raw = pkt.pack();
      const parsed = Packet.parse(raw);

      expect(parsed.packetType).toBe(PACKET_ANNOUNCE);
      expect(parsed.contextFlag).toBe(FLAG_SET);
      expect(parsed.hops).toBe(5);
      expect(equal(parsed.data, pkt.data)).toBe(true);
    });

    it('round-trips a header type 2 packet with transport ID', () => {
      const pkt = new Packet();
      pkt.headerType = HEADER_2;
      pkt.packetType = PACKET_DATA;
      pkt.destType = DEST_SINGLE;
      pkt.transportType = TRANSPORT_TRANSPORT;
      pkt.hops = 3;
      pkt.destinationHash = randomBytes(16);
      pkt.transportId = randomBytes(16);
      pkt.context = 0x09;
      pkt.data = randomBytes(50);

      const raw = pkt.pack();
      const parsed = Packet.parse(raw);

      expect(parsed.headerType).toBe(HEADER_2);
      expect(parsed.transportType).toBe(TRANSPORT_TRANSPORT);
      expect(equal(parsed.transportId, pkt.transportId)).toBe(true);
      expect(equal(parsed.destinationHash, pkt.destinationHash)).toBe(true);
      expect(parsed.context).toBe(0x09);
    });

    it('HEADER_2 has transportId before destinationHash in wire format', () => {
      const pkt = new Packet();
      pkt.headerType = HEADER_2;
      pkt.transportType = TRANSPORT_TRANSPORT;
      pkt.destType = DEST_SINGLE;
      pkt.packetType = PACKET_DATA;
      pkt.hops = 0;
      pkt.transportId = fromHex('aa'.repeat(16));
      pkt.destinationHash = fromHex('bb'.repeat(16));
      pkt.context = 0x00;
      pkt.data = new Uint8Array(0);

      const raw = pkt.pack();
      // Bytes 2-17 should be transportId (0xaa...)
      expect(toHex(raw.slice(2, 18))).toBe('aa'.repeat(16));
      // Bytes 18-33 should be destinationHash (0xbb...)
      expect(toHex(raw.slice(18, 34))).toBe('bb'.repeat(16));
    });
  });

  describe('parse edge cases', () => {
    it('throws on packet too short', () => {
      expect(() => Packet.parse(new Uint8Array(5))).toThrow(/too short/);
    });

    it('throws on header type 2 with missing bytes', () => {
      const raw = new Uint8Array(20);
      raw[0] = (1 << 6); // header type 2
      expect(() => Packet.parse(raw)).toThrow(/too short/);
    });
  });

  describe('packet hash', () => {
    it('computes a 32-byte hash', () => {
      const pkt = new Packet();
      pkt.destType = DEST_SINGLE;
      pkt.packetType = PACKET_DATA;
      pkt.destinationHash = randomBytes(16);
      pkt.data = randomBytes(10);
      pkt.pack();

      expect(pkt.packetHash).toHaveLength(32);
    });

    it('same logical packet has same hash regardless of transport wrapping', () => {
      // Build a HEADER_1 broadcast packet
      const pkt1 = new Packet();
      pkt1.headerType = HEADER_1;
      pkt1.transportType = TRANSPORT_BROADCAST;
      pkt1.destType = DEST_SINGLE;
      pkt1.packetType = PACKET_DATA;
      pkt1.hops = 2;
      pkt1.destinationHash = randomBytes(16);
      pkt1.context = 0x09;
      pkt1.data = randomBytes(20);
      pkt1.pack();

      // Build the same packet as HEADER_2 in transport
      const pkt2 = new Packet();
      pkt2.headerType = HEADER_2;
      pkt2.transportType = TRANSPORT_TRANSPORT;
      pkt2.destType = DEST_SINGLE;
      pkt2.packetType = PACKET_DATA;
      pkt2.hops = 2;
      pkt2.transportId = randomBytes(16); // different transport ID
      pkt2.destinationHash = new Uint8Array(pkt1.destinationHash);
      pkt2.context = 0x09;
      pkt2.data = new Uint8Array(pkt1.data);
      pkt2.pack();

      // Hash should be identical because it strips transport-specific bits
      expect(equal(pkt1.packetHash, pkt2.packetHash)).toBe(true);
    });
  });

  describe('hop count', () => {
    it('preserves hop count through 128', () => {
      const pkt = new Packet();
      pkt.hops = 128;
      pkt.destType = DEST_SINGLE;
      pkt.packetType = PACKET_DATA;
      pkt.destinationHash = randomBytes(16);
      const raw = pkt.pack();
      const parsed = Packet.parse(raw);
      expect(parsed.hops).toBe(128);
    });
  });

  describe('toString', () => {
    it('returns a readable summary', () => {
      const pkt = new Packet();
      pkt.packetType = PACKET_ANNOUNCE;
      pkt.destType = DEST_SINGLE;
      pkt.destinationHash = randomBytes(16);
      pkt.data = randomBytes(20);
      const str = pkt.toString();
      expect(str).toContain('ANNOUNCE');
      expect(str).toContain('SINGLE');
      expect(str).toContain('20b payload');
    });
  });
});
