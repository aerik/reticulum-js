# Link.js vs RNS/Link.py — Parity Detail

Source: parallel audit agent, 2026-04-11.

## Summary

Handshake, encryption, watchdog/STALE/TIMEOUT, packet-context dispatch and
resource RCL/ICL/PRF routing all match Python. Missing: mode/cipher
negotiation, MDU calculation, `RequestReceipt` API, resource strategies,
physical stats, Channel integration, `identify()`.

## Symbol table

### Constants & states

| Symbol | Status | Notes |
|--------|--------|-------|
| LINK_PENDING / HANDSHAKE / ACTIVE / STALE / CLOSED | MATCHED | 0x00-0x04 |
| TIMEOUT / INITIATOR_CLOSED / DESTINATION_CLOSED | MATCHED | Teardown reasons |
| ECPUBSIZE | MATCHED | 64 (32 X25519 + 32 Ed25519) |
| KEEPALIVE_MAX / MIN, STALE_FACTOR, STALE_GRACE | MATCHED | Same values |
| MODE_AES256_CBC etc. | MISSING | JS hardcoded AES-256-CBC; no negotiation |
| ACCEPT_NONE / APP / ALL | MISSING | No resource strategy filtering |
| MDU | MISSING | Python: `(MTU - IFAC_MIN - HEADER - TOKEN_OVERHEAD)/AES_BS - 1` |

### Handshake

| Symbol | Status | Notes |
|--------|--------|-------|
| linkIdFromPacket / link_id_from_lr_packet | MATCHED | SHA256(hashable_part)[:16] |
| validateRequest | MATCHED | Responder-side setup + proof |
| Link.init / _sendLinkRequest | MATCHED | Initiator side |
| handleProof / validate_proof | MATCHED | Signature verify + key derive |
| handleRtt | MATCHED | Responder HANDSHAKE→ACTIVE |

### Encryption

| Symbol | Status | Notes |
|--------|--------|-------|
| _deriveSessionKeys | MATCHED | ECDH + HKDF(salt=link_id, info=empty, 64b) |
| Key split signing/encryption | MATCHED | [0:32]/[32:64] |
| encrypt / Token.encrypt | PARTIAL | JS inline AES-256-CBC+HMAC; Python uses Token (Fernet-style, 48 overhead). Same wire bytes. |
| decrypt / Token.decrypt | PARTIAL | Same |

### Watchdog / keepalive

| Symbol | Status | Notes |
|--------|--------|-------|
| _startWatchdog / start_watchdog | MATCHED | setInterval vs threading |
| _watchdogCheck / __watchdog_job | MATCHED | PENDING→HANDSHAKE→ACTIVE→STALE→CLOSED |
| _updateKeepalive | MATCHED | keepalive = clamp(rtt * factor, MIN, MAX) |
| _sendKeepalive | MATCHED | Initiator 0xFF, responder echoes 0xFE |
| STALE transition | MATCHED | `stale_time = keepalive * STALE_FACTOR`; timeout = `rtt * KEEPALIVE_TIMEOUT_FACTOR + STALE_GRACE` |

### Context dispatch

| Symbol | Status |
|--------|--------|
| CONTEXT_LRPROOF | MATCHED |
| CONTEXT_LRRTT | MATCHED |
| CONTEXT_KEEPALIVE | MATCHED |
| CONTEXT_LINKCLOSE | MATCHED |
| CONTEXT_REQUEST / RESPONSE | MATCHED |
| CONTEXT_RESOURCE_ADV | MATCHED |
| CONTEXT_RESOURCE_REQ | MATCHED |
| CONTEXT_RESOURCE_HMU | MATCHED |
| CONTEXT_RESOURCE_PRF | MATCHED |
| CONTEXT_RESOURCE_ICL | MATCHED (added 9180b98) |
| CONTEXT_RESOURCE_RCL | MATCHED (added 9180b98) |
| CONTEXT_CHANNEL | MISSING |

### Request/response

| Symbol | Status | Notes |
|--------|--------|-------|
| _handleRequest | MATCHED | msgpack [timestamp, pathHash, data] dispatch |
| _handleResponse | MATCHED | msgpack [requestId, responseData] |
| setRequestHandler | PARTIAL | JS Map vs Python Destination.request_handlers |
| RequestReceipt / Callbacks | MISSING | No SENT/DELIVERED/READY state tracking |
| request() API | MISSING | No high-level request(path, data, cbs, timeout) |

### Resources

| Symbol | Status |
|--------|--------|
| _handleResourceAdv (auto-accept) | MATCHED |
| _handleResourceReq | MATCHED |
| _handleResourceProof | MATCHED |
| _handleResourceIcl / Rcl | MATCHED (added 9180b98) |
| _outgoingResources map | MATCHED |
| _activeResource (single slot) | PARTIAL | Python tracks a list |
| resource_strategy | MISSING | Auto-accept only |
| set_resource_strategy | MISSING | |

### Physical stats / Channel

| Symbol | Status |
|--------|--------|
| rssi / snr / q | MISSING |
| __update_phy_stats | MISSING |
| _channel / Channel integration | MISSING |
| LinkChannelOutlet | MISSING |

### Misc

| Symbol | Status | Notes |
|--------|--------|-------|
| _teardown | MATCHED | |
| _sendProof / _sendRtt | MATCHED | |
| send / encrypt packet | MATCHED | |
| sendWithProof | MATCHED | |
| close | MATCHED | |
| identify() | MISSING | No remote-identify |
| signalling_bytes / MTU negotiation | MISSING | JS hardcoded |

## Critical gaps

1. **No RequestReceipt / request() API** — see parity doc gap #10.
2. **No resource_strategy** — see parity doc gap #9.
3. **No mode negotiation** — low risk today (everyone uses AES-256-CBC) but
   architectural lock-in if Python adds a cipher.
4. **No Channel integration** — blocks any future use of `link.channel()` and
   associated streaming APIs (`RNS.Buffer` uses Channel underneath).
5. **No physical stats** — informational only.

## Verdict

**85-90% parity for the core link protocol.** Handshake, encryption, watchdog,
resource control all correct. Missing pieces are convenience APIs
(`request()`, `identify()`) and advanced features (Channel, strategies, MDU,
mode negotiation). Interop with Python peers is solid.
