import { describe, it, expect, afterEach } from 'vitest';
import { UDPInterface } from '../src/interfaces/UDPInterface.js';
import { randomBytes, equal } from '../src/utils/bytes.js';
import { HEADER1_SIZE } from '../src/constants.js';

describe('UDPInterface', () => {
  const cleanup = [];

  afterEach(async () => {
    for (const iface of cleanup) {
      await iface.stop();
    }
    cleanup.length = 0;
  });

  it('starts and binds to a port', async () => {
    const iface = new UDPInterface('test-udp', {
      listenPort: 0,
      forwardIp: '127.0.0.1',
      forwardPort: 19999,
    });
    cleanup.push(iface);

    await iface.start();
    expect(iface.online).toBe(true);
  });

  it('sends and receives raw datagrams (loopback)', async () => {
    // Receiver
    const receiver = new UDPInterface('udp-rx', {
      listenIp: '127.0.0.1',
      listenPort: 0,
      forwardIp: '127.0.0.1',
      forwardPort: 1, // doesn't matter for receive
    });
    cleanup.push(receiver);
    await receiver.start();
    const rxPort = receiver._recvSocket.address().port;

    // Sender — forwards to receiver's port
    const sender = new UDPInterface('udp-tx', {
      listenIp: '127.0.0.1',
      listenPort: 0,
      forwardIp: '127.0.0.1',
      forwardPort: rxPort,
    });
    cleanup.push(sender);
    await sender.start();

    const payload = randomBytes(HEADER1_SIZE + 20);

    const received = new Promise((resolve) => {
      receiver.on('packet', (data) => resolve(data));
    });

    sender.send(payload);

    const got = await received;
    expect(equal(got, payload)).toBe(true);
  });

  it('drops packets smaller than HEADER1_SIZE', async () => {
    const iface = new UDPInterface('udp-test', {
      listenIp: '127.0.0.1',
      listenPort: 0,
      forwardIp: '127.0.0.1',
      forwardPort: 1,
    });
    cleanup.push(iface);
    await iface.start();
    const port = iface._recvSocket.address().port;

    // Send a tiny packet directly via dgram
    const dgram = await import('dgram');
    const s = dgram.createSocket('udp4');

    let packetReceived = false;
    iface.on('packet', () => { packetReceived = true; });

    s.send(Buffer.from([1, 2, 3]), port, '127.0.0.1', () => {
      s.close();
    });

    await new Promise(resolve => setTimeout(resolve, 100));
    expect(packetReceived).toBe(false); // too small, dropped
  });

  it('bidirectional communication between two interfaces', async () => {
    const a = new UDPInterface('udp-a', {
      listenIp: '127.0.0.1',
      listenPort: 0,
      forwardIp: '127.0.0.1',
      forwardPort: 0, // will update after b starts
    });
    cleanup.push(a);
    await a.start();

    const b = new UDPInterface('udp-b', {
      listenIp: '127.0.0.1',
      listenPort: 0,
      forwardIp: '127.0.0.1',
      forwardPort: a._recvSocket.address().port,
    });
    cleanup.push(b);
    await b.start();

    // Update a's forward port to point at b
    a.forwardPort = b._recvSocket.address().port;

    // a → b
    const payload1 = randomBytes(HEADER1_SIZE + 5);
    const gotB = new Promise(resolve => b.on('packet', resolve));
    a.send(payload1);
    expect(equal(await gotB, payload1)).toBe(true);

    // b → a
    const payload2 = randomBytes(HEADER1_SIZE + 10);
    const gotA = new Promise(resolve => a.on('packet', resolve));
    b.send(payload2);
    expect(equal(await gotA, payload2)).toBe(true);
  });
});
