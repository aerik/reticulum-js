/**
 * Tests for Buffer — stream API on top of Channel.
 *
 * Covers wire format, single-stream reader/writer round-trip, multiple
 * streams sharing one channel, EOF semantics, and the bidirectional pair.
 */

import { describe, it, expect } from 'vitest';
import {
  Buffer, BufferReader, BufferWriter, BidirectionalBuffer,
  packStreamData, unpackStreamData,
  SMT_STREAM_DATA, STREAM_ID_MAX,
} from '../src/Buffer.js';
import { Channel } from '../src/Channel.js';
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';

// ----- Mock channel that pipes A → B without going through a real link -----

function mockLink(name = 'mock') {
  return {
    name,
    sent: [],
    async send(data, _context) {
      this.sent.push(new Uint8Array(data));
    },
  };
}

/**
 * Wire two channels together so that channel A's outgoing messages are
 * delivered to channel B's handleMessage and vice versa.
 */
function wirePair() {
  const linkA = mockLink('A');
  const linkB = mockLink('B');
  const chA = new Channel(linkA);
  const chB = new Channel(linkB);

  const origSendA = chA.send.bind(chA);
  chA.send = async (msgType, content) => {
    const seq = chA._sequence++;
    const packed = msgpackEncode([msgType, seq, content]);
    chB.handleMessage(new Uint8Array(packed));
  };

  const origSendB = chB.send.bind(chB);
  chB.send = async (msgType, content) => {
    const seq = chB._sequence++;
    const packed = msgpackEncode([msgType, seq, content]);
    chA.handleMessage(new Uint8Array(packed));
  };

  return { chA, chB };
}

// ----- Wire format -----

describe('Buffer wire format', () => {
  it('packs and unpacks a basic stream data message', () => {
    const data = new TextEncoder().encode('hello world');
    const wire = packStreamData(7, data, false, false);

    expect(wire.length).toBe(2 + data.length);
    expect(wire[0]).toBe(0x00);
    expect(wire[1]).toBe(0x07);

    const msg = unpackStreamData(wire);
    expect(msg.streamId).toBe(7);
    expect(msg.eof).toBe(false);
    expect(msg.compressed).toBe(false);
    expect(new TextDecoder().decode(msg.data)).toBe('hello world');
  });

  it('encodes the EOF flag in the high bit', () => {
    const wire = packStreamData(0x100, null, true, false);
    expect(wire[0] & 0x80).toBe(0x80);

    const msg = unpackStreamData(wire);
    expect(msg.eof).toBe(true);
    expect(msg.streamId).toBe(0x100);
    expect(msg.data.length).toBe(0);
  });

  it('rejects out-of-range stream ids', () => {
    expect(() => packStreamData(STREAM_ID_MAX + 1, null)).toThrow();
    expect(() => packStreamData(-1, null)).toThrow();
  });

  it('handles a max stream id', () => {
    const wire = packStreamData(STREAM_ID_MAX, null, false, false);
    const msg = unpackStreamData(wire);
    expect(msg.streamId).toBe(STREAM_ID_MAX);
  });
});

// ----- Reader / Writer round-trip -----

describe('BufferReader / BufferWriter', () => {
  it('round-trips a small message in a single chunk', async () => {
    const { chA, chB } = wirePair();
    const writer = new BufferWriter(42, chA, { chunkSize: 1024 });
    const reader = new BufferReader(42, chB);

    const received = [];
    reader.on('data', (chunk) => received.push(chunk));

    const payload = new TextEncoder().encode('hello world');
    await writer.write(payload);

    const all = Buffer_concat(received);
    expect(new TextDecoder().decode(all)).toBe('hello world');
  });

  it('chunks a large message and reassembles it', async () => {
    const { chA, chB } = wirePair();
    const writer = new BufferWriter(1, chA, { chunkSize: 16 });
    const reader = new BufferReader(1, chB);

    const payload = new Uint8Array(200);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;

    const received = [];
    reader.on('data', (chunk) => received.push(chunk));

    await writer.write(payload);

    const all = Buffer_concat(received);
    expect(all.length).toBe(200);
    for (let i = 0; i < 200; i++) expect(all[i]).toBe(i & 0xff);
  });

  it('signals EOF on close()', async () => {
    const { chA, chB } = wirePair();
    const writer = new BufferWriter(2, chA);
    const reader = new BufferReader(2, chB);

    let endFired = false;
    reader.on('end', () => { endFired = true; });

    await writer.write(new TextEncoder().encode('done'));
    await writer.close();

    expect(reader.ended).toBe(true);
    expect(endFired).toBe(true);
  });

  it('multiple streams share a single channel without crosstalk', async () => {
    const { chA, chB } = wirePair();
    const w1 = new BufferWriter(10, chA);
    const w2 = new BufferWriter(20, chA);
    const r1 = new BufferReader(10, chB);
    const r2 = new BufferReader(20, chB);

    const got1 = [], got2 = [];
    r1.on('data', (c) => got1.push(c));
    r2.on('data', (c) => got2.push(c));

    await w1.write(new TextEncoder().encode('stream-one'));
    await w2.write(new TextEncoder().encode('stream-two-data'));

    expect(new TextDecoder().decode(Buffer_concat(got1))).toBe('stream-one');
    expect(new TextDecoder().decode(Buffer_concat(got2))).toBe('stream-two-data');
  });

  it('rejects two readers on the same stream id of the same channel', () => {
    const { chB } = wirePair();
    const r1 = new BufferReader(99, chB);
    expect(() => new BufferReader(99, chB)).toThrow();
    r1.close();
  });

  it('pull-mode read(n) returns bytes synchronously', async () => {
    const { chA, chB } = wirePair();
    const writer = new BufferWriter(3, chA);
    const reader = new BufferReader(3, chB);

    await writer.write(new TextEncoder().encode('hello world'));

    const first = reader.read(5);
    expect(new TextDecoder().decode(first)).toBe('hello');

    const second = reader.read();
    expect(new TextDecoder().decode(second)).toBe(' world');

    expect(reader.available).toBe(0);
  });

  it('async iterator yields chunks until EOF', async () => {
    const { chA, chB } = wirePair();
    const writer = new BufferWriter(4, chA, { chunkSize: 4 });
    const reader = new BufferReader(4, chB);

    // Write + close in the background
    (async () => {
      await writer.write(new TextEncoder().encode('abcdefgh'));
      await writer.close();
    })();

    const collected = [];
    for await (const chunk of reader) {
      if (chunk && chunk.length > 0) collected.push(chunk);
    }
    const all = Buffer_concat(collected);
    expect(new TextDecoder().decode(all)).toBe('abcdefgh');
  });
});

// ----- Bidirectional pair -----

describe('BidirectionalBuffer', () => {
  it('reads on rxStreamId and writes on txStreamId', async () => {
    const { chA, chB } = wirePair();

    // A reads on 100, writes on 200; B is the mirror
    const bufA = new BidirectionalBuffer(100, 200, chA);
    const bufB = new BidirectionalBuffer(200, 100, chB);

    const fromB = [];
    bufA.on('data', (c) => fromB.push(c));
    const fromA = [];
    bufB.on('data', (c) => fromA.push(c));

    await bufA.write(new TextEncoder().encode('A→B'));
    await bufB.write(new TextEncoder().encode('B→A'));

    expect(new TextDecoder().decode(Buffer_concat(fromA))).toBe('A→B');
    expect(new TextDecoder().decode(Buffer_concat(fromB))).toBe('B→A');
  });
});

// ----- helper -----
function Buffer_concat(chunks) {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
