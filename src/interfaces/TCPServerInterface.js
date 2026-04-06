/**
 * TCPServerInterface — accept incoming TCP connections from RNS nodes.
 *
 * Node.js only (uses `net` module).
 *
 * Matches the Python reference implementation:
 * - Listens on a TCP port, spawns a handler per client
 * - Each client gets its own HDLC frame buffer
 * - Packets from any client are emitted as 'packet' events
 * - Sending broadcasts to all connected clients
 */

import { Interface } from './Interface.js';
import { HdlcFrameBuffer, hdlcEncode } from '../utils/hdlc.js';
import { log, LOG_DEBUG, LOG_ERROR, LOG_INFO, LOG_WARNING } from '../utils/log.js';

const TAG = 'TCPServer';

/**
 * Represents a single connected client.
 */
class TCPClientHandler {
  /**
   * @param {import('net').Socket} socket
   * @param {TCPServerInterface} server
   */
  constructor(socket, server) {
    this.socket = socket;
    this.server = server;
    this.frameBuffer = new HdlcFrameBuffer();
    this.address = `${socket.remoteAddress}:${socket.remotePort}`;
    this.online = true;
    this.txBytes = 0;
    this.rxBytes = 0;

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);

    socket.on('data', (chunk) => {
      this.rxBytes += chunk.length;
      const frames = this.frameBuffer.feed(new Uint8Array(chunk));
      for (const frame of frames) {
        log(LOG_DEBUG, TAG, `Received ${frame.length}b from ${this.address}`);
        server.emit('packet', frame);
      }
    });

    socket.on('close', () => {
      this.online = false;
      log(LOG_INFO, TAG, `Client disconnected: ${this.address}`);
      server._removeClient(this);
    });

    socket.on('error', (err) => {
      this.online = false;
      log(LOG_WARNING, TAG, `Client error (${this.address}): ${err.message}`);
      server._removeClient(this);
    });

    log(LOG_INFO, TAG, `Client connected: ${this.address}`);
  }

  /**
   * Send HDLC-framed packet to this client.
   * @param {Uint8Array} packetBytes
   */
  send(packetBytes) {
    if (!this.online) return;
    const framed = hdlcEncode(packetBytes);
    this.socket.write(Buffer.from(framed), (err) => {
      if (err) {
        log(LOG_WARNING, TAG, `Write error to ${this.address}: ${err.message}`);
        this.online = false;
        this.socket.destroy();
      } else {
        this.txBytes += framed.length;
      }
    });
  }

  destroy() {
    this.online = false;
    this.socket.removeAllListeners();
    this.socket.destroy();
  }
}

export class TCPServerInterface extends Interface {
  /**
   * @param {string} name - Human-readable name
   * @param {string} bindHost - Address to bind to (e.g. '0.0.0.0')
   * @param {number} bindPort - Port to listen on
   */
  constructor(name, bindHost, bindPort) {
    super(name);
    this.bindHost = bindHost;
    this.bindPort = bindPort;
    this.server = null;

    /** @type {TCPClientHandler[]} */
    this.clients = [];
  }

  /**
   * Start listening for connections.
   * @returns {Promise<void>}
   */
  async start() {
    const { createServer } = await import('net');

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        const handler = new TCPClientHandler(socket, this);
        this.clients.push(handler);
      });

      this.server.on('error', (err) => {
        log(LOG_ERROR, TAG, `Server error: ${err.message}`);
        if (!this.online) reject(err);
      });

      this.server.listen(this.bindPort, this.bindHost, () => {
        const addr = this.server.address();
        this.online = true;
        log(LOG_INFO, TAG, `Listening on ${addr.address}:${addr.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the server and disconnect all clients.
   * @returns {Promise<void>}
   */
  async stop() {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients = [];

    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }

    this.online = false;
    log(LOG_INFO, TAG, `Stopped ${this.name}`);
  }

  /**
   * Send raw packet bytes to all connected clients.
   * @param {Uint8Array} packetBytes
   */
  send(packetBytes) {
    for (const client of this.clients) {
      client.send(packetBytes);
    }
    this.txBytes += packetBytes.length;
  }

  /**
   * Get the number of connected clients.
   * @returns {number}
   */
  get clientCount() {
    return this.clients.filter(c => c.online).length;
  }

  /**
   * Get the actual port (useful when bound to port 0).
   * @returns {number|null}
   */
  get port() {
    return this.server ? this.server.address()?.port : null;
  }

  _removeClient(handler) {
    const idx = this.clients.indexOf(handler);
    if (idx !== -1) this.clients.splice(idx, 1);
  }
}
