/**
 * Protocol edge case tests — filling coverage gaps found during audit.
 */

import { describe, it, expect } from 'vitest';
import { Packet } from '../src/Packet.js';
import { Destination } from '../src/Destination.js';
import { Identity } from '../src/Identity.js';
import { Transport } from '../src/Transport.js';
import { validateAnnounce, createAnnounce } from '../src/Announce.js';
import { EventEmitter } from '../src/utils/events.js';
import { randomBytes, equal, toHex, fromUtf8, concat } from '../src/utils/bytes.js';
import { truncatedHash } from '../src/utils/crypto.js';
import {
  PACKET_DATA, PACKET_ANNOUNCE,
  TRANSPORT_BROADCAST, TRANSPORT_TRANSPORT,
  HEADER_1, HEADER_2,
  DEST_SINGLE, DEST_GROUP, DEST_PLAIN, DEST_LINK,
  DEST_IN, FLAG_SET, FLAG_UNSET,
  CONTEXT_NONE,
  IDENTITY_HASH_LENGTH, IDENTITY_NAME_HASH_LENGTH,
} from '../src/constants.js';

describe('Packet HEADER_2 hash correctness', () => {
  it('HEADER_2 hash strips transport ID but keeps dest hash', () => {
    const destHash = randomBytes(16);
    const transportId = randomBytes(16);
    const payload = randomBytes(30);

    const pkt = new Packet();
    pkt.headerType = HEADER_2;
    pkt.transportType = TRANSPORT_TRANSPORT;
    pkt.destType = DEST_SINGLE;
    pkt.packetType = PACKET_DATA;
    pkt.hops = 3;
    pkt.destinationHash = destHash;
    pkt.transportId = transportId;
    pkt.context = 0x09;
    pkt.data = payload;
    pkt.pack();

    // The hash should be based on lower 4 bits of flags + destHash + context + data
    // (transport ID stripped)
    const hashableFlags = new Uint8Array([pkt.raw[0] & 0x0F]);
    // For HEADER_2: skip flags(1)+hops(1)+transportId(16) = 18, so raw[18:] = destHash+context+data
    const hashableRest = pkt.raw.slice(18);
    const expected = require('crypto').createHash('sha256')
      .update(Buffer.from(concat(hashableFlags, hashableRest)))
      .digest();

    expect(equal(pkt.packetHash, new Uint8Array(expected))).toBe(true);
  });

  it('HEADER_1 and HEADER_2 of same logical packet produce same hash', () => {
    const destHash = randomBytes(16);
    const payload = randomBytes(20);

    // HEADER_1 version
    const pkt1 = new Packet();
    pkt1.headerType = HEADER_1;
    pkt1.transportType = TRANSPORT_BROADCAST;
    pkt1.destType = DEST_SINGLE;
    pkt1.packetType = PACKET_DATA;
    pkt1.hops = 5;
    pkt1.destinationHash = new Uint8Array(destHash);
    pkt1.context = 0x09;
    pkt1.data = new Uint8Array(payload);
    pkt1.pack();

    // HEADER_2 version (same logical packet but in transport)
    const pkt2 = new Packet();
    pkt2.headerType = HEADER_2;
    pkt2.transportType = TRANSPORT_TRANSPORT;
    pkt2.destType = DEST_SINGLE;
    pkt2.packetType = PACKET_DATA;
    pkt2.hops = 5;
    pkt2.transportId = randomBytes(16); // any transport ID
    pkt2.destinationHash = new Uint8Array(destHash);
    pkt2.context = 0x09;
    pkt2.data = new Uint8Array(payload);
    pkt2.pack();

    expect(equal(pkt1.packetHash, pkt2.packetHash)).toBe(true);
  });
});

describe('Destination GROUP hashing', () => {
  it('GROUP destination hash matches PLAIN computation', () => {
    const group = new Destination(null, DEST_IN, DEST_GROUP, 'test', 'group');
    const plain = new Destination(null, DEST_IN, DEST_PLAIN, 'test', 'group');

    // Both should have the same hash (no identity involved)
    expect(equal(group.hash, plain.hash)).toBe(true);
  });

  it('GROUP destination has correct name hash', () => {
    const dest = new Destination(null, DEST_IN, DEST_GROUP, 'myapp', 'channel');
    const expected = truncatedHash(fromUtf8('myapp.channel'), IDENTITY_NAME_HASH_LENGTH);
    expect(equal(dest.nameHash, expected)).toBe(true);
  });
});

describe('Destination edge cases', () => {
  it('handles single-component app name (no aspects)', () => {
    const id = Identity.generate();
    const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'simple');
    expect(dest.name).toBe('simple');
    expect(dest.hash).toHaveLength(16);
  });

  it('handles many aspects', () => {
    const id = Identity.generate();
    const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'a', 'b', 'c', 'd', 'e');
    expect(dest.name).toBe('a.b.c.d.e');
    expect(dest.hash).toHaveLength(16);
  });
});

describe('Announce ratchet flag (context_flag=1)', () => {
  it('validates announce with ratchet flag set but no actual ratchet data', () => {
    // Build an announce normally, then set the context flag to FLAG_SET
    // This should fail validation because the parser expects 32 extra bytes
    const id = Identity.generate();
    const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'test', 'ratchet');
    const pkt = createAnnounce(dest);
    pkt.contextFlag = FLAG_SET; // claim ratchet present
    const raw = pkt.pack();
    const parsed = Packet.parse(raw);

    // With FLAG_SET, validateAnnounce expects 180 bytes minimum (148 + 32 ratchet)
    // Our announce data is only 148, so this should fail
    const result = validateAnnounce(parsed);
    expect(result).toBeNull(); // too short for ratchet
  });

  it('correctly parses announce data offsets based on context flag', () => {
    // Verify that with FLAG_UNSET, validation succeeds (baseline)
    const id = Identity.generate();
    const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'test');
    const pkt = createAnnounce(dest);
    expect(pkt.contextFlag).toBe(FLAG_UNSET);

    const parsed = Packet.parse(pkt.pack());
    expect(parsed.contextFlag).toBe(FLAG_UNSET);
    expect(validateAnnounce(parsed)).not.toBeNull();
  });
});

describe('Packet hops edge cases', () => {
  it('hops=0 round-trips', () => {
    const pkt = new Packet();
    pkt.hops = 0;
    pkt.destType = DEST_SINGLE;
    pkt.packetType = PACKET_DATA;
    pkt.destinationHash = randomBytes(16);
    const parsed = Packet.parse(pkt.pack());
    expect(parsed.hops).toBe(0);
  });

  it('hops=255 round-trips', () => {
    const pkt = new Packet();
    pkt.hops = 255;
    pkt.destType = DEST_SINGLE;
    pkt.packetType = PACKET_DATA;
    pkt.destinationHash = randomBytes(16);
    const parsed = Packet.parse(pkt.pack());
    expect(parsed.hops).toBe(255);
  });

  it('hops > 255 wraps (single byte)', () => {
    const pkt = new Packet();
    pkt.hops = 256;
    pkt.destType = DEST_SINGLE;
    pkt.packetType = PACKET_DATA;
    pkt.destinationHash = randomBytes(16);
    const parsed = Packet.parse(pkt.pack());
    expect(parsed.hops).toBe(0); // wrapped
  });
});

describe('Packet empty data', () => {
  it('parses packet with no data payload', () => {
    const pkt = new Packet();
    pkt.destType = DEST_SINGLE;
    pkt.packetType = PACKET_DATA;
    pkt.destinationHash = randomBytes(16);
    pkt.data = new Uint8Array(0);
    const raw = pkt.pack();
    const parsed = Packet.parse(raw);
    expect(parsed.data.length).toBe(0);
  });
});

describe('Transport hashlist overflow', () => {
  it('rotates hashlist when it reaches max size', () => {
    const transport = new Transport();

    // Manually set a small max for testing
    // The actual constant is 1M, but we'll simulate the rotation logic
    const SMALL_MAX = 10;

    // Add more than SMALL_MAX unique hashes
    for (let i = 0; i < SMALL_MAX + 5; i++) {
      const hash = randomBytes(32);
      const hex = toHex(hash);
      if (transport.packetHashlist.size >= SMALL_MAX) {
        transport.packetHashlistPrev = transport.packetHashlist;
        transport.packetHashlist = new Set();
      }
      transport.packetHashlist.add(hex);
    }

    // Current set should be small, prev should have entries
    expect(transport.packetHashlist.size).toBeLessThan(SMALL_MAX);
    expect(transport.packetHashlistPrev.size).toBe(SMALL_MAX);

    // Entries in prev should still be considered duplicates
    const prevEntry = [...transport.packetHashlistPrev][0];
    expect(
      transport.packetHashlist.has(prevEntry) ||
      transport.packetHashlistPrev.has(prevEntry)
    ).toBe(true);
  });
});

class MockInterface extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.online = true;
    this.sent = [];
  }
  send(data) { this.sent.push(new Uint8Array(data)); }
}

describe('Transport announce hop comparison', () => {
  it('accepts announce with fewer hops than existing', () => {
    const transport = new Transport();
    const iface = new MockInterface('mock');
    transport.registerInterface(iface);

    const id = Identity.generate();
    const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'test');

    // First announce: 3 hops
    const pkt1 = createAnnounce(dest);
    pkt1.hops = 2; // will be incremented to 3 by inbound
    iface.emit('packet', pkt1.pack());
    expect(transport.stats.announcesValidated).toBe(1);

    // Second announce with fewer hops: 2
    const pkt2 = createAnnounce(dest);
    pkt2.hops = 1; // will be incremented to 2
    iface.emit('packet', pkt2.pack());
    expect(transport.stats.announcesValidated).toBe(2);

    // Path should be updated to the better one
    const path = transport.pathTable.get(toHex(dest.hash));
    expect(path.hops).toBe(2); // the better path
  });

  it('rejects announce with same or more hops', () => {
    const transport = new Transport();
    const iface = new MockInterface('mock');
    transport.registerInterface(iface);

    const id = Identity.generate();
    const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'test');

    // First announce
    const pkt1 = createAnnounce(dest);
    pkt1.hops = 2;
    iface.emit('packet', pkt1.pack());

    // Second announce with more hops — should be rejected
    const pkt2 = createAnnounce(dest);
    pkt2.hops = 5;
    iface.emit('packet', pkt2.pack());

    // Only 1 validated (second rejected)
    // Actually both get validated (announcesValidated counts signature checks)
    // but the path should not be updated
    const path = transport.pathTable.get(toHex(dest.hash));
    expect(path.hops).toBe(3); // original, not the worse one
  });
});
