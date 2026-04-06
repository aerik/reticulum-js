/**
 * UDPInterface — UDP broadcast/unicast for local networks.
 *
 * Node.js only (uses `dgram` module).
 *
 * Matches the Python reference implementation:
 * - No framing — raw RNS packets sent as UDP datagram payloads
 * - One packet per datagram
 * - Supports broadcast and unicast via forward address config
 * - SO_BROADCAST always enabled
 * - HW_MTU = 1064 bytes
 */

import { Interface } from './Interface.js';
import { log, LOG_DEBUG, LOG_ERROR, LOG_INFO } from '../utils/log.js';
import { HEADER1_SIZE } from '../constants.js';

const TAG = 'UDP';
const HW_MTU = 1064;

export class UDPInterface extends Interface {
  /**
   * @param {string} name
   * @param {object} config
   * @param {string} [config.listenIp='0.0.0.0'] - Address to bind receive socket
   * @param {number} config.listenPort - Port to receive on
   * @param {string} config.forwardIp - Address to send to (unicast or broadcast)
   * @param {number} config.forwardPort - Port to send to
   */
  constructor(name, config) {
    super(name);
    this.listenIp = config.listenIp || '0.0.0.0';
    this.listenPort = config.listenPort;
    this.forwardIp = config.forwardIp;
    this.forwardPort = config.forwardPort;
    this.HW_MTU = HW_MTU;

    this._recvSocket = null;
  }

  async start() {
    const dgram = await import('dgram');

    return new Promise((resolve, reject) => {
      this._recvSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this._recvSocket.on('error', (err) => {
        log(LOG_ERROR, TAG, `Socket error: ${err.message}`);
        if (!this.online) reject(err);
      });

      this._recvSocket.on('message', (msg, rinfo) => {
        const data = new Uint8Array(msg);
        this.rxBytes += data.length;

        if (data.length >= HEADER1_SIZE) {
          log(LOG_DEBUG, TAG, `Received ${data.length}b from ${rinfo.address}:${rinfo.port}`);
          this.emit('packet', data);
        }
      });

      this._recvSocket.bind(this.listenPort, this.listenIp, () => {
        this._recvSocket.setBroadcast(true);
        this.online = true;
        const addr = this._recvSocket.address();
        log(LOG_INFO, TAG, `Listening on ${addr.address}:${addr.port}, forwarding to ${this.forwardIp}:${this.forwardPort}`);
        resolve();
      });
    });
  }

  async stop() {
    if (this._recvSocket) {
      await new Promise((resolve) => this._recvSocket.close(resolve));
      this._recvSocket = null;
    }
    this.online = false;
    log(LOG_INFO, TAG, `Stopped ${this.name}`);
  }

  send(packetBytes) {
    if (!this.online || !this._recvSocket) return;
    if (packetBytes.length > this.HW_MTU) {
      log(LOG_DEBUG, TAG, `Packet too large for UDP (${packetBytes.length} > ${this.HW_MTU})`);
      return;
    }

    // Send raw datagram — no framing needed for UDP
    this._recvSocket.send(
      Buffer.from(packetBytes),
      0,
      packetBytes.length,
      this.forwardPort,
      this.forwardIp,
      (err) => {
        if (err) {
          log(LOG_ERROR, TAG, `Send error: ${err.message}`);
        } else {
          this.txBytes += packetBytes.length;
        }
      }
    );
  }
}
