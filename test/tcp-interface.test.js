import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer } from 'net';
import { TCPClientInterface } from '../src/interfaces/TCPClientInterface.js';
import { hdlcEncode } from '../src/utils/hdlc.js';
import { randomBytes, equal } from '../src/utils/bytes.js';
import { HEADER1_SIZE } from '../src/constants.js';

describe('TCPClientInterface', () => {
  let server;
  let serverPort;
  let serverSockets = [];

  beforeAll(async () => {
    // Start a local TCP server that echoes HDLC-framed packets
    server = createServer((socket) => {
      serverSockets.push(socket);
    });

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        serverPort = server.address().port;
        resolve();
      });
    });
  });

  afterEach(() => {
    // Clean up server sockets
    for (const s of serverSockets) {
      s.destroy();
    }
    serverSockets = [];
  });

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('connects to a TCP server', async () => {
    const iface = new TCPClientInterface('test-tcp', '127.0.0.1', serverPort);
    await iface.start();

    expect(iface.online).toBe(true);

    await iface.stop();
    expect(iface.online).toBe(false);
  });

  it('receives HDLC-framed packets', async () => {
    const iface = new TCPClientInterface('test-tcp', '127.0.0.1', serverPort);
    await iface.start();

    // Wait for server to see the connection
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Create a valid packet (>= HEADER1_SIZE bytes)
    const payload = randomBytes(HEADER1_SIZE + 20);
    const framed = hdlcEncode(payload);

    // Set up listener before sending
    const received = new Promise((resolve) => {
      iface.on('packet', (data) => resolve(data));
    });

    // Send from server side
    serverSockets[0].write(Buffer.from(framed));

    const packet = await received;
    expect(equal(packet, payload)).toBe(true);

    await iface.stop();
  });

  it('sends HDLC-framed packets', async () => {
    const iface = new TCPClientInterface('test-tcp', '127.0.0.1', serverPort);
    await iface.start();

    await new Promise((resolve) => setTimeout(resolve, 50));

    const payload = randomBytes(HEADER1_SIZE + 10);

    // Collect data from server side
    const serverData = new Promise((resolve) => {
      const chunks = [];
      serverSockets[0].on('data', (chunk) => {
        chunks.push(new Uint8Array(chunk));
        // Small delay to collect all chunks
        setTimeout(() => {
          const total = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
          let offset = 0;
          for (const c of chunks) {
            total.set(c, offset);
            offset += c.length;
          }
          resolve(total);
        }, 50);
      });
    });

    iface.send(payload);

    const received = await serverData;
    // Should be HDLC-framed: FLAG + escaped_payload + FLAG
    expect(received[0]).toBe(0x7E); // HDLC_FLAG
    expect(received[received.length - 1]).toBe(0x7E);

    await iface.stop();
  });

  it('receives multiple packets in sequence', async () => {
    const iface = new TCPClientInterface('test-tcp', '127.0.0.1', serverPort);
    await iface.start();

    await new Promise((resolve) => setTimeout(resolve, 50));

    const packets = [];
    const expected = [];

    iface.on('packet', (data) => packets.push(data));

    // Send 5 packets from server
    for (let i = 0; i < 5; i++) {
      const payload = randomBytes(HEADER1_SIZE + i * 10);
      expected.push(payload);
      serverSockets[0].write(Buffer.from(hdlcEncode(payload)));
    }

    // Wait for all to arrive
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(packets).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(equal(packets[i], expected[i])).toBe(true);
    }

    await iface.stop();
  });

  it('handles connection failure gracefully', async () => {
    const iface = new TCPClientInterface('test-tcp', '127.0.0.1', 1, {
      maxReconnectTries: 1,
    });

    await expect(iface.start()).rejects.toThrow();
    expect(iface.online).toBe(false);

    await iface.stop();
  });
});
