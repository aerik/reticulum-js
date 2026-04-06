# Python Interoperability

## Wire Compatibility

This implementation is verified wire-compatible with the Python RNS reference implementation through:

1. **Static test vectors** — Python generates keypairs, hashes, encrypted data; Node.js verifies them (17 tests)
2. **Live network testing** — connected to public RNS nodes, validated announces from real Python nodes
3. **TCP Link interop** — Node.js establishes an encrypted Link to a Python server, exchanges data
4. **WebSocket Link interop** — same test over HDLC-framed WebSocket transport
5. **Page fetch interop** — Node.js fetches pages from Python NomadNet nodes via Link request/response, including Resource transfer with bz2 decompression
6. **Browser interop** — browser fetches real NomadNet pages from the live RNS network through the Python WebSocket bridge

## Python WebSocket Interface

A drop-in WebSocket interface for the Python RNS stack is included at `python/WebSocketInterface.py`.

### Installation

```bash
pip install websockets

# Copy to your RNS config directory
cp python/WebSocketInterface.py ~/.reticulum/interfaces/
```

### Configuration

Add to `~/.reticulum/config`:

```ini
# Server mode (accepts browser connections)
[[WebSocket Server]]
  type = WebSocketInterface
  enabled = yes
  mode = server
  listen_ip = 0.0.0.0
  listen_port = 8765

# Client mode (connects to a WebSocket server)
[[WebSocket Client]]
  type = WebSocketInterface
  enabled = yes
  mode = client
  target_host = example.com
  target_port = 8765
```

### How It Works

- **Server mode**: listens for WebSocket connections, relays packets to all connected clients via `websockets.broadcast()`. Incoming packets from clients are fed into `Transport.inbound()`.
- **Client mode**: connects to a WebSocket server, sends/receives packets over the connection with automatic reconnection.
- **No framing**: raw RNS packets are sent as binary WebSocket messages.
- **Thread-safe**: `process_outgoing()` is called from RNS's Transport thread; sends are dispatched via `call_soon_threadsafe` / `broadcast()`.

### Testing

```bash
# Python unit tests (9 tests)
.venv/Scripts/python.exe -m pytest python/test_websocket_interface.py -v

# Cross-platform interop (Node.js ↔ Python)
npx vitest run test/interop-link.test.js      # TCP link interop
npx vitest run test/interop-websocket.test.js  # WebSocket link interop
```

## Generating Test Vectors

```bash
.venv/Scripts/python.exe scripts/generate-test-vectors.py
```

Produces `test/vectors.json` containing:
- Identity public/private keys and hashes
- Destination hashes for various app name / aspect combinations
- Announce hash computation verification
- Encrypted ciphertext (for cross-decryption testing)
- Ed25519 signatures (for cross-verification)

## Running the Interop Tests

The interop tests launch a Python RNS server, then connect from Node.js:

```bash
# Full test suite (includes interop)
npm test

# Just the interop tests
npx vitest run test/interop.test.js         # static vectors
npx vitest run test/interop-link.test.js    # TCP link
npx vitest run test/interop-websocket.test.js  # WebSocket link
```

Requirements:
- Python venv at `.venv/` with `rns` and `websockets` packages
- Tests launch Python subprocesses automatically

## Verified Interop Points

| Feature | Test | Status |
|---------|------|--------|
| Identity hash computation | `test/interop.test.js` | Matching |
| Destination hash (6 cases) | `test/interop.test.js` | Matching |
| Ed25519 signature verify | `test/interop.test.js` | Matching |
| AES-256-CBC decryption | `test/interop.test.js` | Matching |
| Live network announces | `scripts/quick-test-connect.js` | 96/96 validated |
| TCP Link handshake + data | `test/interop-link.test.js` | Working |
| WebSocket Link handshake + data | `test/interop-websocket.test.js` | Working |
