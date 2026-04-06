# Interfaces

Each interface sends and receives raw RNS packets over some transport medium. The Transport layer sits above all interfaces and doesn't need to know what medium they use.

## Interface Types

### TCPClientInterface

Connects to a remote RNS node over TCP. Uses HDLC or KISS framing.

```javascript
import { TCPClientInterface } from 'reticulum-node';

const iface = new TCPClientInterface('Dublin', 'rns.beleth.net', 4242);
await iface.start();              // connect
iface.send(packetBytes);          // send HDLC-framed packet
iface.on('packet', (raw) => {});  // receive deframed packet
await iface.stop();
```

**Config:**
```json
{
  "type": "TCPClientInterface",
  "name": "Dublin",
  "target_host": "rns.beleth.net",
  "target_port": 4242,
  "enabled": true,
  "kiss_framing": false
}
```

Features: HDLC or KISS framing, automatic reconnection, TCP_NODELAY, keepalive.

### TCPServerInterface

Accepts incoming TCP connections. Each client gets its own HDLC frame buffer.

```javascript
const server = new TCPServerInterface('Server', '0.0.0.0', 4242);
await server.start();
server.on('packet', (raw) => {});  // from any client
server.send(packetBytes);          // broadcast to all clients
console.log(server.clientCount);
```

### UDPInterface

UDP broadcast/unicast for local networks. No framing — one packet per datagram.

```javascript
const iface = new UDPInterface('LAN', {
  listenPort: 5555,
  forwardIp: '255.255.255.255',
  forwardPort: 5555,
});
await iface.start();
```

HW_MTU: 1064 bytes. `SO_BROADCAST` always enabled.

### AutoInterface

Automatic peer discovery via IPv6 link-local multicast.

```javascript
const iface = new AutoInterface('Auto', {
  groupId: 'reticulum',     // default
  discoveryPort: 29716,
  dataPort: 42671,
});
await iface.start();
console.log(iface.peers);  // Map of discovered peers
```

- Multicast address computed from group ID hash
- Discovery tokens authenticate peers to the same group
- Data exchanged via UDP on a separate port
- Peers evicted after 22 seconds without discovery packets

### WebSocketServerInterface

Accepts WebSocket connections. Node.js only (uses `ws` package). Spawns a per-client interface for each connection, with HDLC framing — identical to how TCPServerInterface works.

```javascript
const server = new WebSocketServerInterface('WS Server', '0.0.0.0', 8765);
await server.start();
```

Uses HDLC framing over WebSocket (same as TCP). This ensures Python's Transport handles link routing and proof forwarding correctly.

### WebSocketClientInterface

Connects to a WebSocket server with HDLC framing. Uses native `WebSocket` API — works in both Node.js and browsers.

```javascript
const client = new WebSocketClientInterface('WS Client', 'ws://localhost:8765');
await client.start();
```

This is the primary transport for browser-based RNS clients.

### Python WebSocket Bridge (`python/WebSocketInterface.py`)

Drop-in interface for the Python RNS stack. Mirrors TCPServerInterface:
- Spawns per-client `WebSocketClientInterface` with HDLC framing
- Registers clients as `local_client_interfaces` (for announce forwarding)
- Injects transport_id on outbound packets (for link_table routing)
- Full IFAC support

```ini
# ~/.reticulum/config
[[WebSocket Server]]
  type = WebSocketInterface
  enabled = yes
  mode = server
  listen_ip = 0.0.0.0
  listen_port = 8765
```

Requires: `pip install websockets`. Copy `python/WebSocketInterface.py` to `~/.reticulum/interfaces/`.

### LocalServerInterface / LocalClientInterface

Shared instance socket for multiple apps sharing one Reticulum instance. HDLC-framed raw packets over local TCP (port 37428 default).

```javascript
// Server side (the Reticulum instance)
const server = new LocalServerInterface('Shared', 37428);

// Client side (an app connecting to the shared instance)
const client = new LocalClientInterface('Local', 37428);
```

No handshake, no control protocol — just HDLC-framed packets.

## Framing

### HDLC (default for TCP)

```
[FLAG=0x7E] [escaped payload] [FLAG=0x7E]

Escape: 0x7D → [0x7D, 0x5D]
        0x7E → [0x7D, 0x5E]
```

Buffer-scan approach: accumulate data, find FLAG delimiters, extract and unescape.

### KISS (optional for TCP)

```
[FEND=0xC0] [CMD_DATA=0x00] [escaped payload] [FEND=0xC0]

Escape: 0xDB → [0xDB, 0xDD]
        0xC0 → [0xDB, 0xDC]
```

Byte-at-a-time state machine decoder.

### WebSocket / UDP

No framing. Each message/datagram is one complete raw packet.

## IFAC (Interface Access Codes)

Any interface can have IFAC enabled by setting `networkname` and/or `passphrase` in config:

```javascript
iface.configureIfac('my-network', 'secret-password');
```

IFAC provides:
- **Authentication**: only nodes with the same credentials can communicate
- **Obfuscation**: XOR masking of packet contents (not encryption)

When IFAC is enabled:
- Outgoing packets get an IFAC tag prepended and XOR-masked
- Incoming packets must have a valid IFAC tag or are dropped
- Packets without IFAC on an IFAC-enabled interface are dropped
- Packets with IFAC on a non-IFAC interface are dropped

## Known Public RNS Nodes

| Name | Host | Port |
|------|------|------|
| Beleth RNS Hub | rns.beleth.net | 4242 |
| dismails TCP | rns.dismail.de | 7822 |
| RNS Germany 001 | 202.61.243.41 | 4965 |
| RNS Germany 002 | 193.26.158.230 | 4965 |
| mobilefabrik | phantom.mobilefabrik.com | 4242 |
