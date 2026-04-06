/**
 * Channel — structured message passing over Links.
 *
 * Provides a higher-level API for sending typed messages over an established Link.
 * Messages are msgpack-encoded and sent via CHANNEL context packets.
 *
 * Wire format:
 *   msgpack([message_type, sequence, content])
 *
 * Each message type has a registered handler on the receiving side.
 */

import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import { log, LOG_DEBUG, LOG_WARNING } from './utils/log.js';
import { CONTEXT_CHANNEL } from './constants.js';

const TAG = 'Channel';

export class Channel {
  /**
   * @param {import('./Link.js').Link} link
   */
  constructor(link) {
    this.link = link;
    this._handlers = new Map();
    this._sequence = 0;
  }

  /**
   * Register a handler for a message type.
   * @param {number|string} messageType
   * @param {function(any, Channel): void} handler
   */
  registerHandler(messageType, handler) {
    this._handlers.set(messageType, handler);
  }

  /**
   * Send a typed message over the channel.
   * @param {number|string} messageType
   * @param {any} content - Must be msgpack-serializable
   */
  async send(messageType, content) {
    const seq = this._sequence++;
    const packed = new Uint8Array(msgpackEncode([messageType, seq, content]));
    await this.link.send(packed, CONTEXT_CHANNEL);
    log(LOG_DEBUG, TAG, `Sent message type=${messageType} seq=${seq}`);
  }

  /**
   * Handle an incoming channel message (already decrypted).
   * @param {Uint8Array} plaintext
   */
  handleMessage(plaintext) {
    try {
      const unpacked = msgpackDecode(plaintext);
      if (!Array.isArray(unpacked) || unpacked.length < 3) return;

      const [messageType, sequence, content] = unpacked;

      const handler = this._handlers.get(messageType);
      if (handler) {
        handler(content, this);
      } else {
        log(LOG_DEBUG, TAG, `No handler for message type=${messageType}`);
      }
    } catch (err) {
      log(LOG_WARNING, TAG, `Channel message parse error: ${err.message}`);
    }
  }
}
