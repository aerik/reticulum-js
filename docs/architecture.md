# Architecture

## Module Map

```
src/
├── Reticulum.js              Top-level entry: config, storage, interface lifecycle
├── Transport.js              Routing: packet dispatch, announce handling, forwarding, IFAC, path requests
├── Identity.js               Keypair (X25519 + Ed25519), encrypt/decrypt, sign/verify, ratchets
├── Destination.js            Named endpoints, hash computation
├── Packet.js                 Wire format parse/pack, flags byte, packet hashing
├── Announce.js               Announce construction, validation, random blob timestamps
├── Link.js                   Encrypted channels: ECDH handshake, session keys, request/response
├── Resource.js               Large data transfer: segmentation, hashmap reassembly, proof
├── Channel.js                Typed message passing over links via msgpack
├── PacketBuffer.js           (legacy stub, replaced by hdlc.js)
├── browser.js                Browser entry point (excludes Node-only modules)
├── constants.js              All protocol constants
│
├── interfaces/
│   ├── Interface.js           Abstract base class, IFAC config
│   ├── TCPClientInterface.js  TCP client with HDLC/KISS framing, reconnection
│   ├── TCPServerInterface.js  TCP server, per-client HDLC framing
│   ├── UDPInterface.js        Raw UDP datagrams, broadcast/unicast
│   ├── AutoInterface.js       IPv6 multicast peer discovery
│   ├── LocalInterface.js      Shared instance (LocalServer + LocalClient)
│   └── WebSocketInterface.js  WebSocket server + client (browser-compatible)
│
└── utils/
    ├── bytes.js               Uint8Array utilities (concat, hex, utf8, randomBytes)
    ├── crypto.js              Crypto primitives via @noble/* (browser-compatible)
    ├── events.js              Minimal EventEmitter (browser-compatible)
    ├── hdlc.js                HDLC framing: encode, decode, stream buffer
    ├── kiss.js                KISS framing: encode, state-machine decoder
    ├── ifac.js                Interface Access Codes: compute, mask, unmask, verify
    ├── log.js                 Logging (levels 0-7 matching Python)
    ├── config.js              Config file parsing (INI + JSON)
    ├── storage.js             Persistence layer (delegates to backend)
    └── storage-backend.js     Backend interface + NodeFile, IndexedDB, Memory implementations
```

## Protocol Layers

```
Application (your code)
    │
    ▼
Reticulum.js ─── registers destinations, sends announces
    │
    ▼
Transport.js ─── packet dispatch, routing table, announce validation, dedup
    │             IFAC masking/unmasking on interface boundary
    ▼
Interface ─────── send/receive raw packets
    │             HDLC/KISS framing (TCP), raw datagrams (UDP/WS)
    ▼
Network ───────── TCP, UDP, WebSocket, IPv6 multicast
```

## Data Flow

### Outgoing packet
1. Application creates `Packet` or calls `transport.transmit(packet)`
2. `Transport.transmit()` calls `packet.pack()` to serialize
3. For each interface: if IFAC configured, applies XOR masking
4. Interface frames the packet (HDLC for TCP, raw for UDP/WS) and sends

### Incoming packet
1. Interface receives bytes, deframes (HDLC/KISS/raw)
2. Emits `'packet'` event with raw bytes
3. `Transport.inbound()` picks it up:
   - IFAC unmask if needed
   - Parse packet from wire format
   - Increment hops
   - Filter: PLAIN/GROUP hop limits, duplicate detection
   - Dispatch by type: DATA → deliver/forward, ANNOUNCE → validate/cache, LINK_REQUEST → create link, PROOF → verify/route

### Link establishment
1. Initiator: `Link.init(destination, transport)` → sends LINKREQUEST
2. Responder: `Link.validateRequest(packet)` → ECDH, sends signed PROOF
3. Initiator: `link.handleProof()` → ECDH, derives keys, sends encrypted RTT
4. Responder: `link.handleRtt()` → decrypts, confirms keys work → ACTIVE
5. Both sides: `link.send(data)` encrypts with AES-256-CBC + HMAC, `link.on('data')` decrypts

## Browser vs Node

| Feature | Node.js | Browser |
|---------|---------|---------|
| Crypto | `@noble/*` (pure JS) | Same |
| Transport | Full | Full |
| Identity/Packet/Link | Full | Full |
| TCP/UDP interfaces | Yes | No |
| WebSocket client | Yes (native or ws) | Yes (native) |
| WebSocket server | Yes (ws package) | No |
| AutoInterface | Yes | No |
| Storage backend | NodeFileBackend | IndexedDBBackend |
| Entry point | `src/Reticulum.js` | `src/browser.js` |
| Bundle | N/A | `dist/reticulum.umd.js` (67KB gz) |

## Design Decisions

- **Uint8Array everywhere** — no Node Buffer. All internal data uses Uint8Array for browser compat.
- **`@noble/*` for crypto** — pure JS, no native bindings, works identically in Node and browser.
- **Custom EventEmitter** — `src/utils/events.js` replaces Node's `events` for browser compat.
- **ESM only** — `"type": "module"` in package.json.
- **Async encryption** — uses `globalThis.crypto.subtle` (WebCrypto) for AES-CBC, available in both environments.
- **Pluggable storage** — abstract `StorageBackend` interface with NodeFile, IndexedDB, and Memory implementations.
