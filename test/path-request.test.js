import { describe, it, expect } from 'vitest';
import { Transport } from '../src/Transport.js';
import { Identity } from '../src/Identity.js';
import { Destination } from '../src/Destination.js';
import { Packet } from '../src/Packet.js';
import { createAnnounce } from '../src/Announce.js';
import { EventEmitter } from '../src/utils/events.js';
import { randomBytes, toHex, equal, fromUtf8, concat } from '../src/utils/bytes.js';
import { truncatedHash } from '../src/utils/crypto.js';
import {
  DEST_SINGLE, DEST_PLAIN, DEST_IN,
  PACKET_DATA, TRANSPORT_BROADCAST, HEADER_1,
  CONTEXT_NONE, PATHFINDER_E,
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

describe('Path requests', () => {
  it('requestPath resolves immediately if path exists', async () => {
    const transport = new Transport();
    const iface = new MockInterface('mock');
    transport.registerInterface(iface);

    const destHash = randomBytes(16);
    transport.pathTable.set(toHex(destHash), {
      timestamp: Date.now() / 1000,
      nextHop: randomBytes(16),
      hops: 2,
      expires: Date.now() / 1000 + PATHFINDER_E,
      interface: iface,
      announcePacketHash: null,
    });

    const result = await transport.requestPath(destHash);
    expect(result).toBe(true);
  });

  it('requestPath sends a packet to the path request destination', async () => {
    const transport = new Transport();
    const iface = new MockInterface('mock');
    transport.registerInterface(iface);

    const destHash = randomBytes(16);

    // Start request with short timeout (won't resolve — no one to answer)
    const promise = transport.requestPath(destHash, null, 200);

    // Should have sent a packet
    expect(iface.sent.length).toBeGreaterThan(0);

    // Parse the sent packet
    const pkt = Packet.parse(iface.sent[0]);
    expect(pkt.destType).toBe(DEST_PLAIN);

    // Data should contain the requested destination hash
    expect(pkt.data.length).toBeGreaterThanOrEqual(32);
    expect(equal(pkt.data.slice(0, 16), destHash)).toBe(true);

    // Will timeout
    const result = await promise;
    expect(result).toBe(false);
  });

  it('requestPath resolves when announce arrives for requested destination', async () => {
    const transport = new Transport();
    const iface = new MockInterface('mock');
    transport.registerInterface(iface);

    const id = Identity.generate();
    const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'test', 'path');

    // Start path request
    const promise = transport.requestPath(dest.hash, null, 5000);

    // Simulate: someone responds with an announce for this destination
    const announce = createAnnounce(dest);
    setTimeout(() => {
      iface.emit('packet', announce.pack());
    }, 50);

    const result = await promise;
    expect(result).toBe(true);

    // Path table should now have the destination
    expect(transport.pathTable.has(toHex(dest.hash))).toBe(true);
  });

  it('requestPath calls callback when path found', async () => {
    const transport = new Transport();
    const iface = new MockInterface('mock');
    transport.registerInterface(iface);

    const id = Identity.generate();
    const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'test');

    let callbackCalled = false;
    const promise = transport.requestPath(dest.hash, () => {
      callbackCalled = true;
    }, 5000);

    setTimeout(() => {
      iface.emit('packet', createAnnounce(dest).pack());
    }, 50);

    await promise;
    expect(callbackCalled).toBe(true);
  });

  describe('_handlePathRequest (transport node responding)', () => {
    it('recognizes the path request destination hash', () => {
      // Compute what the path request destination hash should be
      const pathReqHash = truncatedHash(
        truncatedHash(fromUtf8('rnstransport.path.request'), 10),
        16
      );
      expect(pathReqHash).toHaveLength(16);

      // This should be a stable, deterministic value
      const pathReqHash2 = truncatedHash(
        truncatedHash(fromUtf8('rnstransport.path.request'), 10),
        16
      );
      expect(equal(pathReqHash, pathReqHash2)).toBe(true);
    });
  });
});
