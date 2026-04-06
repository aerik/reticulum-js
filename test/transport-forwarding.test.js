import { describe, it, expect } from 'vitest';
import { Transport } from '../src/Transport.js';
import { Packet } from '../src/Packet.js';
import { Identity } from '../src/Identity.js';
import { Destination } from '../src/Destination.js';
import { createAnnounce } from '../src/Announce.js';
import { EventEmitter } from '../src/utils/events.js';
import { randomBytes, toHex, equal, fromUtf8 } from '../src/utils/bytes.js';
import {
  DEST_SINGLE, DEST_IN,
  PACKET_DATA, PACKET_ANNOUNCE,
  TRANSPORT_BROADCAST, TRANSPORT_TRANSPORT,
  HEADER_1, HEADER_2,
  CONTEXT_NONE,
  MAX_HOPS, PATHFINDER_E,
} from '../src/constants.js';

class MockInterface extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.online = true;
    this.sent = [];
    this.ifacConfig = null;
  }
  send(data) { this.sent.push(new Uint8Array(data)); }
}

describe('Transport forwarding', () => {
  it('forwards a packet via path table', () => {
    const transport = new Transport({ enableTransport: true });
    const inIface = new MockInterface('in');
    const outIface = new MockInterface('out');
    transport.registerInterface(inIface);
    transport.registerInterface(outIface);

    // Manually seed the path table
    const destHash = randomBytes(16);
    const destHex = toHex(destHash);
    transport.pathTable.set(destHex, {
      timestamp: Date.now() / 1000,
      nextHop: randomBytes(16),
      hops: 3,
      expires: Date.now() / 1000 + PATHFINDER_E,
      interface: outIface,
      announcePacketHash: null,
    });

    // Build a HEADER_2 packet addressed to us (as transport node)
    const pkt = new Packet();
    pkt.headerType = HEADER_2;
    pkt.transportType = TRANSPORT_TRANSPORT;
    pkt.destType = DEST_SINGLE;
    pkt.packetType = PACKET_DATA;
    pkt.hops = 2;
    pkt.transportId = randomBytes(16); // our transport ID (pretend it matches)
    pkt.destinationHash = destHash;
    pkt.context = CONTEXT_NONE;
    pkt.data = fromUtf8('forwarded payload');

    // Feed it in — but since the transport ID doesn't match "our" ID,
    // normal inbound won't route it via _forwardPacket.
    // Instead, let's directly call _forwardPacket to test the forwarding logic.
    pkt.pack();
    pkt.receivingInterface = inIface;
    pkt.hops = 3;
    pkt.packetHash = randomBytes(32);

    transport._forwardPacket(pkt);

    // outIface should have received the forwarded packet
    expect(outIface.sent).toHaveLength(1);
    expect(transport.stats.packetsForwarded).toBe(1);
  });

  it('converts to HEADER_1 BROADCAST on final hop', () => {
    const transport = new Transport({ enableTransport: true });
    const outIface = new MockInterface('out');
    transport.registerInterface(outIface);

    const destHash = randomBytes(16);
    transport.pathTable.set(toHex(destHash), {
      timestamp: Date.now() / 1000,
      nextHop: destHash,
      hops: 1, // direct, 1 hop
      expires: Date.now() / 1000 + PATHFINDER_E,
      interface: outIface,
      announcePacketHash: null,
    });

    const pkt = new Packet();
    pkt.packetType = PACKET_DATA;
    pkt.destType = DEST_SINGLE;
    pkt.destinationHash = destHash;
    pkt.data = fromUtf8('final hop');
    pkt.pack();
    pkt.receivingInterface = new MockInterface('in');
    pkt.hops = MAX_HOPS - 1; // 1 remaining
    pkt.packetHash = randomBytes(32);

    transport._forwardPacket(pkt);

    expect(outIface.sent).toHaveLength(1);

    // Parse the forwarded packet — should be HEADER_1 BROADCAST
    const forwarded = Packet.parse(outIface.sent[0]);
    expect(forwarded.headerType).toBe(HEADER_1);
    expect(forwarded.transportType).toBe(TRANSPORT_BROADCAST);
  });

  it('wraps in HEADER_2 for multi-hop forwarding', () => {
    const transport = new Transport({ enableTransport: true });
    const outIface = new MockInterface('out');
    transport.registerInterface(outIface);

    const destHash = randomBytes(16);
    const nextHop = randomBytes(16);
    transport.pathTable.set(toHex(destHash), {
      timestamp: Date.now() / 1000,
      nextHop,
      hops: 5,
      expires: Date.now() / 1000 + PATHFINDER_E,
      interface: outIface,
      announcePacketHash: null,
    });

    const pkt = new Packet();
    pkt.packetType = PACKET_DATA;
    pkt.destType = DEST_SINGLE;
    pkt.destinationHash = destHash;
    pkt.data = fromUtf8('multi-hop');
    pkt.pack();
    pkt.receivingInterface = new MockInterface('in');
    pkt.hops = 3; // plenty remaining
    pkt.packetHash = randomBytes(32);

    transport._forwardPacket(pkt);

    expect(outIface.sent).toHaveLength(1);

    const forwarded = Packet.parse(outIface.sent[0]);
    expect(forwarded.headerType).toBe(HEADER_2);
    expect(forwarded.transportType).toBe(TRANSPORT_TRANSPORT);
    expect(equal(forwarded.transportId, nextHop)).toBe(true);
    expect(equal(forwarded.destinationHash, destHash)).toBe(true);
  });

  it('creates reverse table entry for proof routing', () => {
    const transport = new Transport({ enableTransport: true });
    const inIface = new MockInterface('in');
    const outIface = new MockInterface('out');
    transport.registerInterface(inIface);
    transport.registerInterface(outIface);

    const destHash = randomBytes(16);
    transport.pathTable.set(toHex(destHash), {
      timestamp: Date.now() / 1000,
      nextHop: randomBytes(16),
      hops: 3,
      expires: Date.now() / 1000 + PATHFINDER_E,
      interface: outIface,
      announcePacketHash: null,
    });

    const pkt = new Packet();
    pkt.packetType = PACKET_DATA;
    pkt.destType = DEST_SINGLE;
    pkt.destinationHash = destHash;
    pkt.data = fromUtf8('test');
    pkt.pack();
    pkt.receivingInterface = inIface;
    pkt.hops = 2;
    pkt.packetHash = randomBytes(32);

    transport._forwardPacket(pkt);

    // Reverse table should have an entry
    expect(transport.reverseTable.size).toBe(1);
    const entry = [...transport.reverseTable.values()][0];
    expect(entry.receivedOn).toBe(inIface);
    expect(entry.forwardedOn).toBe(outIface);
  });

  it('drops packet when no path exists', () => {
    const transport = new Transport({ enableTransport: true });
    const iface = new MockInterface('out');
    transport.registerInterface(iface);

    const pkt = new Packet();
    pkt.packetType = PACKET_DATA;
    pkt.destType = DEST_SINGLE;
    pkt.destinationHash = randomBytes(16); // no path for this
    pkt.data = fromUtf8('lost');
    pkt.pack();
    pkt.receivingInterface = new MockInterface('in');
    pkt.hops = 2;
    pkt.packetHash = randomBytes(32);

    transport._forwardPacket(pkt);

    expect(iface.sent).toHaveLength(0);
    expect(transport.stats.packetsForwarded).toBe(0);
  });

  it('drops packet when path has expired', () => {
    const transport = new Transport({ enableTransport: true });
    const outIface = new MockInterface('out');
    transport.registerInterface(outIface);

    const destHash = randomBytes(16);
    transport.pathTable.set(toHex(destHash), {
      timestamp: Date.now() / 1000 - 1000,
      nextHop: randomBytes(16),
      hops: 2,
      expires: Date.now() / 1000 - 1, // expired
      interface: outIface,
      announcePacketHash: null,
    });

    const pkt = new Packet();
    pkt.packetType = PACKET_DATA;
    pkt.destType = DEST_SINGLE;
    pkt.destinationHash = destHash;
    pkt.data = fromUtf8('expired');
    pkt.pack();
    pkt.receivingInterface = new MockInterface('in');
    pkt.hops = 2;
    pkt.packetHash = randomBytes(32);

    transport._forwardPacket(pkt);

    expect(outIface.sent).toHaveLength(0);
    // Path should be removed
    expect(transport.pathTable.has(toHex(destHash))).toBe(false);
  });

  it('drops packet when max hops exceeded', () => {
    const transport = new Transport({ enableTransport: true });
    const outIface = new MockInterface('out');
    transport.registerInterface(outIface);

    const destHash = randomBytes(16);
    transport.pathTable.set(toHex(destHash), {
      timestamp: Date.now() / 1000,
      nextHop: randomBytes(16),
      hops: 2,
      expires: Date.now() / 1000 + PATHFINDER_E,
      interface: outIface,
      announcePacketHash: null,
    });

    const pkt = new Packet();
    pkt.packetType = PACKET_DATA;
    pkt.destType = DEST_SINGLE;
    pkt.destinationHash = destHash;
    pkt.data = fromUtf8('too many hops');
    pkt.pack();
    pkt.receivingInterface = new MockInterface('in');
    pkt.hops = MAX_HOPS; // no remaining hops
    pkt.packetHash = randomBytes(32);

    transport._forwardPacket(pkt);

    expect(outIface.sent).toHaveLength(0);
  });

  describe('end-to-end forwarding via inbound', () => {
    it('forwards data packets when transport enabled and destination known', () => {
      const transport = new Transport({ enableTransport: true });
      const inIface = new MockInterface('in');
      const outIface = new MockInterface('out');
      transport.registerInterface(inIface);
      transport.registerInterface(outIface);

      // Set up path
      const destHash = randomBytes(16);
      transport.pathTable.set(toHex(destHash), {
        timestamp: Date.now() / 1000,
        nextHop: randomBytes(16),
        hops: 3,
        expires: Date.now() / 1000 + PATHFINDER_E,
        interface: outIface,
        announcePacketHash: null,
      });

      // Build a HEADER_2 packet that arrives via inbound
      const pkt = new Packet();
      pkt.headerType = HEADER_2;
      pkt.transportType = TRANSPORT_TRANSPORT;
      pkt.destType = DEST_SINGLE;
      pkt.packetType = PACKET_DATA;
      pkt.hops = 1;
      pkt.transportId = randomBytes(16); // "our" transport ID
      pkt.destinationHash = destHash;
      pkt.context = CONTEXT_NONE;
      pkt.data = fromUtf8('hello routing');

      inIface.emit('packet', pkt.pack());

      // Should forward to outIface
      expect(outIface.sent.length).toBeGreaterThan(0);
      expect(transport.stats.packetsForwarded).toBeGreaterThan(0);
    });
  });
});
