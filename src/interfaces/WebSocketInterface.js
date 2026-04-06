/**
 * WebSocket interfaces for RNS — enables browser clients.
 *
 * Uses HDLC framing over WebSocket, identical to how TCPInterface works.
 * This ensures full compatibility with Python's Transport — tunnel
 * synthesis, link routing, and proof forwarding all work correctly.
 *
 * WebSocketServerInterface: Node.js side, accepts WebSocket connections.
 * WebSocketClientInterface: connects to a WebSocket server (browser + Node).
 */

import { Interface } from './Interface.js';
import { HdlcFrameBuffer, hdlcEncode } from '../utils/hdlc.js';
import { log, LOG_DEBUG, LOG_ERROR, LOG_INFO, LOG_WARNING } from '../utils/log.js';
import { HEADER1_SIZE } from '../constants.js';

const TAG_SERVER = 'WSServer';
const TAG_CLIENT = 'WSClient';
const HW_MTU = 262144;

// --- Server ---

class WebSocketClientHandler {
  constructor(ws, server, address) {
    this.ws = ws;
    this.server = server;
    this.address = address;
    this.online = true;
    this.frameBuffer = new HdlcFrameBuffer();

    ws.binaryType = 'arraybuffer';

    ws.on('message', (data) => {
      // Extract bytes from the WebSocket message
      let bytes;
      if (data instanceof ArrayBuffer) {
        bytes = new Uint8Array(data);
      } else if (ArrayBuffer.isView(data)) {
        bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      } else {
        return;
      }
      // Feed into HDLC deframer
      const frames = this.frameBuffer.feed(bytes);
      for (const frame of frames) {
        server.emit('packet', frame);
      }
    });

    ws.on('close', () => {
      this.online = false;
      server._removeClient(this);
      log(LOG_INFO, TAG_SERVER, `Client disconnected: ${this.address}`);
    });

    ws.on('error', (err) => {
      this.online = false;
      server._removeClient(this);
      log(LOG_WARNING, TAG_SERVER, `Client error (${this.address}): ${err.message}`);
    });

    log(LOG_INFO, TAG_SERVER, `Client connected: ${this.address}`);
  }

  send(packetBytes) {
    if (!this.online || this.ws.readyState !== 1) return;
    // HDLC frame before sending
    this.ws.send(hdlcEncode(packetBytes));
  }

  destroy() {
    this.online = false;
    try { this.ws.close(); } catch {}
  }
}

export class WebSocketServerInterface extends Interface {
  /**
   * @param {string} name
   * @param {string} [bindHost='0.0.0.0']
   * @param {number} bindPort
   */
  constructor(name, bindHost, bindPort) {
    super(name || 'WebSocket Server');
    this.bindHost = bindHost || '0.0.0.0';
    this.bindPort = bindPort;
    this.HW_MTU = HW_MTU;

    this._wss = null;
    /** @type {WebSocketClientHandler[]} */
    this.clients = [];
  }

  async start() {
    const { WebSocketServer } = await import('ws');

    return new Promise((resolve, reject) => {
      this._wss = new WebSocketServer({
        host: this.bindHost,
        port: this.bindPort,
      });

      this._wss.on('error', (err) => {
        log(LOG_ERROR, TAG_SERVER, `Server error: ${err.message}`);
        if (!this.online) reject(err);
      });

      this._wss.on('listening', () => {
        this.online = true;
        const addr = this._wss.address();
        log(LOG_INFO, TAG_SERVER, `Listening on ${addr.address}:${addr.port}`);
        resolve();
      });

      this._wss.on('connection', (ws, req) => {
        const address = req.socket.remoteAddress + ':' + req.socket.remotePort;
        const handler = new WebSocketClientHandler(ws, this, address);
        this.clients.push(handler);
      });
    });
  }

  async stop() {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients = [];

    if (this._wss) {
      await new Promise((resolve) => this._wss.close(resolve));
      this._wss = null;
    }
    this.online = false;
    log(LOG_INFO, TAG_SERVER, `Stopped ${this.name}`);
  }

  send(packetBytes) {
    for (const client of this.clients) {
      client.send(packetBytes);
    }
    this.txBytes += packetBytes.length;
  }

  get clientCount() {
    return this.clients.filter(c => c.online).length;
  }

  get port() {
    return this._wss ? this._wss.address()?.port : null;
  }

  _removeClient(handler) {
    const idx = this.clients.indexOf(handler);
    if (idx !== -1) this.clients.splice(idx, 1);
  }
}

// --- Client ---

export class WebSocketClientInterface extends Interface {
  /**
   * @param {string} name
   * @param {string} url - WebSocket URL (e.g. "ws://example.com:8080")
   * @param {object} [options]
   * @param {number} [options.reconnectInterval=5000]
   * @param {number} [options.maxReconnectTries=0] - 0 = unlimited
   */
  constructor(name, url, options = {}) {
    super(name || 'WebSocket Client');
    this.url = url;
    this.reconnectInterval = options.reconnectInterval || 5000;
    this.maxReconnectTries = options.maxReconnectTries || 0;
    this.HW_MTU = HW_MTU;

    this._ws = null;
    this._stopped = false;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._frameBuffer = new HdlcFrameBuffer();
  }

  async start() {
    if (this._stopped) return;

    // Use native WebSocket if available (browser, Node 21+), else ws package
    const WS = globalThis.WebSocket || (await import('ws')).default;

    return new Promise((resolve, reject) => {
      this._ws = new WS(this.url);
      this._ws.binaryType = 'arraybuffer';

      const onOpen = () => {
        cleanup();
        this.online = true;
        this._reconnectAttempts = 0;
        log(LOG_INFO, TAG_CLIENT, `Connected to ${this.url}`);
        this._setupHandlers();
        resolve();
      };

      const onError = (err) => {
        cleanup();
        const msg = err?.message || 'Connection failed';
        log(LOG_ERROR, TAG_CLIENT, `${msg}`);
        reject(new Error(msg));
      };

      const cleanup = () => {
        this._ws.removeEventListener?.('open', onOpen);
        this._ws.removeEventListener?.('error', onError);
        // ws package uses on/removeListener
        if (this._ws.removeListener) {
          this._ws.removeListener('open', onOpen);
          this._ws.removeListener('error', onError);
        }
      };

      // Browser WebSocket uses addEventListener, ws package uses on()
      if (this._ws.addEventListener) {
        this._ws.addEventListener('open', onOpen);
        this._ws.addEventListener('error', onError);
      } else {
        this._ws.on('open', onOpen);
        this._ws.on('error', onError);
      }
    });
  }

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
    if (this._ws) {
      try { this._ws.close(); } catch {}
      this._ws = null;
    }
    this.online = false;
    log(LOG_INFO, TAG_CLIENT, `Stopped ${this.name}`);
  }

  send(packetBytes) {
    if (!this.online || !this._ws) return;
    const readyState = this._ws.readyState;
    if (readyState !== 1) return;

    // HDLC frame before sending — matches Python TCPInterface behaviour
    const framed = hdlcEncode(packetBytes);
    this._ws.send(framed);
    this.txBytes += packetBytes.length;
  }

  _setupHandlers() {
    const onMessage = (event) => {
      const raw = (event && event.data !== undefined) ? event.data : event;

      let bytes;
      if (raw instanceof ArrayBuffer) {
        bytes = new Uint8Array(raw);
      } else if (ArrayBuffer.isView(raw)) {
        bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      } else {
        return;
      }

      // Feed into HDLC deframer
      const frames = this._frameBuffer.feed(bytes);
      for (const frame of frames) {
        this.rxBytes += frame.length;
        this.emit('packet', frame);
      }
    };

    const onClose = () => {
      log(LOG_WARNING, TAG_CLIENT, `Connection closed: ${this.url}`);
      this._handleDisconnect();
    };

    const onError = (err) => {
      log(LOG_ERROR, TAG_CLIENT, `Error: ${err?.message || 'unknown'}`);
      this._handleDisconnect();
    };

    if (this._ws.addEventListener) {
      this._ws.addEventListener('message', onMessage);
      this._ws.addEventListener('close', onClose);
      this._ws.addEventListener('error', onError);
    } else {
      this._ws.on('message', onMessage);
      this._ws.on('close', onClose);
      this._ws.on('error', onError);
    }
  }

  _handleDisconnect() {
    this.online = false;
    if (this._ws) {
      try { this._ws.close(); } catch {}
      this._ws = null;
    }
    if (!this._stopped) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnectTimer) return;

    if (this.maxReconnectTries > 0 && this._reconnectAttempts >= this.maxReconnectTries) {
      log(LOG_ERROR, TAG_CLIENT, 'Max reconnect attempts reached');
      this._stopped = true;
      return;
    }

    this._reconnectAttempts++;
    log(LOG_INFO, TAG_CLIENT, `Reconnecting in ${this.reconnectInterval / 1000}s (attempt ${this._reconnectAttempts})...`);

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        await this.start();
      } catch {
        this._scheduleReconnect();
      }
    }, this.reconnectInterval);
  }
}
