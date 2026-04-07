/**
 * Reticulum — top-level entry point.
 *
 * Initialises the Transport layer, manages interfaces,
 * loads config, handles persistence, and provides the public API.
 */

import { Transport } from './Transport.js';
import { Identity } from './Identity.js';
import { Destination } from './Destination.js';
import { Packet } from './Packet.js';
import { Link } from './Link.js';
import { Channel } from './Channel.js';
import { ResourceSender, ResourceReceiver } from './Resource.js';
import { createAnnounce, validateAnnounce } from './Announce.js';
import { TCPClientInterface } from './interfaces/TCPClientInterface.js';
import { TCPServerInterface } from './interfaces/TCPServerInterface.js';
import { UDPInterface } from './interfaces/UDPInterface.js';
import { AutoInterface } from './interfaces/AutoInterface.js';
import { LocalServerInterface, LocalClientInterface } from './interfaces/LocalInterface.js';
import { WebSocketServerInterface, WebSocketClientInterface } from './interfaces/WebSocketInterface.js';
import { Storage } from './utils/storage.js';
import { loadConfig, resolveConfigDir } from './utils/config.js';
import { log, setLogLevel, LOG_INFO, LOG_DEBUG, LOG_WARNING } from './utils/log.js';

const TAG = 'Reticulum';

export class Reticulum {
  /**
   * Create a Reticulum instance.
   *
   * Config can be provided directly or loaded from a config directory.
   *
   * @param {object} [config] - Direct config object. If omitted, loads from configDir.
   * @param {string} [config.configDir] - Config directory path (default: ~/.reticulum)
   * @param {boolean} [config.enableTransport=false]
   * @param {number} [config.logLevel]
   * @param {Array} [config.interfaces] - Interface configs
   */
  constructor(config = {}) {
    this.transport = new Transport({
      enableTransport: config.enableTransport || config.reticulum?.enable_transport || false,
    });
    this.config = config;
    this.configDir = config.configDir || null;
    this.storage = null;
    this.identity = null; // transport identity
    this.started = false;
    this._interfaces = [];
    this._persistTimer = null;

    const logLevel = config.logLevel ?? config.logging?.loglevel;
    if (logLevel !== undefined) {
      setLogLevel(logLevel);
    }
  }

  /**
   * Create and start a Reticulum instance from a config directory.
   * @param {string} [configDir] - Explicit config dir (default: auto-resolve)
   * @returns {Promise<Reticulum>}
   */
  static async fromConfig(configDir) {
    const resolvedDir = await resolveConfigDir(configDir);
    const config = await loadConfig(resolvedDir);
    config.configDir = resolvedDir;

    const rns = new Reticulum(config);
    await rns.start();
    return rns;
  }

  /**
   * Start Reticulum: init storage, load identity, create interfaces.
   * @returns {Promise<void>}
   */
  async start() {
    log(LOG_INFO, TAG, 'Starting Reticulum...');

    // Initialize storage if we have a config directory
    if (this.configDir) {
      this.storage = new Storage(this.configDir);
      await this.storage.init();
      this.transport.storage = this.storage;

      // Load or create transport identity
      this.identity = await this.storage.loadTransportIdentity();
      if (!this.identity) {
        this.identity = Identity.generate();
        await this.storage.saveTransportIdentity(this.identity);
        log(LOG_INFO, TAG, `Generated new transport identity: ${this.identity.hexHash}`);
      } else {
        log(LOG_INFO, TAG, `Loaded transport identity: ${this.identity.hexHash}`);
      }
      this.transport.identityHash = this.identity.hash;

      // Load persisted data
      const knownDests = await this.storage.loadKnownDestinations();
      for (const [k, v] of knownDests) {
        this.transport.announceTable.set(k, v);
      }

      const pathTable = await this.storage.loadPathTable();
      for (const [k, v] of pathTable) {
        this.transport.pathTable.set(k, v);
      }

      const hashlist = await this.storage.loadHashlist();
      this.transport.packetHashlist = hashlist;

      // Schedule periodic persistence (every 5 minutes)
      this._persistTimer = setInterval(() => this._persist(), 5 * 60 * 1000);
    }

    // Start shared instance if configured
    const reticulumConfig = this.config.reticulum || {};
    if (reticulumConfig.share_instance) {
      try {
        const port = reticulumConfig.shared_instance_port || 37428;
        this._sharedInstance = new LocalServerInterface('Shared Instance', port);
        this.addInterface(this._sharedInstance);
        await this._sharedInstance.start();
        log(LOG_INFO, TAG, `Shared instance listening on port ${port}`);
      } catch (err) {
        // Port may be in use — another instance is running, connect as client
        log(LOG_INFO, TAG, `Shared instance port in use, connecting as client: ${err.message}`);
        this._sharedInstance = null;
        const port = reticulumConfig.shared_instance_port || 37428;
        const localClient = new LocalClientInterface('Local', port);
        this.addInterface(localClient);
        await localClient.startWithReconnect();
      }
    }

    // Create interfaces from config
    const interfaces = this.config.interfaces || [];
    for (const ifaceConfig of interfaces) {
      try {
        await this._createInterface(ifaceConfig);
      } catch (err) {
        log(LOG_WARNING, TAG, `Failed to create interface "${ifaceConfig.name}": ${err.message}`);
      }
    }

    // Start transport table maintenance timers
    this.transport.startMaintenance();

    this.started = true;
    log(LOG_INFO, TAG, `Started with ${this._interfaces.length} interface(s)`);
  }

  /**
   * Stop Reticulum: persist data, stop all interfaces.
   * @returns {Promise<void>}
   */
  async stop() {
    log(LOG_INFO, TAG, 'Stopping Reticulum...');

    // Stop transport maintenance timers
    this.transport.stopMaintenance();

    if (this._persistTimer) {
      clearInterval(this._persistTimer);
      this._persistTimer = null;
    }

    // Final persist
    if (this.storage) {
      await this._persist();
    }

    for (const iface of this._interfaces) {
      await iface.stop();
    }
    this._interfaces = [];
    this.started = false;
    log(LOG_INFO, TAG, 'Stopped');
  }

  /**
   * Add an already-created interface.
   * @param {import('./interfaces/Interface.js').Interface} iface
   */
  addInterface(iface) {
    this._interfaces.push(iface);
    this.transport.registerInterface(iface);
  }

  /**
   * Register a destination for receiving packets.
   * @param {Destination} destination
   */
  registerDestination(destination) {
    this.transport.registerDestination(destination);
  }

  /**
   * Send an announce for a destination.
   * @param {Destination} destination
   * @param {Uint8Array} [appData]
   */
  announce(destination, appData) {
    const packet = createAnnounce(destination, appData);
    this.transport.transmit(packet);
  }

  /**
   * Request a path to a destination.
   * @param {Uint8Array} destHash
   * @param {number} [timeout=15000]
   * @returns {Promise<boolean>}
   */
  requestPath(destHash, timeout) {
    return this.transport.requestPath(destHash, null, timeout);
  }

  /**
   * Look up a cached identity by destination hash.
   * @param {Uint8Array} destHash
   * @returns {Identity|null}
   */
  getIdentity(destHash) {
    return this.transport.getIdentity(destHash);
  }

  /**
   * Get transport statistics.
   */
  getStats() {
    return { ...this.transport.stats };
  }

  async _persist() {
    if (!this.storage) return;
    try {
      await this.storage.saveKnownDestinations(this.transport.announceTable);
      await this.storage.savePathTable(this.transport.pathTable);
      await this.storage.saveHashlist(this.transport.packetHashlist);
      await this.storage.pruneAnnounceCache();
      log(LOG_DEBUG, TAG, 'Persisted data');
    } catch (err) {
      log(LOG_WARNING, TAG, `Persist failed: ${err.message}`);
    }
  }

  async _createInterface(config) {
    if (!config.enabled) return;

    let iface;

    switch (config.type) {
      case 'TCPClientInterface': {
        iface = new TCPClientInterface(
          config.name || 'TCP Client',
          config.target_host,
          config.target_port,
          { kissFraming: config.kiss_framing || false }
        );
        if (config.networkname || config.passphrase) {
          iface.configureIfac(config.networkname, config.passphrase, config.ifac_size);
        }
        this.addInterface(iface);
        await iface.startWithReconnect();
        break;
      }
      case 'TCPServerInterface': {
        iface = new TCPServerInterface(
          config.name || 'TCP Server',
          config.bind_host || '0.0.0.0',
          config.bind_port,
        );
        if (config.networkname || config.passphrase) {
          iface.configureIfac(config.networkname, config.passphrase, config.ifac_size);
        }
        this.addInterface(iface);
        await iface.start();
        break;
      }
      case 'UDPInterface': {
        iface = new UDPInterface(config.name || 'UDP', {
          listenIp: config.listen_ip || config.listenIp || '0.0.0.0',
          listenPort: config.listen_port || config.listenPort || config.port,
          forwardIp: config.forward_ip || config.forwardIp,
          forwardPort: config.forward_port || config.forwardPort || config.port,
        });
        if (config.networkname || config.passphrase) {
          iface.configureIfac(config.networkname, config.passphrase, config.ifac_size);
        }
        this.addInterface(iface);
        await iface.start();
        break;
      }
      case 'AutoInterface': {
        iface = new AutoInterface(config.name || 'AutoInterface', {
          groupId: config.group_id || config.groupId,
          discoveryPort: config.discovery_port || config.discoveryPort,
          dataPort: config.data_port || config.dataPort,
          allowedInterfaces: config.allowed_interfaces || config.allowedInterfaces,
          ignoredInterfaces: config.ignored_interfaces || config.ignoredInterfaces,
        });
        if (config.networkname || config.passphrase) {
          iface.configureIfac(config.networkname, config.passphrase, config.ifac_size);
        }
        this.addInterface(iface);
        await iface.start();
        break;
      }
      case 'WebSocketServerInterface': {
        iface = new WebSocketServerInterface(
          config.name || 'WebSocket Server',
          config.bind_host || config.listen_ip || '0.0.0.0',
          config.bind_port || config.listen_port || config.port,
        );
        if (config.networkname || config.passphrase) {
          iface.configureIfac(config.networkname, config.passphrase, config.ifac_size);
        }
        this.addInterface(iface);
        await iface.start();
        break;
      }
      case 'WebSocketClientInterface': {
        const wsUrl = config.url || `ws://${config.target_host}:${config.target_port}`;
        iface = new WebSocketClientInterface(
          config.name || 'WebSocket Client',
          wsUrl,
          { reconnectInterval: config.reconnect_interval, maxReconnectTries: config.max_reconnect_tries },
        );
        if (config.networkname || config.passphrase) {
          iface.configureIfac(config.networkname, config.passphrase, config.ifac_size);
        }
        this.addInterface(iface);
        await iface.startWithReconnect();
        break;
      }
      default:
        log(LOG_WARNING, TAG, `Unknown interface type: ${config.type}, skipping`);
    }
  }
}

// Re-export core classes for convenience
export { Identity, Destination, Packet, Link, Transport, Channel, ResourceSender, ResourceReceiver };
export { createAnnounce, validateAnnounce } from './Announce.js';
export { TCPClientInterface } from './interfaces/TCPClientInterface.js';
export { TCPServerInterface } from './interfaces/TCPServerInterface.js';
export { UDPInterface } from './interfaces/UDPInterface.js';
export { AutoInterface } from './interfaces/AutoInterface.js';
export { LocalServerInterface, LocalClientInterface } from './interfaces/LocalInterface.js';
export { WebSocketServerInterface, WebSocketClientInterface } from './interfaces/WebSocketInterface.js';
export { Storage } from './utils/storage.js';
export { StorageBackend, NodeFileBackend, IndexedDBBackend, MemoryBackend } from './utils/storage-backend.js';
export { loadConfig, parseJsonConfig, parseIniConfig, resolveConfigDir } from './utils/config.js';
export { DEST_SINGLE, DEST_GROUP, DEST_PLAIN, DEST_IN, DEST_OUT } from './constants.js';
