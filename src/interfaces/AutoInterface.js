/**
 * AutoInterface — automatic peer discovery over local network.
 *
 * Node.js only (uses `dgram` module with IPv6).
 *
 * Matches the Python reference implementation:
 * - Discovers peers via IPv6 link-local multicast
 * - Group ID hashed to compute multicast address
 * - Discovery tokens authenticate peers to the same group
 * - Data exchanged via UDP on a separate data port
 * - Peers evicted after PEERING_TIMEOUT with no discovery packets
 * - HW_MTU = 1196 bytes, raw datagrams (no framing)
 *
 * Constants:
 *   DISCOVERY_PORT = 29716
 *   DATA_PORT = 42671
 *   PEERING_TIMEOUT = 22s
 *   ANNOUNCE_INTERVAL = 1.6s
 */

import { Interface } from './Interface.js';
import { sha256Hash } from '../utils/crypto.js';
import { toHex, fromUtf8, concat, equal } from '../utils/bytes.js';
import { log, LOG_DEBUG, LOG_ERROR, LOG_INFO, LOG_WARNING, LOG_VERBOSE } from '../utils/log.js';
import { HEADER1_SIZE } from '../constants.js';

const TAG = 'Auto';

// Constants matching Python
const DEFAULT_DISCOVERY_PORT = 29716;
const DEFAULT_DATA_PORT = 42671;
const DEFAULT_GROUP_ID = 'reticulum';
const HW_MTU = 1196;
const PEERING_TIMEOUT = 22.0; // seconds
const ANNOUNCE_INTERVAL = 1600; // ms
const PEER_JOB_INTERVAL = 4000; // ms
const SCOPE_LINK = '2';

export class AutoInterface extends Interface {
  /**
   * @param {string} name
   * @param {object} [config]
   * @param {string} [config.groupId='reticulum']
   * @param {number} [config.discoveryPort=29716]
   * @param {number} [config.dataPort=42671]
   * @param {string[]} [config.allowedInterfaces] - NIC names to use (null = all)
   * @param {string[]} [config.ignoredInterfaces] - NIC names to skip
   */
  constructor(name, config = {}) {
    super(name || 'AutoInterface');
    this.groupId = fromUtf8(config.groupId || DEFAULT_GROUP_ID);
    this.discoveryPort = config.discoveryPort || DEFAULT_DISCOVERY_PORT;
    this.dataPort = config.dataPort || DEFAULT_DATA_PORT;
    this.allowedInterfaces = config.allowedInterfaces || null;
    this.ignoredInterfaces = config.ignoredInterfaces || [];
    this.HW_MTU = HW_MTU;

    // Compute multicast address from group ID
    this.multicastAddress = this._computeMulticastAddress();

    /** @type {Map<string, { ifname: string, lastHeard: number, lastOutbound: number }>} */
    this.peers = new Map();

    this._discoverySocket = null;
    this._dataSocket = null;
    this._announceTimer = null;
    this._peerJobTimer = null;
    this._localAddresses = [];
  }

  /**
   * Compute IPv6 multicast address from group ID.
   * Format: ff12:0:XXXX:XXXX:XXXX:XXXX:XXXX:XXXX
   * @returns {string}
   */
  _computeMulticastAddress() {
    const groupHash = sha256Hash(this.groupId);
    // Build multicast address from hash bytes
    // Python: g[3]+(g[2]<<8), g[5]+(g[4]<<8), etc. (little-endian pairs from hash[2:14])
    const groups = [];
    for (let i = 2; i < 14; i += 2) {
      const val = groupHash[i + 1] + (groupHash[i] << 8);
      groups.push(val.toString(16));
    }
    return `ff1${SCOPE_LINK}:0:${groups.join(':')}`;
  }

  /**
   * Compute discovery token for a given local address.
   * token = SHA256(groupId + addressString)
   * @param {string} address - IPv6 address string
   * @returns {Uint8Array} 32-byte token
   */
  _computeDiscoveryToken(address) {
    return sha256Hash(concat(this.groupId, fromUtf8(address)));
  }

  async start() {
    const dgram = await import('dgram');
    const os = await import('os');

    // Find IPv6 link-local addresses on allowed interfaces
    const networkInterfaces = os.networkInterfaces();
    for (const [ifname, addrs] of Object.entries(networkInterfaces)) {
      if (this.ignoredInterfaces.includes(ifname)) continue;
      if (this.allowedInterfaces && !this.allowedInterfaces.includes(ifname)) continue;

      for (const addr of addrs) {
        if (addr.family === 'IPv6' && addr.scopeid && addr.address.startsWith('fe80')) {
          this._localAddresses.push({
            ifname,
            address: addr.address,
            scopeid: addr.scopeid,
          });
        }
      }
    }

    if (this._localAddresses.length === 0) {
      log(LOG_WARNING, TAG, 'No IPv6 link-local addresses found');
      // Still start — may work later if interfaces come up
    }

    // Create discovery socket (multicast)
    try {
      this._discoverySocket = dgram.createSocket({ type: 'udp6', reuseAddr: true });

      await new Promise((resolve, reject) => {
        this._discoverySocket.on('error', (err) => {
          log(LOG_ERROR, TAG, `Discovery socket error: ${err.message}`);
          if (!this.online) reject(err);
        });

        this._discoverySocket.bind(this.discoveryPort, () => {
          // Join multicast group on each interface
          for (const local of this._localAddresses) {
            try {
              this._discoverySocket.addMembership(this.multicastAddress, local.address);
              log(LOG_DEBUG, TAG, `Joined multicast ${this.multicastAddress} on ${local.ifname}`);
            } catch (err) {
              log(LOG_WARNING, TAG, `Failed to join multicast on ${local.ifname}: ${err.message}`);
            }
          }
          resolve();
        });
      });

      this._discoverySocket.on('message', (msg, rinfo) => {
        this._handleDiscovery(new Uint8Array(msg), rinfo);
      });
    } catch (err) {
      log(LOG_WARNING, TAG, `Discovery socket setup failed: ${err.message}`);
    }

    // Create data socket
    try {
      this._dataSocket = dgram.createSocket({ type: 'udp6', reuseAddr: true });

      await new Promise((resolve, reject) => {
        this._dataSocket.on('error', (err) => {
          log(LOG_ERROR, TAG, `Data socket error: ${err.message}`);
          if (!this.online) reject(err);
        });

        this._dataSocket.bind(this.dataPort, resolve);
      });

      this._dataSocket.on('message', (msg, rinfo) => {
        const data = new Uint8Array(msg);
        this.rxBytes += data.length;
        if (data.length >= HEADER1_SIZE) {
          this.emit('packet', data);
        }
      });
    } catch (err) {
      log(LOG_WARNING, TAG, `Data socket setup failed: ${err.message}`);
    }

    this.online = true;

    // Start periodic discovery announcements
    this._announceTimer = setInterval(() => this._sendDiscovery(), ANNOUNCE_INTERVAL);
    this._sendDiscovery(); // immediate first announce

    // Start peer cleanup job
    this._peerJobTimer = setInterval(() => this._peerJob(), PEER_JOB_INTERVAL);

    log(LOG_INFO, TAG, `Started on ${this._localAddresses.length} interface(s), multicast=${this.multicastAddress}`);
  }

  async stop() {
    if (this._announceTimer) {
      clearInterval(this._announceTimer);
      this._announceTimer = null;
    }
    if (this._peerJobTimer) {
      clearInterval(this._peerJobTimer);
      this._peerJobTimer = null;
    }
    if (this._discoverySocket) {
      await new Promise(resolve => this._discoverySocket.close(resolve));
      this._discoverySocket = null;
    }
    if (this._dataSocket) {
      await new Promise(resolve => this._dataSocket.close(resolve));
      this._dataSocket = null;
    }
    this.peers.clear();
    this.online = false;
    log(LOG_INFO, TAG, `Stopped ${this.name}`);
  }

  send(packetBytes) {
    if (!this.online || !this._dataSocket) return;
    if (packetBytes.length > this.HW_MTU) return;

    const buf = Buffer.from(packetBytes);

    for (const [peerAddr, peer] of this.peers) {
      this._dataSocket.send(buf, 0, buf.length, this.dataPort, peerAddr, (err) => {
        if (err) {
          log(LOG_DEBUG, TAG, `Send to ${peerAddr} failed: ${err.message}`);
        } else {
          peer.lastOutbound = Date.now() / 1000;
          this.txBytes += buf.length;
        }
      });
    }
  }

  _sendDiscovery() {
    if (!this._discoverySocket) return;

    for (const local of this._localAddresses) {
      const token = this._computeDiscoveryToken(local.address);
      this._discoverySocket.send(
        Buffer.from(token),
        0,
        token.length,
        this.discoveryPort,
        this.multicastAddress,
        (err) => {
          if (err) {
            log(LOG_DEBUG, TAG, `Discovery send failed on ${local.ifname}: ${err.message}`);
          }
        }
      );
    }
  }

  _handleDiscovery(data, rinfo) {
    if (data.length < 16) return;

    const peerAddress = rinfo.address.replace(/%.*$/, ''); // strip scope ID suffix

    // Ignore our own announcements
    for (const local of this._localAddresses) {
      if (peerAddress === local.address) return;
    }

    // Verify discovery token: first 16 bytes should match hash(groupId + peerAddress)
    const peeringHash = data.slice(0, 16);
    const expected = this._computeDiscoveryToken(peerAddress).slice(0, 16);

    if (!equal(peeringHash, expected)) {
      log(LOG_DEBUG, TAG, `Invalid discovery token from ${peerAddress}`);
      return;
    }

    const now = Date.now() / 1000;

    if (!this.peers.has(peerAddress)) {
      log(LOG_INFO, TAG, `Discovered peer: ${peerAddress}`);
      this.peers.set(peerAddress, {
        ifname: rinfo.address,
        lastHeard: now,
        lastOutbound: 0,
      });
    } else {
      this.peers.get(peerAddress).lastHeard = now;
    }
  }

  _peerJob() {
    const now = Date.now() / 1000;
    for (const [addr, peer] of this.peers) {
      if (now - peer.lastHeard > PEERING_TIMEOUT) {
        log(LOG_INFO, TAG, `Peer timed out: ${addr}`);
        this.peers.delete(addr);
      }
    }
  }
}
