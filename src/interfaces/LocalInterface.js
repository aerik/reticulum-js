/**
 * LocalInterface — shared instance local socket interface.
 *
 * Matches the Python reference implementation (RNS/Interfaces/LocalInterface.py).
 *
 * The shared instance listens on 127.0.0.1:37428 (default).
 * Local clients connect via TCP and exchange HDLC-framed raw RNS packets.
 * No handshake, no control protocol — just packets.
 *
 * Two classes:
 * - LocalServerInterface: listens for local client connections
 * - LocalClientInterface: connects to a shared instance
 */

import { Interface } from './Interface.js';
import { HdlcFrameBuffer, hdlcEncode } from '../utils/hdlc.js';
import { log, LOG_DEBUG, LOG_ERROR, LOG_INFO, LOG_WARNING } from '../utils/log.js';
import {
  SHARED_INSTANCE_PORT,
  TCP_HW_MTU,
} from '../constants.js';

const TAG = 'Local';
const RECONNECT_WAIT = 8000; // ms

// --- Per-client handler for the server side ---

class LocalClientHandler {
  constructor(socket, server) {
    this.socket = socket;
    this.server = server;
    this.frameBuffer = new HdlcFrameBuffer();
    this.address = `${socket.remoteAddress}:${socket.remotePort}`;
    this.online = true;

    socket.setNoDelay(true);

    socket.on('data', (chunk) => {
      const frames = this.frameBuffer.feed(new Uint8Array(chunk));
      for (const frame of frames) {
        // Emit on the server interface so Transport picks it up.
        // Tag with _fromLocalClient so Transport knows this is a local client packet.
        server.emit('packet', frame, this);
      }
    });

    socket.on('close', () => {
      this.online = false;
      server._removeClient(this);
      log(LOG_INFO, TAG, `Local client disconnected: ${this.address}`);
    });

    socket.on('error', (err) => {
      this.online = false;
      server._removeClient(this);
      log(LOG_WARNING, TAG, `Local client error (${this.address}): ${err.message}`);
    });

    log(LOG_INFO, TAG, `Local client connected: ${this.address}`);
  }

  send(packetBytes) {
    if (!this.online) return;
    const framed = hdlcEncode(packetBytes);
    this.socket.write(Buffer.from(framed));
  }

  destroy() {
    this.online = false;
    this.socket.removeAllListeners();
    this.socket.destroy();
  }
}

// --- Server side (shared instance) ---

export class LocalServerInterface extends Interface {
  /**
   * @param {string} [name='Shared Instance']
   * @param {number} [port=37428]
   */
  constructor(name, port) {
    super(name || 'Shared Instance');
    this.port = port || SHARED_INSTANCE_PORT;
    this.server = null;
    this.clients = [];
    this.HW_MTU = TCP_HW_MTU;
    this.isLocalSharedInstance = true;
  }

  async start() {
    const { createServer } = await import('net');

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        const handler = new LocalClientHandler(socket, this);
        this.clients.push(handler);
      });

      this.server.on('error', (err) => {
        log(LOG_ERROR, TAG, `Shared instance server error: ${err.message}`);
        if (!this.online) reject(err);
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        this.online = true;
        log(LOG_INFO, TAG, `Shared instance listening on 127.0.0.1:${this.port}`);
        resolve();
      });
    });
  }

  async stop() {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients = [];
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
      this.server = null;
    }
    this.online = false;
  }

  /**
   * Send a packet to all local clients, optionally excluding the source.
   * @param {Uint8Array} packetBytes
   * @param {LocalClientHandler} [excludeClient]
   */
  send(packetBytes, excludeClient) {
    for (const client of this.clients) {
      if (client === excludeClient) continue;
      client.send(packetBytes);
    }
  }

  get clientCount() {
    return this.clients.filter(c => c.online).length;
  }

  _removeClient(handler) {
    const idx = this.clients.indexOf(handler);
    if (idx !== -1) this.clients.splice(idx, 1);
  }
}

// --- Client side (connects to shared instance) ---

export class LocalClientInterface extends Interface {
  /**
   * @param {string} [name='Local']
   * @param {number} [port=37428]
   */
  constructor(name, port) {
    super(name || 'Local');
    this.port = port || SHARED_INSTANCE_PORT;
    this.socket = null;
    this.frameBuffer = new HdlcFrameBuffer();
    this._reconnectTimer = null;
    this._stopped = false;
    this.HW_MTU = TCP_HW_MTU;
    this.isLocalClient = true;
  }

  async start() {
    if (this._stopped) return;
    const { createConnection } = await import('net');

    return new Promise((resolve, reject) => {
      this.socket = createConnection({ host: '127.0.0.1', port: this.port });
      this.socket.setNoDelay(true);

      const onConnect = () => {
        this.socket.removeListener('error', onError);
        this.online = true;
        log(LOG_INFO, TAG, `Connected to shared instance on port ${this.port}`);
        this._startReadLoop();
        resolve();
      };

      const onError = (err) => {
        this.socket.removeListener('connect', onConnect);
        log(LOG_WARNING, TAG, `Cannot connect to shared instance: ${err.message}`);
        reject(err);
      };

      this.socket.once('connect', onConnect);
      this.socket.once('error', onError);
    });
  }

  /**
   * Start with auto-reconnection.
   */
  async startWithReconnect() {
    try {
      await this.start();
    } catch {
      this._scheduleReconnect();
    }
  }

  async stop() {
    this._stopped = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.online = false;
    this.frameBuffer.reset();
  }

  send(packetBytes) {
    if (!this.online || !this.socket) return;
    const framed = hdlcEncode(packetBytes);
    this.socket.write(Buffer.from(framed));
  }

  _startReadLoop() {
    this.socket.on('data', (chunk) => {
      const frames = this.frameBuffer.feed(new Uint8Array(chunk));
      for (const frame of frames) {
        this.emit('packet', frame);
      }
    });

    this.socket.on('close', () => {
      log(LOG_WARNING, TAG, 'Shared instance connection closed');
      this._handleDisconnect();
    });

    this.socket.on('error', (err) => {
      log(LOG_ERROR, TAG, `Shared instance error: ${err.message}`);
      this._handleDisconnect();
    });
  }

  _handleDisconnect() {
    this.online = false;
    this.frameBuffer.reset();
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    if (!this._stopped) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        await this.start();
      } catch {
        this._scheduleReconnect();
      }
    }, RECONNECT_WAIT);
  }
}
