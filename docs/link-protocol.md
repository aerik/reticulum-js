# Link Protocol

A Link is a virtual encrypted channel to a SINGLE destination, providing forward secrecy, authenticated encryption, and a request/response API.

## Handshake

```
Initiator                              Responder (Destination)
---------                              -----------------------
Generate ephemeral X25519 keypair
Generate ephemeral Ed25519 keypair

LINKREQUEST ─────────────────────────►
  dest_hash(16), ctx=0x00
  data: enc_pub(32) + sig_pub(32)
                                       Compute link_id from packet
                                       Generate ephemeral X25519 keypair
                                       ECDH: shared = X25519(prv, peer_pub)
                                       HKDF(shared, salt=link_id) → 64 bytes
                                       Sign: identity.sign(link_id + pub + sig_pub)

                         ◄──────────── PROOF (LRPROOF)
                                       link_id(16), ctx=0xFF
                                       data: signature(64) + enc_pub(32)

Verify signature using destination identity
ECDH: shared = X25519(prv, peer_pub)
HKDF(shared, salt=link_id) → 64 bytes
Status = ACTIVE

DATA (LRRTT) ────────────────────────►
  link_id(16), ctx=0xFE
  data: encrypt(rtt_value)
                                       Decrypt, verify keys work
                                       Status = ACTIVE

═══════ Link ACTIVE: bidirectional encrypted channel ═══════
```

## Link ID

```
link_id = SHA-256(hashable_part)[:16]

hashable_part = (flags & 0x0F) + raw[2:]    // for HEADER_1
                minus signalling bytes        // if present (data.length > 64)
```

The link ID is 16 bytes, derived from the LINKREQUEST packet's content.

## Session Key Derivation

```
ECDH:  shared_secret = X25519(our_ephemeral_prv, peer_ephemeral_pub)  // 32 bytes
HKDF:  derived = HKDF-SHA256(ikm=shared_secret, salt=link_id, info=empty)  // 64 bytes
Split: signing_key = derived[0:32], encryption_key = derived[32:64]
```

Both sides derive identical keys from the same shared secret and link ID.

## Per-Packet Encryption

Every data packet on a link:

```
IV = random 16 bytes
ciphertext = AES-256-CBC(PKCS7(plaintext), encryption_key, IV)
hmac = HMAC-SHA256(signing_key, IV + ciphertext)
encrypted_payload = IV(16) + ciphertext + hmac(32)
```

Token overhead: 48 bytes (16 IV + 32 HMAC) plus PKCS7 padding.

## Link States

| State | Value | Description |
|-------|-------|-------------|
| PENDING | 0x00 | Request sent, waiting for proof |
| HANDSHAKE | 0x01 | ECDH computed, waiting for RTT |
| ACTIVE | 0x02 | Encrypted channel ready |
| STALE | 0x03 | No inbound traffic |
| CLOSED | 0x04 | Torn down |

## API

### Establishing a link (initiator)

```javascript
import { Link } from 'reticulum-node';

const link = Link.init(destination, transport);
transport.registerPendingLink(link);

link.on('established', () => {
  console.log('Link active!');
});
```

### Accepting links (responder)

```javascript
destination.setLinkCallback((link) => {
  link.on('data', (plaintext) => { /* handle data */ });
  return true; // accept
});
```

### Sending data

```javascript
await link.send(new TextEncoder().encode('Hello!'));
```

### Request/Response

```javascript
// Responder registers a handler
link.registerRequestHandler('/echo', async (data) => {
  return data; // echo back
});

// Initiator sends a request
const response = await link.request('/echo', requestData, timeout);
```

Requests use msgpack encoding: `[timestamp, path_hash, data]`. Responses: `[request_id, data]`.

### Keepalive

- Initiator sends `0xFF` on `KEEPALIVE` context
- Responder replies with `0xFE`
- Keepalive packets are NOT encrypted

### Close

```javascript
await link.close();
// Sends encrypted link_id as close proof
// Keys are zeroed on both sides
```

## Resource Transfer

For data larger than one packet, use `ResourceSender` / `ResourceReceiver`:

```javascript
// Sender
const sender = new ResourceSender(link, largeData);
await sender.advertise();
// Parts are sent automatically, receiver reassembles via hashmap matching

// Receiver (on receiving RESOURCE_ADV)
const receiver = new ResourceReceiver(link, advData);
await receiver.accept();
receiver.onComplete((data) => { /* assembled data */ });
```

Resource protocol:
1. Advertise: msgpack dict with size, part count, hashmap, flags
2. Accept: receiver sends RESOURCE_REQ
3. Transfer: each part sent as RESOURCE context packet
4. Verify: receiver matches parts via `SHA-256(part + random_hash)[:4]`
5. Proof: `resource_hash(32) + SHA-256(data + hash)(32)`
