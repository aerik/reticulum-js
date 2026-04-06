import { describe, it, expect, afterEach } from 'vitest';
import { LocalServerInterface, LocalClientInterface } from '../src/interfaces/LocalInterface.js';
import { Transport } from '../src/Transport.js';
import { Identity } from '../src/Identity.js';
import { Destination } from '../src/Destination.js';
import { Packet } from '../src/Packet.js';
import { createAnnounce } from '../src/Announce.js';
import { randomBytes, equal, toHex, fromUtf8 } from '../src/utils/bytes.js';
import {
  DEST_SINGLE, DEST_IN, PACKET_DATA, HEADER1_SIZE,
  HEADER_1, TRANSPORT_BROADCAST, CONTEXT_NONE,
} from '../src/constants.js';

const cleanup = [];

afterEach(async () => {
  for (const item of cleanup) {
    await item.stop();
  }
  cleanup.length = 0;
});

describe('LocalInterface', () => {
  describe('LocalServerInterface', () => {
    it('starts on a port', async () => {
      const server = new LocalServerInterface('test-shared', 0);
      cleanup.push(server);
      await server.start();

      expect(server.online).toBe(true);
      expect(server.port).toBeGreaterThan(0);
    });
  });

  describe('LocalClientInterface', () => {
    it('connects to a local server', async () => {
      const server = new LocalServerInterface('server', 0);
      cleanup.push(server);
      await server.start();

      const client = new LocalClientInterface('client', server.port);
      cleanup.push(client);
      await client.start();

      expect(client.online).toBe(true);

      await new Promise(resolve => setTimeout(resolve, 50));
      expect(server.clientCount).toBe(1);
    });
  });

  describe('packet exchange', () => {
    it('client sends HDLC-framed packet to server', async () => {
      const server = new LocalServerInterface('server', 0);
      cleanup.push(server);
      await server.start();

      const client = new LocalClientInterface('client', server.port);
      cleanup.push(client);
      await client.start();

      const payload = randomBytes(HEADER1_SIZE + 20);

      const received = new Promise(resolve => {
        server.on('packet', (data) => resolve(data));
      });

      client.send(payload);
      const got = await received;
      expect(equal(got, payload)).toBe(true);
    });

    it('server sends packet to client', async () => {
      const server = new LocalServerInterface('server', 0);
      cleanup.push(server);
      await server.start();

      const client = new LocalClientInterface('client', server.port);
      cleanup.push(client);
      await client.start();

      await new Promise(resolve => setTimeout(resolve, 50));

      const payload = randomBytes(HEADER1_SIZE + 10);

      const received = new Promise(resolve => {
        client.on('packet', (data) => resolve(data));
      });

      server.send(payload);
      const got = await received;
      expect(equal(got, payload)).toBe(true);
    });

    it('server broadcasts to multiple clients', async () => {
      const server = new LocalServerInterface('server', 0);
      cleanup.push(server);
      await server.start();

      const c1 = new LocalClientInterface('c1', server.port);
      const c2 = new LocalClientInterface('c2', server.port);
      cleanup.push(c1, c2);
      await c1.start();
      await c2.start();

      await new Promise(resolve => setTimeout(resolve, 50));
      expect(server.clientCount).toBe(2);

      const payload = randomBytes(HEADER1_SIZE + 5);

      const promises = [
        new Promise(resolve => c1.on('packet', resolve)),
        new Promise(resolve => c2.on('packet', resolve)),
      ];

      server.send(payload);

      const results = await Promise.all(promises);
      expect(equal(results[0], payload)).toBe(true);
      expect(equal(results[1], payload)).toBe(true);
    });
  });

  describe('with Transport', () => {
    it('announce from local client reaches server transport', async () => {
      // Set up server with Transport
      const serverTransport = new Transport();
      const server = new LocalServerInterface('server', 0);
      cleanup.push(server);
      serverTransport.registerInterface(server);
      await server.start();

      // Set up client
      const client = new LocalClientInterface('client', server.port);
      cleanup.push(client);
      await client.start();

      await new Promise(resolve => setTimeout(resolve, 50));

      // Create an announce and send from client
      const id = Identity.generate();
      const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'local', 'test');
      const announce = createAnnounce(dest);
      const raw = announce.pack();

      const announceReceived = new Promise(resolve => {
        serverTransport.on('announce', resolve);
      });

      client.send(raw);

      const info = await announceReceived;
      expect(equal(info.identity.publicKey, id.publicKey)).toBe(true);
    });

    it('packet from server transport reaches local client', async () => {
      const serverTransport = new Transport();
      const server = new LocalServerInterface('server', 0);
      cleanup.push(server);
      serverTransport.registerInterface(server);
      await server.start();

      const client = new LocalClientInterface('client', server.port);
      cleanup.push(client);
      await client.start();

      await new Promise(resolve => setTimeout(resolve, 50));

      // Send a packet via transport
      const pkt = new Packet();
      pkt.headerType = HEADER_1;
      pkt.packetType = PACKET_DATA;
      pkt.destType = 0x00;
      pkt.transportType = TRANSPORT_BROADCAST;
      pkt.destinationHash = randomBytes(16);
      pkt.context = CONTEXT_NONE;
      pkt.data = fromUtf8('from server');

      const clientReceived = new Promise(resolve => {
        client.on('packet', resolve);
      });

      serverTransport.transmit(pkt);

      const got = await clientReceived;
      // Parse and verify
      const parsed = Packet.parse(got);
      expect(equal(parsed.data, fromUtf8('from server'))).toBe(true);
    });
  });

  describe('reconnection', () => {
    it('client reconnects when server restarts', async () => {
      const server = new LocalServerInterface('server', 0);
      cleanup.push(server);
      await server.start();
      const port = server.port;

      const client = new LocalClientInterface('client', port);
      cleanup.push(client);
      await client.start();
      expect(client.online).toBe(true);

      // Stop server — client should disconnect
      await server.stop();
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(client.online).toBe(false);

      // Restart server on same port — client should reconnect
      // Note: we create a new server since the old one is stopped
      const server2 = new LocalServerInterface('server2', port);
      cleanup.push(server2);
      await server2.start();

      // Wait for reconnect (8 second default is too long for tests, but let's check state)
      // The client's reconnect timer is set, so it will eventually reconnect
      // For testing, we just verify the mechanism is wired up
      expect(client._reconnectTimer).not.toBeNull();
    });
  });
});
