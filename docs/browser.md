# Browser Support

## Overview

The browser bundle includes all protocol logic, crypto, storage, and bz2 decompression — everything except Node-only network interfaces (TCP, UDP, AutoInterface). No Buffer polyfills needed. Browsers connect to the RNS network via HDLC-framed WebSocket to a Python bridge node.

```
Browser                         Python Bridge                  RNS Network
┌──────────────────┐           ┌──────────────────┐          ┌──────────┐
│ reticulum.umd.js │◄─WS/HDLC─►│ WebSocketInterface│◄──TCP──►│ Peers    │
│ Identity, Link   │           │ per-client spawn  │          │ NomadNet │
│ Crypto, Resource │           │ + Transport       │          │ nodes    │
│ bz2 decompress   │           │ + link routing    │          │          │
└──────────────────┘           └──────────────────┘          └──────────┘
```

## Building

```bash
npm run build:browser
```

Outputs:
- `dist/reticulum.es.js` — ESM module
- `dist/reticulum.umd.js` — UMD bundle (for `<script>` tags), creates `window.Reticulum`

Size: ~270KB raw, ~73KB gzipped. Includes vendored bz2 decompressor.

## Usage (serve via HTTP — file:// has CORS restrictions in Chrome)

```html
<script src="dist/reticulum.umd.js"></script>
<script>
  const R = window.Reticulum;

  // Create identity
  const identity = R.Identity.generate();
  console.log('Identity:', identity.hexHash);

  // Connect to bridge
  const transport = new R.Transport();
  const ws = new R.WebSocketClientInterface('Browser', 'ws://localhost:8765');
  transport.registerInterface(ws);

  transport.on('announce', (info) => {
    console.log('Announce:', R.toHex(info.destinationHash));
  });

  await ws.start();

  // Create destination and announce
  const dest = new R.Destination(identity, R.DEST_IN, R.DEST_SINGLE, 'myapp', 'browser');
  const pkt = R.createAnnounce(dest, new TextEncoder().encode('My Browser App'));
  transport.transmit(pkt);

  // Establish a link to a remote destination
  const link = R.Link.init(remoteDest, transport);
  transport.registerPendingLink(link);
  link.on('established', async () => {
    await link.send(new TextEncoder().encode('Hello from browser!'));
  });
</script>
```

## Available Exports (browser bundle)

### Core Protocol
- `Identity` — keypair generation, encrypt/decrypt, sign/verify
- `Destination` — named endpoints, hash computation
- `Packet` — wire format parse/pack
- `Link` — encrypted channels, request/response
- `Channel` — typed message passing
- `ResourceSender`, `ResourceReceiver` — large data transfer
- `Transport` — routing, announce handling, packet dispatch
- `createAnnounce`, `validateAnnounce` — announce utilities

### Storage
- `Storage` — persistence layer
- `IndexedDBBackend` — browser-native storage
- `MemoryBackend` — in-memory (for testing)

### Interfaces
- `WebSocketClientInterface` — connects to a bridge node

### Utilities
- `EventEmitter` — browser-compatible event system
- `toHex`, `fromHex`, `concat`, `equal`, `randomBytes`, `fromUtf8`, `toUtf8` — byte utilities
- All crypto functions from `utils/crypto.js`
- `hdlcEncode`, `hdlcDecode`, `kissEncode` — framing utilities
- `computeIfac`, `ifacMask`, `ifacUnmask` — IFAC utilities

### Constants
- `DEST_SINGLE`, `DEST_GROUP`, `DEST_PLAIN`, `DEST_LINK`, `DEST_IN`, `DEST_OUT`
- `PACKET_DATA`, `PACKET_ANNOUNCE`, `PACKET_LINK_REQUEST`, `PACKET_PROOF`
- `TRANSPORT_BROADCAST`, `TRANSPORT_TRANSPORT`
- `HEADER_1`, `HEADER_2`, `MTU`, `MAX_HOPS`

## Storage

Browser storage uses IndexedDB:

```javascript
const { Storage, IndexedDBBackend } = Reticulum;

const backend = new IndexedDBBackend('my-rns-app');
const storage = new Storage(backend);
await storage.init();

// Save/load identity
await storage.saveTransportIdentity(identity);
const loaded = await storage.loadTransportIdentity();

// Save/load known destinations
await storage.saveKnownDestinations(transport.announceTable);
```

## Setting Up a Bridge

### Python bridge (recommended)

The Python bridge uses `WebSocketInterface.py` which mirrors TCPServerInterface —
per-client HDLC framing, transport routing, and announce forwarding.

```bash
# Set up Python venv (one-time)
python -m venv .venv
.venv/Scripts/pip install rns websockets      # Windows
# .venv/bin/pip install rns websockets        # Linux/macOS

# Run the bridge (connects to RNS network + serves WebSocket for browsers)
.venv/Scripts/python examples/chat-server.py --rns-host vps001.vanheusden.com

# Serve the browser pages
node examples/serve.js 3001

# Open http://localhost:3001/examples/network-explorer.html
```

Known working RNS nodes: `vps001.vanheusden.com:4242`, `rns.dismail.de:7822`, `phantom.mobilefabrik.com:4242`

## Example Applications

- `examples/network-explorer.html` — live network explorer, establish Links, fetch NomadNet pages
- `examples/browser-chat.html` — mesh chat with encrypted links
- `examples/browser-demo.html` — simple announce viewer and sender
- `examples/chat-server.py` — Python bridge with echo bot + NomadNet page server
- `examples/bridge-server.py` — minimal Python bridge (no bot)
- `scripts/test-remote-page.js` — automated test: connect, find NomadNet nodes, fetch pages

## Limitations

- Browsers cannot create TCP/UDP sockets — WebSocket is the only transport
- The bridge node must be reachable from the browser (typically localhost or same network)
- Serve pages via HTTP (not file://) — Chrome blocks cross-origin loads from file:// URLs
- Link establishment to remote nodes depends on network path availability and the bridge's transport routing
- Some NomadNet nodes may not serve pages (no handler, ALLOW_NONE policy, or only relay traffic)
- No service worker / background support yet
- IndexedDB storage is origin-scoped (per-domain)
