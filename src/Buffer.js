/**
 * Buffer — stream API on top of Channel.
 *
 * Mirrors Python RNS.Buffer (RNS/Buffer.py) — a way to send a continuous
 * binary stream over a Link by chunking it into StreamDataMessages and
 * shipping them through a Channel. Each stream is identified by a 14-bit
 * stream id, so multiple independent streams can share a single channel.
 *
 * Wire format of a StreamDataMessage payload:
 *
 *     +-+-+----------------+----------------+
 *     |E|C|  stream_id (14)|     data       |
 *     +-+-+----------------+----------------+
 *
 *   - bit 15  (E): EOF flag  — last message of the stream
 *   - bit 14  (C): compressed flag — payload is bz2-compressed
 *   - bits 0-13:   stream_id (0..16383)
 *   - remaining:   payload bytes (decompressed length when E set)
 *
 * Each StreamDataMessage is sent through a Channel as message type
 * `SMT_STREAM_DATA = 0xff00` (matching Python's SystemMessageTypes).
 *
 * Usage:
 *
 *     const channel = new Channel(link);
 *     link.on('channel', (pt) => channel.handleMessage(pt));
 *
 *     // Sender
 *     const writer = Buffer.createWriter(streamId, channel);
 *     await writer.write(new Uint8Array([1, 2, 3]));
 *     await writer.close();
 *
 *     // Receiver
 *     const reader = Buffer.createReader(streamId, channel);
 *     reader.on('data', (chunk) => { ... });
 *     reader.on('end', () => { ... });
 *
 * Or bidirectional pair:
 *
 *     const buf = Buffer.createBidirectionalBuffer(rxId, txId, channel);
 *     buf.on('data', ...);
 *     await buf.write(...);
 */

import { EventEmitter } from './utils/events.js';
import { decompressBz2 } from './utils/decompress.js';
import { log, LOG_DEBUG, LOG_WARNING } from './utils/log.js';

const TAG = 'Buffer';

// System message type — matches Python RNS.Channel.SystemMessageTypes.SMT_STREAM_DATA
export const SMT_STREAM_DATA = 0xff00;

// Maximum stream id (14 bits)
export const STREAM_ID_MAX = 0x3fff;

// Practical chunk size for writers. Python uses link.MDU - OVERHEAD; we
// use a conservative default (~400 bytes) so a chunk fits in a single
// link packet without resorting to a Resource.
export const DEFAULT_CHUNK_SIZE = 400;

// --- Wire format ---

/**
 * Pack a StreamDataMessage into raw bytes.
 *
 * @param {number} streamId
 * @param {Uint8Array} [data]
 * @param {boolean} [eof=false]
 * @param {boolean} [compressed=false]
 * @returns {Uint8Array}
 */
export function packStreamData(streamId, data = null, eof = false, compressed = false) {
  if (streamId < 0 || streamId > STREAM_ID_MAX) {
    throw new RangeError(`stream_id must be 0..${STREAM_ID_MAX}`);
  }
  const header = (streamId & 0x3fff) |
    (eof ? 0x8000 : 0) |
    (compressed ? 0x4000 : 0);

  const dataLen = data ? data.length : 0;
  const out = new Uint8Array(2 + dataLen);
  out[0] = (header >> 8) & 0xff;
  out[1] = header & 0xff;
  if (data && dataLen > 0) out.set(data, 2);
  return out;
}

/**
 * Unpack a StreamDataMessage from raw bytes.
 *
 * @param {Uint8Array} raw
 * @returns {{ streamId: number, eof: boolean, compressed: boolean, data: Uint8Array }}
 */
export function unpackStreamData(raw) {
  if (raw.length < 2) {
    throw new Error('StreamDataMessage too short');
  }
  const header = (raw[0] << 8) | raw[1];
  const eof = (header & 0x8000) !== 0;
  const compressed = (header & 0x4000) !== 0;
  const streamId = header & 0x3fff;
  let data = raw.length > 2 ? raw.slice(2) : new Uint8Array(0);

  if (compressed && data.length > 0) {
    try {
      data = decompressBz2(data);
    } catch (err) {
      throw new Error(`StreamDataMessage bz2 decompression failed: ${err.message}`);
    }
  }

  return { streamId, eof, compressed, data };
}

// --- Per-channel dispatcher ---
//
// The JS Channel only routes one handler per message type. We want multiple
// readers (each on a different stream_id) to share a single channel, so
// Buffer installs a single SMT_STREAM_DATA handler on each channel and
// demultiplexes by stream_id internally.

const channelDispatchers = new WeakMap();

function getDispatcher(channel) {
  let dispatcher = channelDispatchers.get(channel);
  if (dispatcher) return dispatcher;

  dispatcher = {
    readers: new Map(), // streamId → BufferReader
    install() {
      channel.registerHandler(SMT_STREAM_DATA, (content) => {
        let raw = content;
        if (!(raw instanceof Uint8Array)) {
          // msgpack may have decoded it as a Buffer/Array
          raw = new Uint8Array(raw);
        }
        let msg;
        try {
          msg = unpackStreamData(raw);
        } catch (err) {
          log(LOG_WARNING, TAG, `Drop malformed StreamDataMessage: ${err.message}`);
          return;
        }
        const reader = dispatcher.readers.get(msg.streamId);
        if (!reader) {
          log(LOG_DEBUG, TAG, `No reader for stream ${msg.streamId}, dropping ${msg.data.length}b`);
          return;
        }
        reader._receive(msg);
      });
    },
  };
  channelDispatchers.set(channel, dispatcher);
  dispatcher.install();
  return dispatcher;
}

// --- Reader ---

/**
 * BufferReader — receives a single stream's chunks from a channel.
 *
 * Emits:
 *   'data' (chunk: Uint8Array)
 *   'end' ()
 *   'error' (err)
 *
 * Also exposes synchronous read(n) for pull-mode consumption and an
 * async iterator for `for await (const chunk of reader)`.
 */
export class BufferReader extends EventEmitter {
  constructor(streamId, channel) {
    super();
    if (streamId > STREAM_ID_MAX) throw new RangeError(`stream_id > ${STREAM_ID_MAX}`);
    this.streamId = streamId;
    this.channel = channel;
    this._closed = false;
    this._eof = false;
    this._buf = [];      // queue of received Uint8Array chunks (pull mode)
    this._bufLen = 0;    // total bytes queued

    const dispatcher = getDispatcher(channel);
    if (dispatcher.readers.has(streamId)) {
      throw new Error(`Stream ${streamId} already has a reader on this channel`);
    }
    dispatcher.readers.set(streamId, this);
  }

  /** Internal: called by the channel dispatcher. */
  _receive(msg) {
    if (this._closed) return;
    if (msg.data && msg.data.length > 0) {
      this._buf.push(msg.data);
      this._bufLen += msg.data.length;
      this.emit('data', msg.data);
    }
    if (msg.eof) {
      this._eof = true;
      this.emit('end');
    }
  }

  /**
   * Pull-read up to `n` bytes from the buffer. Returns an empty Uint8Array
   * if no data is available (and EOF not yet reached). Returns null after EOF
   * is reached and the buffer is drained.
   *
   * @param {number} [n=Infinity]
   * @returns {Uint8Array|null}
   */
  read(n = Infinity) {
    if (this._bufLen === 0) {
      return this._eof ? null : new Uint8Array(0);
    }
    const want = Math.min(n, this._bufLen);
    const out = new Uint8Array(want);
    let written = 0;
    while (written < want && this._buf.length > 0) {
      const head = this._buf[0];
      const take = Math.min(head.length, want - written);
      out.set(head.subarray(0, take), written);
      written += take;
      if (take === head.length) {
        this._buf.shift();
      } else {
        this._buf[0] = head.subarray(take);
      }
    }
    this._bufLen -= written;
    return out;
  }

  /** Bytes currently buffered (not yet consumed). */
  get available() { return this._bufLen; }

  /** Whether EOF has been received. */
  get ended() { return this._eof; }

  /**
   * Close the reader. Subsequent incoming chunks for this stream are dropped.
   */
  close() {
    if (this._closed) return;
    this._closed = true;
    const dispatcher = channelDispatchers.get(this.channel);
    if (dispatcher) dispatcher.readers.delete(this.streamId);
    this.emit('close');
  }

  // Async iterator support: `for await (const chunk of reader)`
  [Symbol.asyncIterator]() {
    return {
      next: () => new Promise((resolve) => {
        if (this._bufLen > 0) {
          const chunk = this.read();
          return resolve({ value: chunk, done: false });
        }
        if (this._eof) return resolve({ value: undefined, done: true });
        const onData = () => { cleanup(); resolve({ value: this.read(), done: false }); };
        const onEnd  = () => { cleanup(); resolve({ value: undefined, done: true }); };
        const cleanup = () => {
          this.off('data', onData);
          this.off('end', onEnd);
        };
        this.on('data', onData);
        this.on('end', onEnd);
      }),
    };
  }
}

// --- Writer ---

/**
 * BufferWriter — sends a stream of chunks on one stream id over a channel.
 *
 * Mirrors Python RawChannelWriter (minus the bz2-compress-on-write path,
 * which we currently send uncompressed — Python receivers still decode
 * us correctly because the compressed flag is off).
 */
export class BufferWriter {
  constructor(streamId, channel, options = {}) {
    if (streamId > STREAM_ID_MAX) throw new RangeError(`stream_id > ${STREAM_ID_MAX}`);
    this.streamId = streamId;
    this.channel = channel;
    this.chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
    this._closed = false;
    this._writing = Promise.resolve();
  }

  /**
   * Write data to the stream. Chunks are sent as separate
   * StreamDataMessages on the channel. Resolves once all chunks have been
   * handed off to `link.send`.
   *
   * @param {Uint8Array|string} data
   * @returns {Promise<number>} bytes written
   */
  async write(data) {
    if (this._closed) throw new Error('BufferWriter is closed');
    if (typeof data === 'string') data = new TextEncoder().encode(data);
    if (!(data instanceof Uint8Array)) data = new Uint8Array(data);

    // Serialize concurrent writes so chunks stay in order on the wire.
    const prev = this._writing;
    let resolveOuter;
    const outer = new Promise((r) => { resolveOuter = r; });
    this._writing = outer;

    try {
      await prev;
      let offset = 0;
      while (offset < data.length) {
        const end = Math.min(offset + this.chunkSize, data.length);
        const chunk = data.subarray(offset, end);
        const wire = packStreamData(this.streamId, chunk, false, false);
        await this.channel.send(SMT_STREAM_DATA, wire);
        offset = end;
      }
      return data.length;
    } finally {
      resolveOuter();
    }
  }

  /**
   * Close the stream. Sends a final EOF marker (zero-length chunk with
   * the EOF flag set) and prevents further writes.
   */
  async close() {
    if (this._closed) return;
    // Wait for any in-flight writes to flush first
    try { await this._writing; } catch {}
    this._closed = true;
    const wire = packStreamData(this.streamId, null, true, false);
    try {
      await this.channel.send(SMT_STREAM_DATA, wire);
    } catch (err) {
      log(LOG_WARNING, TAG, `Failed to send EOF on stream ${this.streamId}: ${err.message}`);
    }
  }
}

// --- Bidirectional pair ---

/**
 * BidirectionalBuffer — combines a reader and writer for a duplex stream.
 *
 * Uses two stream ids: one for receive, one for send. The remote peer
 * mirrors the ids so what we read on `rxStreamId` is what they wrote on
 * their `rxStreamId` etc.
 */
export class BidirectionalBuffer extends EventEmitter {
  constructor(rxStreamId, txStreamId, channel, options = {}) {
    super();
    this.reader = new BufferReader(rxStreamId, channel);
    this.writer = new BufferWriter(txStreamId, channel, options);

    // Forward reader events
    this.reader.on('data', (chunk) => this.emit('data', chunk));
    this.reader.on('end', () => this.emit('end'));
    this.reader.on('error', (err) => this.emit('error', err));
  }

  write(data) { return this.writer.write(data); }
  read(n) { return this.reader.read(n); }
  get available() { return this.reader.available; }
  get ended() { return this.reader.ended; }

  async close() {
    await this.writer.close();
    this.reader.close();
  }
}

// --- Static factory functions (matching Python Buffer.create_*) ---

export const Buffer = {
  /**
   * Create a reader for receiving stream data on a channel.
   * @param {number} streamId - Local stream id to receive at
   * @param {import('./Channel.js').Channel} channel
   * @param {function(number)} [readyCallback] - Called with bytes-available count when new data arrives
   * @returns {BufferReader}
   */
  createReader(streamId, channel, readyCallback) {
    const reader = new BufferReader(streamId, channel);
    if (readyCallback) {
      reader.on('data', () => readyCallback(reader.available));
    }
    return reader;
  },

  /**
   * Create a writer for sending stream data on a channel.
   * @param {number} streamId - Remote stream id to send to
   * @param {import('./Channel.js').Channel} channel
   * @param {object} [options]
   * @returns {BufferWriter}
   */
  createWriter(streamId, channel, options) {
    return new BufferWriter(streamId, channel, options);
  },

  /**
   * Create a bidirectional buffer (reader + writer pair) on a channel.
   * @param {number} receiveStreamId
   * @param {number} sendStreamId
   * @param {import('./Channel.js').Channel} channel
   * @param {function(number)} [readyCallback]
   * @returns {BidirectionalBuffer}
   */
  createBidirectionalBuffer(receiveStreamId, sendStreamId, channel, readyCallback) {
    const buf = new BidirectionalBuffer(receiveStreamId, sendStreamId, channel);
    if (readyCallback) {
      buf.reader.on('data', () => readyCallback(buf.reader.available));
    }
    return buf;
  },
};
