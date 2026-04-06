import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServerInterface, WebSocketClientInterface } from '../src/interfaces/WebSocketInterface.js';
import { Transport } from '../src/Transport.js';
import { Identity } from '../src/Identity.js';
import { Destination } from '../src/Destination.js';
import { createAnnounce } from '../src/Announce.js';
import { Packet } from '../src/Packet.js';
import { randomBytes, equal, fromUtf8, toHex } from '../src/utils/bytes.js';
import {
  HEADER1_SIZE, DEST_SINGLE, DEST_IN,
  PACKET_DATA, HEADER_1, TRANSPORT_BROADCAST, CONTEXT_NONE,
} from '../src/constants.js';

const cleanup = [];

afterEach(async () => {
  for (const item of cleanup) {
    await item.stop();
  }
  cleanup.length = 0;
});

describe('WebSocketServerInterface', () => {
  it('starts and listens', async () => {
    const server = new WebSocketServerInterface('ws-test', '127.0.0.1', 0);
    cleanup.push(server);
    await server.start();

    expect(server.online).toBe(true);
    expect(server.port).toBeGreaterThan(0);
  });
});

describe('WebSocketClientInterface', () => {
  it('connects to a WebSocket server', async () => {
    const server = new WebSocketServerInterface('ws-server', '127.0.0.1', 0);
    cleanup.push(server);
    await server.start();

    const client = new WebSocketClientInterface('ws-client', `ws://127.0.0.1:${server.port}`);
    cleanup.push(client);
    await client.start();

    expect(client.online).toBe(true);

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(server.clientCount).toBe(1);
  });
});

describe('WebSocket packet exchange', () => {
  it('client sends packet to server', async () => {
    const server = new WebSocketServerInterface('ws-server', '127.0.0.1', 0);
    cleanup.push(server);
    await server.start();

    const client = new WebSocketClientInterface('ws-client', `ws://127.0.0.1:${server.port}`);
    cleanup.push(client);
    await client.start();

    await new Promise(resolve => setTimeout(resolve, 50));

    const payload = randomBytes(HEADER1_SIZE + 20);

    const received = new Promise(resolve => {
      server.on('packet', (data) => resolve(data));
    });

    client.send(payload);
    const got = await received;
    expect(equal(got, payload)).toBe(true);
  });

  it('server sends packet to client', async () => {
    const server = new WebSocketServerInterface('ws-server', '127.0.0.1', 0);
    cleanup.push(server);
    await server.start();

    const client = new WebSocketClientInterface('ws-client', `ws://127.0.0.1:${server.port}`);
    cleanup.push(client);
    await client.start();

    await new Promise(resolve => setTimeout(resolve, 50));

    const payload = randomBytes(HEADER1_SIZE + 15);

    const received = new Promise(resolve => {
      client.on('packet', (data) => resolve(data));
    });

    server.send(payload);
    const got = await received;
    expect(equal(got, payload)).toBe(true);
  });

  it('broadcasts to multiple clients', async () => {
    const server = new WebSocketServerInterface('ws-server', '127.0.0.1', 0);
    cleanup.push(server);
    await server.start();

    const c1 = new WebSocketClientInterface('c1', `ws://127.0.0.1:${server.port}`);
    const c2 = new WebSocketClientInterface('c2', `ws://127.0.0.1:${server.port}`);
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

    const [got1, got2] = await Promise.all(promises);
    expect(equal(got1, payload)).toBe(true);
    expect(equal(got2, payload)).toBe(true);
  });

  it('drops packets smaller than HEADER1_SIZE', async () => {
    const server = new WebSocketServerInterface('ws-server', '127.0.0.1', 0);
    cleanup.push(server);
    await server.start();

    const client = new WebSocketClientInterface('ws-client', `ws://127.0.0.1:${server.port}`);
    cleanup.push(client);
    await client.start();

    await new Promise(resolve => setTimeout(resolve, 50));

    let received = false;
    server.on('packet', () => { received = true; });

    // Send tiny packet — should be dropped
    client.send(new Uint8Array([1, 2, 3]));

    await new Promise(resolve => setTimeout(resolve, 100));
    expect(received).toBe(false);
  });
});

describe('WebSocket with Transport', () => {
  it('announce from client reaches server transport', async () => {
    const server = new WebSocketServerInterface('ws-server', '127.0.0.1', 0);
    cleanup.push(server);
    await server.start();

    const serverTransport = new Transport();
    serverTransport.registerInterface(server);

    const client = new WebSocketClientInterface('ws-client', `ws://127.0.0.1:${server.port}`);
    cleanup.push(client);
    await client.start();

    await new Promise(resolve => setTimeout(resolve, 50));

    const id = Identity.generate();
    const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'ws', 'test');
    const announce = createAnnounce(dest);

    const announceReceived = new Promise(resolve => {
      serverTransport.on('announce', resolve);
    });

    client.send(announce.pack());

    const info = await announceReceived;
    expect(equal(info.identity.publicKey, id.publicKey)).toBe(true);
  });

  it('bidirectional transport: server sends, client receives via transport', async () => {
    const server = new WebSocketServerInterface('ws-server', '127.0.0.1', 0);
    cleanup.push(server);
    await server.start();

    const serverTransport = new Transport();
    serverTransport.registerInterface(server);

    const client = new WebSocketClientInterface('ws-client', `ws://127.0.0.1:${server.port}`);
    cleanup.push(client);
    await client.start();

    const clientTransport = new Transport();
    clientTransport.registerInterface(client);

    await new Promise(resolve => setTimeout(resolve, 50));

    // Server sends announce via transport
    const id = Identity.generate();
    const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'server', 'app');
    const announce = createAnnounce(dest, fromUtf8('ws-server-app'));

    const clientGotAnnounce = new Promise(resolve => {
      clientTransport.on('announce', resolve);
    });

    serverTransport.transmit(announce);

    const info = await clientGotAnnounce;
    expect(equal(info.destinationHash, dest.hash)).toBe(true);
  });
});
