import { describe, it, expect, afterEach } from 'vitest';
import { createConnection } from 'net';
import { TCPServerInterface } from '../src/interfaces/TCPServerInterface.js';
import { TCPClientInterface } from '../src/interfaces/TCPClientInterface.js';
import { hdlcEncode } from '../src/utils/hdlc.js';
import { randomBytes, equal } from '../src/utils/bytes.js';
import { HEADER1_SIZE } from '../src/constants.js';

describe('TCPServerInterface', () => {
  let server;
  const cleanup = [];

  afterEach(async () => {
    for (const item of cleanup) {
      await item.stop();
    }
    cleanup.length = 0;
    if (server) {
      await server.stop();
      server = null;
    }
  });

  it('starts and listens on a port', async () => {
    server = new TCPServerInterface('test-server', '127.0.0.1', 0);
    await server.start();

    expect(server.online).toBe(true);
    expect(server.port).toBeGreaterThan(0);
  });

  it('accepts incoming connections', async () => {
    server = new TCPServerInterface('test-server', '127.0.0.1', 0);
    await server.start();

    // Connect a raw TCP client
    const socket = await new Promise((resolve, reject) => {
      const s = createConnection({ host: '127.0.0.1', port: server.port }, () => resolve(s));
      s.on('error', reject);
    });

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(server.clientCount).toBe(1);

    socket.destroy();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(server.clientCount).toBe(0);
  });

  it('receives HDLC-framed packets from clients', async () => {
    server = new TCPServerInterface('test-server', '127.0.0.1', 0);
    await server.start();

    const payload = randomBytes(HEADER1_SIZE + 10);
    const framed = hdlcEncode(payload);

    const received = new Promise((resolve) => {
      server.on('packet', (data) => resolve(data));
    });

    // Connect and send
    const socket = await new Promise((resolve, reject) => {
      const s = createConnection({ host: '127.0.0.1', port: server.port }, () => resolve(s));
      s.on('error', reject);
    });
    socket.write(Buffer.from(framed));

    const packet = await received;
    expect(equal(packet, payload)).toBe(true);

    socket.destroy();
  });

  it('broadcasts to all connected clients', async () => {
    server = new TCPServerInterface('test-server', '127.0.0.1', 0);
    await server.start();

    // Connect two raw clients
    const sockets = [];
    for (let i = 0; i < 2; i++) {
      const s = await new Promise((resolve, reject) => {
        const sock = createConnection({ host: '127.0.0.1', port: server.port }, () => resolve(sock));
        sock.on('error', reject);
      });
      sockets.push(s);
    }

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(server.clientCount).toBe(2);

    // Set up data listeners
    const dataPromises = sockets.map(s => new Promise(resolve => {
      const chunks = [];
      s.on('data', (chunk) => {
        chunks.push(new Uint8Array(chunk));
        setTimeout(() => {
          resolve(Buffer.concat(chunks.map(c => Buffer.from(c))));
        }, 50);
      });
    }));

    // Send from server to all clients
    const payload = randomBytes(HEADER1_SIZE + 5);
    server.send(payload);

    const results = await Promise.all(dataPromises);

    // Both clients should receive HDLC-framed data
    for (const data of results) {
      expect(data[0]).toBe(0x7E); // HDLC FLAG
      expect(data[data.length - 1]).toBe(0x7E);
    }

    for (const s of sockets) s.destroy();
  });

  it('works with TCPClientInterface end-to-end', async () => {
    server = new TCPServerInterface('test-server', '127.0.0.1', 0);
    await server.start();

    const client = new TCPClientInterface('test-client', '127.0.0.1', server.port);
    cleanup.push(client);
    await client.start();

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(server.clientCount).toBe(1);

    // Client → Server
    const payload1 = randomBytes(HEADER1_SIZE + 15);
    const serverReceived = new Promise(resolve => {
      server.on('packet', (data) => resolve(data));
    });
    client.send(payload1);
    const got1 = await serverReceived;
    expect(equal(got1, payload1)).toBe(true);

    // Server → Client
    const payload2 = randomBytes(HEADER1_SIZE + 20);
    const clientReceived = new Promise(resolve => {
      client.on('packet', (data) => resolve(data));
    });
    server.send(payload2);
    const got2 = await clientReceived;
    expect(equal(got2, payload2)).toBe(true);
  });
});
