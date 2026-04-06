import { describe, it, expect } from 'vitest';
import { Channel } from '../src/Channel.js';
import { encode as msgpackEncode } from '@msgpack/msgpack';

// Minimal mock link
function mockLink() {
  const sent = [];
  return {
    sent,
    async send(data, context) {
      sent.push({ data: new Uint8Array(data), context });
    },
  };
}

describe('Channel', () => {
  it('sends typed messages via msgpack', async () => {
    const link = mockLink();
    const ch = new Channel(link);

    await ch.send('greeting', { text: 'hello' });

    expect(link.sent).toHaveLength(1);
    expect(link.sent[0].context).toBe(0x0E); // CONTEXT_CHANNEL
  });

  it('increments sequence numbers', async () => {
    const link = mockLink();
    const ch = new Channel(link);

    await ch.send('a', null);
    await ch.send('b', null);
    await ch.send('c', null);

    // Each should have incrementing sequence
    // We can't easily inspect the encrypted payload, but the channel object tracks it
    expect(ch._sequence).toBe(3);
  });

  it('dispatches to registered handlers', () => {
    const link = mockLink();
    const ch = new Channel(link);

    let received = null;
    ch.registerHandler('ping', (content) => {
      received = content;
    });

    // Simulate incoming message
    const packed = new Uint8Array(msgpackEncode(['ping', 0, { from: 'test' }]));
    ch.handleMessage(packed);

    expect(received).toEqual({ from: 'test' });
  });

  it('ignores messages with no handler', () => {
    const link = mockLink();
    const ch = new Channel(link);

    // Should not throw
    const packed = new Uint8Array(msgpackEncode(['unknown', 0, null]));
    ch.handleMessage(packed);
  });

  it('handles numeric message types', () => {
    const link = mockLink();
    const ch = new Channel(link);

    let received = null;
    ch.registerHandler(42, (content) => { received = content; });

    const packed = new Uint8Array(msgpackEncode([42, 0, 'data']));
    ch.handleMessage(packed);
    expect(received).toBe('data');
  });

  it('handles malformed messages gracefully', () => {
    const link = mockLink();
    const ch = new Channel(link);

    // Short array
    ch.handleMessage(new Uint8Array(msgpackEncode([1, 2])));
    // Invalid msgpack
    ch.handleMessage(new Uint8Array([0xFF, 0xFE]));
    // Should not throw
  });
});
