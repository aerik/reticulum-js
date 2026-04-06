/**
 * Interface — abstract base class for all RNS interfaces.
 *
 * An interface sends and receives raw RNS packets over some medium.
 * The Transport layer registers interfaces and listens for 'packet' events.
 *
 * Subclasses must implement:
 * - send(packetBytes: Uint8Array): void
 * - start(): Promise<void>
 * - stop(): Promise<void>
 */

import { EventEmitter } from '../utils/events.js';
import { computeIfac } from '../utils/ifac.js';

export class Interface extends EventEmitter {
  /**
   * @param {string} name - Human-readable interface name
   */
  constructor(name) {
    super();
    this.name = name;
    this.online = false;
    this.IN = true;   // Can receive
    this.OUT = true;  // Can send
    this.bitrate = 0;
    this.txBytes = 0;
    this.rxBytes = 0;

    /** IFAC configuration (null if not enabled) */
    this.ifacConfig = null;
  }

  /**
   * Configure IFAC (Interface Access Code) for this interface.
   * @param {string} [networkname='']
   * @param {string} [passphrase='']
   * @param {number} [ifacSize=16]
   */
  configureIfac(networkname, passphrase, ifacSize) {
    if (networkname || passphrase) {
      this.ifacConfig = computeIfac(networkname, passphrase, ifacSize);
    }
  }

  /**
   * Send raw packet bytes through this interface.
   * @param {Uint8Array} packetBytes
   */
  send(packetBytes) {
    throw new Error('Interface.send() must be implemented by subclass');
  }

  /**
   * Start the interface (connect, bind, etc.).
   * @returns {Promise<void>}
   */
  async start() {
    throw new Error('Interface.start() must be implemented by subclass');
  }

  /**
   * Stop the interface and clean up resources.
   * @returns {Promise<void>}
   */
  async stop() {
    throw new Error('Interface.stop() must be implemented by subclass');
  }
}
