import { describe, it, expect, beforeEach } from 'vitest';
import { Transport } from '../src/Transport.js';
import { Identity } from '../src/Identity.js';
import { Destination } from '../src/Destination.js';
import { Packet } from '../src/Packet.js';
import { createAnnounce } from '../src/Announce.js';
import { EventEmitter } from '../src/utils/events.js';
import { toHex, fromUtf8, randomBytes, equal } from '../src/utils/bytes.js';
import {
  DEST_SINGLE, DEST_PLAIN, DEST_IN,
  PACKET_DATA, PACKET_ANNOUNCE,
  TRANSPORT_BROADCAST, HEADER_1,
  CONTEXT_NONE,
} from '../src/constants.js';

// Mock interface
class MockInterface extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.online = true;
    this.sent = [];
  }
  send(data) {
    this.sent.push(data);
  }
}

describe('Transport', () => {
  let transport;
  let iface;

  beforeEach(() => {
    transport = new Transport();
    iface = new MockInterface('mock');
    transport.registerInterface(iface);
  });

  describe('interface registration', () => {
    it('registers interfaces', () => {
      expect(transport.interfaces).toHaveLength(1);
      expect(transport.interfaces[0]).toBe(iface);
    });
  });

  describe('destination registration', () => {
    it('registers local destinations', () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'app', 'svc');
      transport.registerDestination(dest);
      expect(transport.destinations.has(toHex(dest.hash))).toBe(true);
    });
  });

  describe('announce processing', () => {
    it('validates and caches a valid announce', () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'test', 'announce');
      const pkt = createAnnounce(dest);
      const raw = pkt.pack();

      // Simulate receiving the announce via the interface
      let announceEvent = null;
      transport.on('announce', (info) => { announceEvent = info; });

      iface.emit('packet', raw);

      expect(transport.stats.announcesReceived).toBe(1);
      expect(transport.stats.announcesValidated).toBe(1);
      expect(announceEvent).not.toBeNull();
      expect(equal(announceEvent.identity.publicKey, id.publicKey)).toBe(true);
      expect(announceEvent.hops).toBe(1); // incremented by inbound
    });

    it('caches identity in announceTable', () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'app');
      const pkt = createAnnounce(dest);

      iface.emit('packet', pkt.pack());

      const cached = transport.getIdentity(dest.hash);
      expect(cached).not.toBeNull();
      expect(equal(cached.publicKey, id.publicKey)).toBe(true);
    });

    it('updates path table on announce', () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'app');
      const pkt = createAnnounce(dest);

      iface.emit('packet', pkt.pack());

      const path = transport.pathTable.get(toHex(dest.hash));
      expect(path).toBeDefined();
      expect(path.hops).toBe(1);
      expect(path.interface).toBe(iface);
    });

    it('rejects invalid announces', () => {
      const pkt = new Packet();
      pkt.packetType = PACKET_ANNOUNCE;
      pkt.destType = DEST_SINGLE;
      pkt.destinationHash = randomBytes(16);
      pkt.data = randomBytes(200); // garbage data, won't validate
      const raw = pkt.pack();

      iface.emit('packet', raw);

      expect(transport.stats.announcesReceived).toBe(1);
      expect(transport.stats.announcesValidated).toBe(0);
    });
  });

  describe('data packet delivery', () => {
    it('delivers data to registered destination', () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'app');
      let received = null;
      dest.setPacketCallback((data, pkt) => { received = data; });
      transport.registerDestination(dest);

      // Build a data packet for this destination
      const pkt = new Packet();
      pkt.headerType = HEADER_1;
      pkt.packetType = PACKET_DATA;
      pkt.destType = DEST_SINGLE;
      pkt.transportType = TRANSPORT_BROADCAST;
      pkt.destinationHash = dest.hash;
      pkt.context = CONTEXT_NONE;
      pkt.data = fromUtf8('hello');
      const raw = pkt.pack();

      iface.emit('packet', raw);

      expect(received).not.toBeNull();
      expect(equal(received, fromUtf8('hello'))).toBe(true);
    });
  });

  describe('packet deduplication', () => {
    it('drops duplicate data packets', () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'app');
      let count = 0;
      dest.setPacketCallback(() => { count++; });
      transport.registerDestination(dest);

      const pkt = new Packet();
      pkt.packetType = PACKET_DATA;
      pkt.destType = DEST_SINGLE;
      pkt.destinationHash = dest.hash;
      pkt.data = fromUtf8('test');
      const raw = pkt.pack();

      // Send same packet twice
      iface.emit('packet', raw);
      iface.emit('packet', raw);

      expect(count).toBe(1);
      expect(transport.stats.duplicatesDropped).toBe(1);
    });

    it('does NOT dedup announces (they use random_blob)', () => {
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'app');

      // Two different announces for the same destination
      const pkt1 = createAnnounce(dest);
      const pkt2 = createAnnounce(dest);

      let announceCount = 0;
      transport.on('announce', () => { announceCount++; });

      iface.emit('packet', pkt1.pack());
      iface.emit('packet', pkt2.pack());

      // Both should be processed (different random blobs, different signatures)
      // But second may be dropped by path table logic (same hops)
      expect(transport.stats.announcesReceived).toBe(2);
    });
  });

  describe('transmit', () => {
    it('sends packet on all online interfaces', () => {
      const iface2 = new MockInterface('mock2');
      transport.registerInterface(iface2);

      const pkt = new Packet();
      pkt.packetType = PACKET_DATA;
      pkt.destType = DEST_SINGLE;
      pkt.destinationHash = randomBytes(16);
      pkt.data = fromUtf8('broadcast test');

      transport.transmit(pkt);

      expect(iface.sent).toHaveLength(1);
      expect(iface2.sent).toHaveLength(1);
    });

    it('excludes specified interface', () => {
      const iface2 = new MockInterface('mock2');
      transport.registerInterface(iface2);

      const pkt = new Packet();
      pkt.packetType = PACKET_DATA;
      pkt.destType = DEST_SINGLE;
      pkt.destinationHash = randomBytes(16);
      pkt.data = fromUtf8('test');

      transport.transmit(pkt, iface);

      expect(iface.sent).toHaveLength(0);
      expect(iface2.sent).toHaveLength(1);
    });
  });
});
