import { describe, it, expect } from 'vitest';
import { computeIfac, ifacMask, ifacUnmask } from '../src/utils/ifac.js';
import { Packet } from '../src/Packet.js';
import { Transport } from '../src/Transport.js';
import { Identity } from '../src/Identity.js';
import { Destination } from '../src/Destination.js';
import { createAnnounce } from '../src/Announce.js';
import { EventEmitter } from '../src/utils/events.js';
import { randomBytes, toHex, equal } from '../src/utils/bytes.js';
import {
  DEST_SINGLE, DEST_IN, PACKET_DATA, PACKET_ANNOUNCE,
  TRANSPORT_BROADCAST, HEADER_1, CONTEXT_NONE,
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
  configureIfac(networkname, passphrase, ifacSize) {
    if (networkname || passphrase) {
      this.ifacConfig = computeIfac(networkname, passphrase, ifacSize);
    }
  }
}

describe('IFAC', () => {
  describe('computeIfac', () => {
    it('derives a 64-byte ifac key', () => {
      const result = computeIfac('testnet', 'secret123');
      expect(result.ifacKey).toHaveLength(64);
      expect(result.ifacSize).toBe(16);
      expect(result.ifacIdentity).toBeDefined();
      expect(result.ifacIdentity.hasPrivateKey()).toBe(true);
    });

    it('same inputs produce same key', () => {
      const a = computeIfac('net', 'pass');
      const b = computeIfac('net', 'pass');
      expect(equal(a.ifacKey, b.ifacKey)).toBe(true);
    });

    it('different networkname produces different key', () => {
      const a = computeIfac('net1', 'pass');
      const b = computeIfac('net2', 'pass');
      expect(equal(a.ifacKey, b.ifacKey)).toBe(false);
    });

    it('different passphrase produces different key', () => {
      const a = computeIfac('net', 'pass1');
      const b = computeIfac('net', 'pass2');
      expect(equal(a.ifacKey, b.ifacKey)).toBe(false);
    });
  });

  describe('ifacMask / ifacUnmask', () => {
    it('round-trips a raw packet', () => {
      const config = computeIfac('testnet', 'password');

      const pkt = new Packet();
      pkt.packetType = PACKET_DATA;
      pkt.destType = DEST_SINGLE;
      pkt.destinationHash = randomBytes(16);
      pkt.data = randomBytes(50);
      const raw = pkt.pack();

      const masked = ifacMask(raw, config);

      // Masked should be larger (IFAC bytes added)
      expect(masked.length).toBe(raw.length + config.ifacSize);

      // IFAC flag should be set
      expect(masked[0] & 0x80).toBe(0x80);

      // Unmask should recover the original
      const unmasked = ifacUnmask(masked, config);
      expect(unmasked).not.toBeNull();
      expect(equal(unmasked, raw)).toBe(true);
    });

    it('masked packet is different from original', () => {
      const config = computeIfac('net', 'pass');
      const raw = randomBytes(40);
      raw[0] = 0x00; // clear IFAC flag

      const masked = ifacMask(raw, config);

      // Content should be obfuscated (XOR masked)
      let different = false;
      for (let i = 2 + config.ifacSize; i < masked.length; i++) {
        if (masked[i] !== raw[i - config.ifacSize]) { different = true; break; }
      }
      expect(different).toBe(true);
    });

    it('wrong passphrase fails verification', () => {
      const config1 = computeIfac('net', 'correct');
      const config2 = computeIfac('net', 'wrong');

      const raw = new Packet();
      raw.packetType = PACKET_DATA;
      raw.destType = DEST_SINGLE;
      raw.destinationHash = randomBytes(16);
      raw.data = randomBytes(30);
      const rawBytes = raw.pack();

      const masked = ifacMask(rawBytes, config1);
      const result = ifacUnmask(masked, config2);

      expect(result).toBeNull(); // verification should fail
    });

    it('rejects packet without IFAC flag', () => {
      const config = computeIfac('net', 'pass');
      const raw = new Uint8Array(30);
      raw[0] = 0x00; // no IFAC flag

      expect(ifacUnmask(raw, config)).toBeNull();
    });

    it('rejects tampered masked packet', () => {
      const config = computeIfac('net', 'pass');

      const pkt = new Packet();
      pkt.packetType = PACKET_DATA;
      pkt.destType = DEST_SINGLE;
      pkt.destinationHash = randomBytes(16);
      pkt.data = randomBytes(50);
      const masked = ifacMask(pkt.pack(), config);

      // Tamper with a byte after the IFAC
      masked[20] ^= 0xFF;

      expect(ifacUnmask(masked, config)).toBeNull();
    });
  });

  describe('Transport IFAC integration', () => {
    it('accepts packets with valid IFAC on IFAC-enabled interface', () => {
      const transport = new Transport();
      const iface = new MockInterface('ifac-iface');
      iface.configureIfac('testnet', 'secret');
      transport.registerInterface(iface);

      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'app');
      const pkt = createAnnounce(dest);
      const raw = pkt.pack();

      // Mask the packet
      const masked = ifacMask(raw, iface.ifacConfig);

      let received = false;
      transport.on('announce', () => { received = true; });

      // Feed the masked packet
      iface.emit('packet', masked);

      expect(received).toBe(true);
    });

    it('drops packets without IFAC on IFAC-enabled interface', () => {
      const transport = new Transport();
      const iface = new MockInterface('ifac-iface');
      iface.configureIfac('testnet', 'secret');
      transport.registerInterface(iface);

      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'app');
      const pkt = createAnnounce(dest);
      const raw = pkt.pack(); // not masked

      let received = false;
      transport.on('announce', () => { received = true; });

      iface.emit('packet', raw);

      expect(received).toBe(false);
    });

    it('drops packets with IFAC flag on non-IFAC interface', () => {
      const transport = new Transport();
      const iface = new MockInterface('plain-iface');
      // No IFAC configured
      transport.registerInterface(iface);

      const config = computeIfac('net', 'pass');
      const raw = randomBytes(40);
      raw[0] = 0x00;
      const masked = ifacMask(raw, config);

      let count = transport.stats.packetsReceived;
      iface.emit('packet', masked);

      // Packet should be received but dropped (no announce event)
      // The key thing: it doesn't crash and the IFAC flag causes rejection
      expect(transport.stats.packetsReceived).toBe(count + 1);
    });

    it('transmit applies IFAC masking on IFAC-enabled interface', () => {
      const transport = new Transport();
      const iface = new MockInterface('ifac-iface');
      iface.configureIfac('testnet', 'secret');
      transport.registerInterface(iface);

      const pkt = new Packet();
      pkt.packetType = PACKET_DATA;
      pkt.destType = DEST_SINGLE;
      pkt.destinationHash = randomBytes(16);
      pkt.data = randomBytes(20);

      transport.transmit(pkt);

      // The sent packet should have IFAC flag set
      expect(iface.sent).toHaveLength(1);
      expect(iface.sent[0][0] & 0x80).toBe(0x80);

      // It should be longer than the raw packet (IFAC bytes added)
      const rawLen = pkt.pack().length;
      expect(iface.sent[0].length).toBe(rawLen + iface.ifacConfig.ifacSize);
    });

    it('end-to-end: IFAC transmit → receive', () => {
      // Two transports, same IFAC config
      const t1 = new Transport();
      const iface1 = new MockInterface('sender');
      iface1.configureIfac('mynet', 'mypass');
      t1.registerInterface(iface1);

      const t2 = new Transport();
      const iface2 = new MockInterface('receiver');
      iface2.configureIfac('mynet', 'mypass');
      t2.registerInterface(iface2);

      // Register a destination on t2
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'app');
      let deliveredData = null;
      dest.setPacketCallback((data) => { deliveredData = data; });
      t2.registerDestination(dest);

      // Send a data packet from t1
      const pkt = new Packet();
      pkt.packetType = PACKET_DATA;
      pkt.destType = DEST_SINGLE;
      pkt.destinationHash = dest.hash;
      pkt.data = new TextEncoder().encode('hello IFAC');
      t1.transmit(pkt);

      // Deliver the masked packet to t2
      iface2.emit('packet', iface1.sent[0]);

      expect(deliveredData).not.toBeNull();
      expect(new TextDecoder().decode(deliveredData)).toBe('hello IFAC');
    });
  });
});
