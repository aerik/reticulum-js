/**
 * Tests for WebSocketClientInterface browser-native WebSocket code path.
 *
 * Node 21+ has a native WebSocket with the browser API surface:
 * - addEventListener / removeEventListener (not on/removeListener)
 * - MessageEvent objects (not raw Buffer)
 *
 * This test file explicitly verifies both the native (browser-like) path
 * and the ws-package (Node EventEmitter) fallback path.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServerInterface, WebSocketClientInterface } from '../src/interfaces/WebSocketInterface.js';
import { randomBytes, equal } from '../src/utils/bytes.js';
import { HEADER1_SIZE } from '../src/constants.js';

const cleanup = [];

afterEach(async () => {
  for (const item of cleanup) {
    await item.stop();
  }
  cleanup.length = 0;
});

describe('WebSocketClientInterface — native WebSocket path (browser-like)', () => {
  // On Node 24, globalThis.WebSocket is defined, so this IS the native path

  it('uses addEventListener (not on) for event handling', async () => {
    const server = new WebSocketServerInterface('ws-srv', '127.0.0.1', 0);
    cleanup.push(server);
    await server.start();

    const client = new WebSocketClientInterface('ws-cli', `ws://127.0.0.1:${server.port}`);
    cleanup.push(client);
    await client.start();

    // Verify the underlying WebSocket uses browser API (addEventListener)
    const ws = client._ws;
    expect(typeof ws.addEventListener).toBe('function');
  });

  it('receives MessageEvent objects (not raw Buffer)', async () => {
    const server = new WebSocketServerInterface('ws-srv', '127.0.0.1', 0);
    cleanup.push(server);
    await server.start();

    const client = new WebSocketClientInterface('ws-cli', `ws://127.0.0.1:${server.port}`);
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

  it('sends binary data from native WebSocket', async () => {
    const server = new WebSocketServerInterface('ws-srv', '127.0.0.1', 0);
    cleanup.push(server);
    await server.start();

    const client = new WebSocketClientInterface('ws-cli', `ws://127.0.0.1:${server.port}`);
    cleanup.push(client);
    await client.start();

    await new Promise(resolve => setTimeout(resolve, 50));

    const payload = randomBytes(HEADER1_SIZE + 25);

    const received = new Promise(resolve => {
      server.on('packet', (data) => resolve(data));
    });

    client.send(payload);
    const got = await received;
    expect(equal(got, payload)).toBe(true);
  });

  it('binaryType is set to arraybuffer', async () => {
    const server = new WebSocketServerInterface('ws-srv', '127.0.0.1', 0);
    cleanup.push(server);
    await server.start();

    const client = new WebSocketClientInterface('ws-cli', `ws://127.0.0.1:${server.port}`);
    cleanup.push(client);
    await client.start();

    expect(client._ws.binaryType).toBe('arraybuffer');
  });
});

describe('WebSocketClientInterface — ws package fallback path', () => {
  it('falls back to ws package when globalThis.WebSocket is missing', async () => {
    const server = new WebSocketServerInterface('ws-srv', '127.0.0.1', 0);
    cleanup.push(server);
    await server.start();

    // Temporarily remove native WebSocket to force ws fallback
    const originalWS = globalThis.WebSocket;
    globalThis.WebSocket = undefined;

    try {
      const client = new WebSocketClientInterface('ws-fallback', `ws://127.0.0.1:${server.port}`);
      cleanup.push(client);
      await client.start();

      // ws package WebSocket has .on() method
      const ws = client._ws;
      expect(typeof ws.on).toBe('function');

      // Verify data exchange still works
      const payload = randomBytes(HEADER1_SIZE + 10);

      const received = new Promise(resolve => {
        client.on('packet', (data) => resolve(data));
      });

      server.send(payload);
      const got = await received;
      expect(equal(got, payload)).toBe(true);
    } finally {
      globalThis.WebSocket = originalWS;
    }
  });

  it('ws package path handles raw Buffer messages (not MessageEvent)', async () => {
    const server = new WebSocketServerInterface('ws-srv', '127.0.0.1', 0);
    cleanup.push(server);
    await server.start();

    const originalWS = globalThis.WebSocket;
    globalThis.WebSocket = undefined;

    try {
      const client = new WebSocketClientInterface('ws-fallback', `ws://127.0.0.1:${server.port}`);
      cleanup.push(client);
      await client.start();

      await new Promise(resolve => setTimeout(resolve, 50));

      const payload = randomBytes(HEADER1_SIZE + 30);

      const received = new Promise(resolve => {
        server.on('packet', resolve);
      });

      client.send(payload);
      const got = await received;
      expect(equal(got, payload)).toBe(true);
    } finally {
      globalThis.WebSocket = originalWS;
    }
  });
});
