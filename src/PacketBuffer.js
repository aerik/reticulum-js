/**
 * PacketBuffer — reassembly of fragmented packet streams.
 *
 * TCP interfaces frame packets with a length prefix. This buffer
 * accumulates incoming bytes and emits complete packets.
 *
 * Stub — implementation follows with TCPClientInterface.
 */

import { EventEmitter } from './utils/events.js';

export class PacketBuffer extends EventEmitter {
  constructor() {
    super();
    this.buffer = new Uint8Array(0);
  }

  /**
   * Feed raw bytes from a stream. Emits 'packet' for each complete packet.
   * @param {Uint8Array} chunk
   */
  feed(chunk) {
    // TODO: implement framing protocol
    throw new Error('Not yet implemented');
  }
}
