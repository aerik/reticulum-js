# API Reference

## Reticulum

Top-level entry point. Manages config, storage, interfaces, and transport.

```javascript
import { Reticulum } from 'reticulum-node';

// From explicit config
const rns = new Reticulum({
  configDir: '~/.reticulum',
  enableTransport: false,
  logLevel: 4,
  interfaces: [{ type: 'TCPClientInterface', enabled: true, ... }],
});
await rns.start();

// From config file
const rns = await Reticulum.fromConfig('~/.reticulum');
```

| Method | Description |
|--------|-------------|
| `start()` | Init storage, load identity, create interfaces |
| `stop()` | Persist data, stop interfaces |
| `addInterface(iface)` | Add a pre-created interface |
| `registerDestination(dest)` | Register for incoming packets |
| `announce(dest, appData?)` | Send an announce |
| `requestPath(destHash, timeout?)` | Request path to a destination |
| `getIdentity(destHash)` | Look up cached identity |
| `getStats()` | Get transport statistics |

| Property | Description |
|----------|-------------|
| `transport` | The Transport instance |
| `identity` | Transport identity (if configDir set) |
| `storage` | Storage instance (if configDir set) |
| `started` | Boolean |

## Identity

X25519 + Ed25519 keypair.

```javascript
const id = Identity.generate();
const pubOnly = Identity.fromPublicKey(pubKeyBlob);  // 64 bytes
const restored = Identity.fromPrivateKey(prvKeyBlob); // 64 bytes
const restored = Identity.fromBytes(fullBlob);        // 128 bytes
```

| Method | Description |
|--------|-------------|
| `generate()` | Create new random identity |
| `fromPublicKey(blob)` | From 64-byte public key |
| `fromPrivateKey(blob)` | From 64-byte private key (derives public) |
| `fromBytes(blob)` | From 128-byte full export |
| `sign(data)` | Ed25519 sign → 64-byte signature |
| `verify(data, signature)` | Ed25519 verify → boolean |
| `encrypt(plaintext, ratchet?)` | Encrypt for this identity → ciphertext |
| `decrypt(ciphertext)` | Decrypt (tries ratchet then base key) |
| `export()` | Export 128 bytes (prv+pub) |
| `exportPrivateKey()` | Export 64 bytes (prv only) |
| `hasPrivateKey()` | Boolean |
| `rotateRatchet()` | Generate new ratchet → 32-byte pub |

| Property | Type | Description |
|----------|------|-------------|
| `publicKey` | Uint8Array(64) | X25519 pub + Ed25519 pub |
| `hash` | Uint8Array(16) | Truncated SHA-256 of publicKey |
| `hexHash` | string | Hex of hash |
| `encryptionPublicKey` | Uint8Array(32) | X25519 public |
| `signingPublicKey` | Uint8Array(32) | Ed25519 public |
| `ratchetPublicKey` | Uint8Array(32)\|null | Current ratchet |

## Destination

Named, addressable endpoint.

```javascript
const dest = new Destination(identity, DEST_IN, DEST_SINGLE, 'appname', 'aspect1', 'aspect2');
```

| Property | Description |
|----------|-------------|
| `hash` | Uint8Array(16) — destination hash |
| `hexHash` | string |
| `name` | Dotted name (e.g. "appname.aspect1.aspect2") |
| `nameHash` | Uint8Array(10) |
| `identity` | The associated Identity |
| `type` | DEST_SINGLE, DEST_PLAIN, etc. |
| `direction` | DEST_IN or DEST_OUT |

| Method | Description |
|--------|-------------|
| `setPacketCallback(fn)` | Handle incoming data packets |
| `setLinkCallback(fn)` | Handle incoming link requests (return true to accept) |
| `Destination.computeHash(nameHash, identityHash)` | Static hash computation |

## Packet

```javascript
const pkt = new Packet();
pkt.packetType = PACKET_DATA;
pkt.destType = DEST_SINGLE;
pkt.destinationHash = destHash;
pkt.data = payload;
const raw = pkt.pack();

const parsed = Packet.parse(raw);
```

| Property | Description |
|----------|-------------|
| `ifacFlag` | Bit 7 |
| `headerType` | HEADER_1 or HEADER_2 |
| `contextFlag` | Bit 5 (ratchet flag) |
| `transportType` | BROADCAST or TRANSPORT |
| `destType` | SINGLE, GROUP, PLAIN, LINK |
| `packetType` | DATA, ANNOUNCE, LINKREQUEST, PROOF |
| `hops` | Hop count |
| `destinationHash` | Uint8Array(16) |
| `transportId` | Uint8Array(16) or null |
| `context` | Context byte |
| `data` | Uint8Array payload |
| `raw` | Wire-format bytes |
| `packetHash` | SHA-256 for dedup |

## Link

```javascript
// Initiator
const link = Link.init(destination, transport);
transport.registerPendingLink(link);
link.on('established', () => { ... });

// Send data
await link.send(data, context?);

// Request/response
link.registerRequestHandler('/path', async (data) => response);
const resp = await link.request('/path', data, timeout);

// Close
await link.close();
```

| Event | Arguments | Description |
|-------|-----------|-------------|
| `established` | (link) | Link is ACTIVE |
| `closed` | (reason) | Link torn down |
| `data` | (plaintext, packet) | Decrypted data received |

## Transport

```javascript
const transport = new Transport({ enableTransport: false });
transport.registerInterface(iface);
transport.registerDestination(dest);
transport.transmit(packet, excludeInterface?);
transport.requestPath(destHash, callback?, timeout?);
```

| Event | Arguments | Description |
|-------|-----------|-------------|
| `announce` | (info) | Validated announce received |
| `linkEstablished` | (link) | New link established |
| `proof` | ({ destinationHash, packet }) | Proof received |

| Property | Description |
|----------|-------------|
| `interfaces` | Array of registered interfaces |
| `destinations` | Map of registered local destinations |
| `pathTable` | Map of known paths (destHex → path info) |
| `announceTable` | Map of cached identities (destHex → identity info) |
| `stats` | Packet/announce counters |

## Announce

```javascript
import { createAnnounce, validateAnnounce } from 'reticulum-node';

const pkt = createAnnounce(destination, appData?, { ratchet? });
const result = validateAnnounce(parsedPacket);
// result: { identity, nameHash, randomBlob, ratchet, appData, timestamp, destinationHash }
```

## Storage

```javascript
import { Storage, MemoryBackend, IndexedDBBackend } from 'reticulum-node';

const storage = new Storage(backendOrConfigDir);
await storage.init();
await storage.saveTransportIdentity(identity);
await storage.saveKnownDestinations(announceTable);
await storage.cacheAnnounce(packetHash, raw, ifaceName);
```

### StorageBackend interface

```javascript
backend.get(key)           → Promise<Uint8Array|null>
backend.set(key, value)    → Promise<void>
backend.delete(key)        → Promise<boolean>
backend.list(prefix)       → Promise<string[]>
backend.close()            → Promise<void>
```

Implementations: `NodeFileBackend`, `IndexedDBBackend`, `MemoryBackend`.

## Config

```javascript
import { loadConfig, parseIniConfig, parseJsonConfig, resolveConfigDir } from 'reticulum-node';

const config = await loadConfig(configDir);  // tries JSON, then INI, then generates default
const config = parseIniConfig(iniString);
const config = parseJsonConfig(jsonString);
const dir = await resolveConfigDir();        // ~/.reticulum
```

## Resource

```javascript
// Send large data
const sender = new ResourceSender(link, data, { requestId? });
await sender.advertise();
sender.onProgress((p) => { ... });
sender.onComplete(() => { ... });

// Receive
const receiver = new ResourceReceiver(link, advPlaintext);
await receiver.accept();
receiver.receivePart(partData);
receiver.onComplete((data) => { ... });
await receiver.sendProof();
```

## Channel

```javascript
const ch = new Channel(link);
ch.registerHandler('greeting', (content) => { ... });
await ch.send('greeting', { text: 'hello' });
```
