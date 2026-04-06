/**
 * TCPClientInterface — connect to a remote RNS node over TCP.
 *
 * Node.js only (uses `net` module). Browser equivalent would use WebSocket.
 *
 * Matches the Python reference implementation:
 * - HDLC framing (FLAG=0x7E) by default
 * - TCP_NODELAY enabled
 * - OS-level TCP keepalive
 * - Automatic reconnection for initiator connections
 */

import { Interface } from './Interface.js';
import { HdlcFrameBuffer, hdlcEncode } from '../utils/hdlc.js';
import { KissFrameBuffer, kissEncode } from '../utils/kiss.js';
import { log, LOG_DEBUG, LOG_ERROR, LOG_INFO, LOG_WARNING } from '../utils/log.js';
import {
  TCP_INITIAL_CONNECT_TIMEOUT,
  TCP_RECONNECT_WAIT,
  TCP_HW_MTU,
} from '../constants.js';

const TAG = 'TCPClient';

export class TCPClientInterface extends Interface {
  /**
   * @param {string} name - Human-readable name
   * @param {string} targetHost - Hostname or IP
   * @param {number} targetPort - Port number
   * @param {object} [options]
   * @param {boolean} [options.kissFraming=false] - Use KISS framing instead of HDLC
   * @param {number} [options.maxReconnectTries=0] - 0 = unlimited
   */
  constructor(name, targetHost, targetPort, options = {}) {
    super(name);
    this.targetHost = targetHost;
    this.targetPort = targetPort;
    this.kissFraming = options.kissFraming || false;
    this.maxReconnectTries = options.maxReconnectTries || 0;

    this.socket = null;
    this.frameBuffer = this.kissFraming ? new KissFrameBuffer() : new HdlcFrameBuffer();
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.initiator = true; // we initiated this connection
    this._stopped = false;
    this._writing = false;
    this._writeQueue = [];

    this.HW_MTU = TCP_HW_MTU;
  }

  /**
   * Connect to the remote node.
   * @returns {Promise<void>}
   */
  async start() {
    if (this._stopped) return;

    // Dynamic import — net is Node-only
    const { createConnection } = await import('net');

    return new Promise((resolve, reject) => {
      log(LOG_INFO, TAG, `Connecting to ${this.targetHost}:${this.targetPort}...`);

      const timeout = TCP_INITIAL_CONNECT_TIMEOUT * 1000;

      this.socket = createConnection({
        host: this.targetHost,
        port: this.targetPort,
        timeout,
      });

      this.socket.setNoDelay(true);

      // Enable TCP keepalive (matches Python settings)
      this.socket.setKeepAlive(true, 5000); // probe after 5s idle

      const onConnect = () => {
        this.socket.removeListener('error', onError);
        this.socket.setTimeout(0); // clear connect timeout
        this.online = true;
        this.reconnectAttempts = 0;
        log(LOG_INFO, TAG, `Connected to ${this.targetHost}:${this.targetPort}`);
        this._startReadLoop();
        resolve();
      };

      const onError = (err) => {
        this.socket.removeListener('connect', onConnect);
        log(LOG_ERROR, TAG, `Connection failed: ${err.message}`);
        reject(err);
      };

      this.socket.once('connect', onConnect);
      this.socket.once('error', onError);
    });
  }

  /**
   * Start with automatic reconnection (doesn't reject on initial failure).
   * @returns {Promise<void>}
   */
  async startWithReconnect() {
    try {
      await this.start();
    } catch (err) {
      log(LOG_WARNING, TAG, `Initial connection failed, will retry: ${err.message}`);
      this._scheduleReconnect();
    }
  }

  /**
   * Stop the interface and clean up.
   * @returns {Promise<void>}
   */
  async stop() {
    this._stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.online = false;
    this.frameBuffer.reset();
    log(LOG_INFO, TAG, `Stopped ${this.name}`);
  }

  /**
   * Send raw packet bytes through this interface.
   * Applies HDLC framing before sending on the TCP socket.
   * @param {Uint8Array} packetBytes
   */
  send(packetBytes) {
    if (!this.online || !this.socket) {
      log(LOG_WARNING, TAG, 'Cannot send — not connected');
      return;
    }

    const framed = this.kissFraming ? kissEncode(packetBytes) : hdlcEncode(packetBytes);

    // Serialize writes to prevent interleaving
    this._writeQueue.push(framed);
    if (!this._writing) {
      this._flushWriteQueue();
    }
  }

  _flushWriteQueue() {
    if (this._writeQueue.length === 0) {
      this._writing = false;
      return;
    }

    this._writing = true;
    const data = this._writeQueue.shift();

    const ok = this.socket.write(Buffer.from(data), (err) => {
      if (err) {
        log(LOG_ERROR, TAG, `Write error: ${err.message}`);
        this._handleDisconnect();
        return;
      }
      this.txBytes += data.length;
      this._flushWriteQueue();
    });

    // Handle backpressure
    if (!ok) {
      this.socket.once('drain', () => this._flushWriteQueue());
    }
  }

  _startReadLoop() {
    this.socket.on('data', (chunk) => {
      this.rxBytes += chunk.length;

      // Feed into HDLC deframer
      const frames = this.frameBuffer.feed(new Uint8Array(chunk));

      for (const frame of frames) {
        log(LOG_DEBUG, TAG, `Received frame: ${frame.length} bytes`);
        this.emit('packet', frame);
      }
    });

    this.socket.on('close', () => {
      log(LOG_WARNING, TAG, `Connection closed by remote: ${this.targetHost}:${this.targetPort}`);
      this._handleDisconnect();
    });

    this.socket.on('error', (err) => {
      log(LOG_ERROR, TAG, `Socket error: ${err.message}`);
      this._handleDisconnect();
    });
  }

  _handleDisconnect() {
    this.online = false;
    this.frameBuffer.reset();
    this._writeQueue = [];
    this._writing = false;

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }

    if (this.initiator && !this._stopped) {
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this._stopped) return;

    if (this.maxReconnectTries > 0 && this.reconnectAttempts >= this.maxReconnectTries) {
      log(LOG_ERROR, TAG, `Max reconnect attempts (${this.maxReconnectTries}) reached. Giving up.`);
      this._stopped = true;
      return;
    }

    this.reconnectAttempts++;
    log(LOG_INFO, TAG, `Reconnecting in ${TCP_RECONNECT_WAIT}s (attempt ${this.reconnectAttempts})...`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.start();
      } catch (err) {
        log(LOG_WARNING, TAG, `Reconnect failed: ${err.message}`);
        this._scheduleReconnect();
      }
    }, TCP_RECONNECT_WAIT * 1000);
  }
}
