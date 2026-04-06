# reticulum-js

JavaScript port of the [Reticulum Network Stack](https://reticulum.network) (RNS) — wire-compatible with the Python reference implementation.

Reticulum is a cryptography-based networking stack for building anonymous, decentralised networks over any physical medium. This port enables RNS-based applications in the JavaScript ecosystem, including browsers.

Browser clients connect via [reticulum-websocket](https://github.com/aerik/reticulum-websocket) — a Python WebSocket bridge that gives browsers access to the full RNS network.

## Features

- **Full wire-format compatibility** with Python RNS nodes (verified via interop tests)
- **Browser-compatible core** — crypto, protocol, and storage run in browsers
- **WebSocket transport** — browsers connect to an RNS node via WebSocket
- **All core protocol features**: Identity, Destination, Packet, Announce, Link (encrypted channels), Resource (large transfers), Channel (typed messaging)
- **All interface types**: TCP client/server, UDP, AutoInterface (IPv6 multicast), WebSocket, Local shared instance
- **IFAC** (Interface Access Codes) for interface-level authentication
- **Transport forwarding** for multi-hop routing
- **Pluggable storage** with Node filesystem and browser IndexedDB backends

## Prerequisites

- **Node.js** >= 18 (tested on 24)
- **npm** (comes with Node.js)

## Quick Start

```bash
# Install Node dependencies
npm install

# Run tests
npm test                    # 374 tests

# Build browser bundle
npm run build:browser       # → dist/reticulum.umd.js (~73KB gzipped)
```

### Python WebSocket Bridge

To connect browsers (or Node.js clients) to the RNS network, you need the WebSocket bridge from [reticulum-websocket](https://github.com/aerik/reticulum-websocket):

```bash
git clone https://github.com/aerik/reticulum-websocket.git
cd reticulum-websocket
python -m venv .venv
.venv/Scripts/pip install rns websockets    # Windows
# .venv/bin/pip install rns websockets      # Linux/macOS
```

See the [reticulum-websocket](https://github.com/aerik/reticulum-websocket) repo for bridge configuration and usage.

### Connect to the network (Node.js)

```javascript
import { Reticulum, Identity, Destination, DEST_SINGLE, DEST_IN } from 'reticulum-js';

const rns = new Reticulum({
  interfaces: [{
    name: 'Network',
    type: 'TCPClientInterface',
    enabled: true,
    target_host: 'rns.beleth.net',
    target_port: 4242,
  }],
});
await rns.start();

// Listen for announces
rns.transport.on('announce', (info) => {
  console.log('Announce:', info.identity.hexHash, info.appData);
});

// Create identity and announce
const identity = Identity.generate();
const dest = new Destination(identity, DEST_IN, DEST_SINGLE, 'myapp', 'service');
rns.announce(dest, new TextEncoder().encode('Hello RNS!'));
```

### Connect from a browser

```html
<script src="dist/reticulum.umd.js"></script>
<script>
  const R = window.Reticulum;
  const transport = new R.Transport();
  const ws = new R.WebSocketClientInterface('Browser', 'ws://localhost:8765');
  transport.registerInterface(ws);
  await ws.start();
  // Now receiving RNS packets from the network via the bridge
</script>
```

See `examples/browser-chat.html` for a complete working chat application.

## Architecture

```
Browser                          Node.js Bridge                    RNS Network
┌──────────────────┐            ┌──────────────────┐            ┌──────────┐
│ Identity, Crypto │            │ Full RNS Stack   │            │ Python   │
│ Packet, Link     │◄──WS────►│ + WebSocket Srv  │◄──TCP────►│ RNS      │
│ Transport        │            │ + Transport      │            │ Nodes    │
│ (browser bundle) │            │ + Forwarding     │            │          │
└──────────────────┘            └──────────────────┘            └──────────┘
```

## Documentation

| Document | Contents |
|----------|----------|
| [docs/architecture.md](docs/architecture.md) | Module structure, protocol layers, data flow |
| [docs/crypto.md](docs/crypto.md) | Cryptographic primitives, key formats, encryption scheme |
| [docs/packet-format.md](docs/packet-format.md) | Wire format, flags byte, header layouts |
| [docs/interfaces.md](docs/interfaces.md) | All interface types, configuration, framing |
| [docs/link-protocol.md](docs/link-protocol.md) | Link handshake, session keys, encrypted channel |
| [docs/browser.md](docs/browser.md) | Browser bundle, WebSocket transport, IndexedDB storage |
| [docs/python-interop.md](docs/python-interop.md) | Python WebSocket interface, interop testing |
| [docs/cli.md](docs/cli.md) | CLI tools: rnstatus, rnpath |
| [docs/api.md](docs/api.md) | API reference for all public classes |

## Dependencies

| Package | Purpose | Browser? |
|---------|---------|----------|
| `@noble/curves` | X25519, Ed25519 (pure JS) | Yes |
| `@noble/hashes` | SHA-256, HMAC, HKDF (pure JS) | Yes |
| `@msgpack/msgpack` | MessagePack for request/response and storage | Yes |
| `ws` | WebSocket server (Node.js only) | No |

No external bz2 dependency — a vendored pure-JS bzip2 decoder (`src/vendor/bz2.js`) handles Resource decompression in both Node and browser without Buffer polyfills.

## Roadmap

**LXMF (Messaging)** — the next layer to build. LXMF is the messaging protocol used by Sideband and NomadNet for chat. All building blocks are in place (Identity, Link, Resource). LXMF would add message formatting, delivery to `lxmf.delivery` destinations, and propagation node support for offline delivery. See [github.com/markqvist/LXMF](https://github.com/markqvist/LXMF).

## License

MIT
