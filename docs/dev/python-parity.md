# Python Parity Report

Generated: 2026-04-11
Scope: reticulum-js `src/` vs. reference Python at `D:\Projects\RNS-ref\RNS` and
`.venv/Lib/site-packages/LXMF`.

## Methodology

Eight parallel per-file audits of the core protocol subsystems, each classifying
Python symbols as **MATCHED** / **PARTIAL** / **MISSING** / **JS-ONLY**. Notes
focus on wire-format and correctness parity rather than completeness.

**Caveats**:
- Per-file audits occasionally miss cross-file moves (e.g. `Destination.announce()`
  lives in `src/Announce.js`, not `Destination.js`). Those are called out inline.
- Interface layer (`src/interfaces/*`) not yet audited.
- Cryptography primitives not audited (assumed correct — handled by `@noble` libs).

## TL;DR

**Wire format parity is solid on the happy path.** Packet framing, Link
handshake (LINKREQUEST → LRPROOF → LRRTT), HKDF key derivation, AES-256-CBC+HMAC
encryption, Resource advertisement/parts/HMU/proof, and LXMF message
pack/unpack all match Python byte-for-byte. JS ↔ Python interop works.

**The gaps are in reliability, state management, and advanced features**, not
in the core on-wire protocol:

1. **Forward secrecy is broken** — no persistent ratchet store, no rotation
   scheduler, no `enforce_ratchets`. The wire format supports ratchets but they
   aren't managed.
2. **Resource transfer has no retry loop** — fixed 120 s global timeout; Python
   retries parts/adv/proof with adaptive windowing.
3. **LXMF propagation node is ~20% ported** — peering subsystem, message
   persistence, stamping, and access control are entirely absent.
4. **Link has no RequestReceipt API, no resource strategy, no MDU calc, no
   Channel integration.**
5. **Transport has no path-state machine, no random_blob list, no tunnel
   support** (tunnel is intentional edge-only divergence).

None of these block current interop, but they all matter for reliability under
load or against adversarial peers.

## Subsystem scores

| File pair | Parity | Verdict |
|-----------|-------:|---------|
| `Packet.js` ↔ `RNS/Packet.py` | ~85% | Wire format matches; `pack()` doesn't encrypt (callers do it); no `PacketReceipt`/`ProofDestination`; LRPROOF special-case not in Packet itself (Link handles it). |
| `Identity.js` ↔ `RNS/Identity.py` | ~90% | Crypto primitives, multi-ratchet decrypt, and class-level known-ratchets store (remember/recall/clean + RATCHET_EXPIRY) all match Python. Announce validation lives in `Announce.js`, known-destinations in `Transport.announceTable`. |
| `Destination.js` ↔ `RNS/Destination.py` | ~60% | Hash, callbacks, name expansion, and full ratchet management (rotation, persistence, enforce, retained count, interval) now match Python. `announce()` is in `src/Announce.js` (architectural split). Still missing: request handlers, `encrypt()`/`decrypt()` dispatch, `incoming_link_request()`, GROUP destination support. |
| `Link.js` ↔ `RNS/Link.py` | ~90% | Handshake, encryption, watchdog, STALE/TIMEOUT, RCL/ICL/PRF dispatch, and resource_strategy (ACCEPT_NONE/APP/ALL) all correct. Missing: `RequestReceipt` API, MDU calc, mode negotiation, Channel, physical stats, `identify()`. |
| `Resource.js` ↔ `RNS/Resource.py` | ~85% | Advertisement/parts/HMU/proof, watchdog/retry loop, and AWAITING_PROOF state all match. Still missing: adaptive window tuning (EIFR-based), multi-segment, auto-compression, metadata, input_file streaming. Status enum now matches Python numbering except REJECTED. |
| `Transport.js` ↔ `RNS/Transport.py` | ~70% | Announce validation/forwarding, path table, dedup, link proof routing, and random_blob replay detection all work. Missing: path state machine, tunnel mode, control destinations (blackhole/instance/network/probe), shared instance, `await_path`. Gateway/boundary/AP modes are intentional edge-only divergence. |
| `lxmf/LXMRouter.js` ↔ `LXMF/LXMRouter.py` | ~75% | Delivery flows, peering subsystem (LXMPeer, peer()/unpeer(), auto-peering, /offer, distribution queue, outbound sync state machine, syncPeers), and storage-backed persistence for propagation entries + peers all work — verified end-to-end. Still missing: stamping/tickets, access control, peer rotation by acceptance rate, throttle tracking, control destination handlers. |
| `lxmf/LXMessage.js` ↔ `LXMF/LXMessage.py` | ~90% | Wire format byte-exact. Pack/unpack/signature/hash all match. Missing only: `RENDERER_BBCODE` constant, accessor helpers (`title_as_string` etc.), paper format (`as_uri`/`as_qr`), delivery system integration (intentionally in LXMRouter). |

**Interface layer** (`src/interfaces/*`): not audited. Known scope: JS has
`WebSocketInterface` (JS-only), `UDPInterface`, `TCPClient/Server`,
`LocalInterface`, `AutoInterface`. Missing vs. Python: I2P, AX25, Backbone,
KISS, Pipe, RNode variants, Serial, Weave — all intentional edge-device scope.

## Critical gaps (ranked)

### 1. ~~Resource transfer has no retry / watchdog loop~~ — FIXED

**Status**: Closed in the commit after the parity sweep.

**Result**: `ResourceSender` now handles three states in its watchdog
(`ADVERTISED` / `TRANSFERRING` / `AWAITING_PROOF`) with Python-matching
constants (`MAX_ADV_RETRIES=4`, `MAX_RETRIES=16`, `MAX_PROOF_RETRIES=3`,
`PART_TIMEOUT_FACTOR=4`, `PROOF_TIMEOUT_FACTOR=3`, `SENDER_GRACE_TIME=10s`,
`PROCESSING_GRACE=1s`, `RETRY_GRACE_TIME=0.25s`, `PER_RETRY_DELAY=0.5s`).
`ResourceReceiver` retries `_requestNext()` on part-timeout and shrinks the
window on each retry, matching Python `__watchdog_job()` lines 591-625.

Verified with `scripts/test-resource-retry-js.mjs` — a 64 KB transfer
survives 3 dropped RESOURCE part packets and recovers byte-exact in ~13 s
(vs a happy-path 30-40 ms).

Simplifications vs. Python: EIFR rate-based timing is approximated with
`RTT * outstanding_parts`; proof-cache-query on timeout is skipped because
JS Transport has no equivalent cache; `PART_TIMEOUT_FACTOR_AFTER_RTT` switch
is not implemented (stays at 4).

### 2. ~~Forward secrecy: no ratchet rotation or persistence~~ — FIXED

Port of Python's two-layer ratchet model:

**Destination-owned private ratchets** (`src/Destination.js`): new
`enableRatchets(storageKey, storage)`, `rotateRatchets()`,
`_persistRatchets()`, `_reloadRatchets()`, `enforceRatchets()`,
`setRetainedRatchets(n)`, `setRatchetInterval(s)`, plus `RATCHET_INTERVAL=30min`
and `RATCHET_COUNT=512` constants. Persisted list is signed with the
destination identity and verified on reload, matching Python
`RNS/Destination.py:205-540`.

**Identity class-level remote ratchets** (`src/Identity.js`):
`Identity.generateRatchet()`, `Identity.ratchetPublicBytes(priv)`,
`Identity.rememberRatchet(destHash, pub, {storage})`,
`Identity.getRatchet(destHash, {storage})`,
`Identity.cleanRatchets({storage})`, plus `Identity._knownRatchets` Map and
`Identity.RATCHET_EXPIRY = 30 days`. Mirrors Python
`RNS/Identity.py:94-363`.

**Persistence** (`src/utils/storage.js`): `saveDestinationRatchets` /
`loadDestinationRatchets` (signed envelope), `saveRemoteRatchet` /
`loadRemoteRatchet` / `cleanRemoteRatchets`.

**Announce wiring** (`src/Transport.js`): `_handleAnnounce` now calls
`Identity.rememberRatchet(destHash, ratchet)` when the validated announce
carries a ratchet.

Verified by 16 new unit tests covering: generate/publicBytes, remember/recall
round-trip, expiry, clean, destination rotate-skip-within-interval,
rotate-after-interval, persist+reload across instances, retain trim,
signature rejection, and a full end-to-end `announce → rememberRatchet →
getRatchet → encrypt → decrypt` loop.

Still not implemented from Python (intentional simplifications): file-scan
`_clean_ratchets` walks globally-persisted remote files (per-destination
API is sufficient for the current use); threading lock on ratchet file
writes (single-threaded JS).

### 3. ~~Identity.decrypt() tries only one ratchet~~ — FIXED

`decrypt(data, { ratchets, enforceRatchets, ratchetIdReceiver })` now walks
the supplied list, matches Python `RNS/Identity.py:713`, and populates the
ratchet id receiver with the result of `Identity.getRatchetId(pub)` on
success. Legacy single-ratchet callers (no options arg) still work via the
instance `_ratchetPriv`. Verified with 7 new unit tests covering the walk,
fall-back, enforce, and ratchet-id-receiver paths.

### 4. ~~LXMF: delivery_per_transfer_limit not enforced~~ — FIXED

JS now enforces `DELIVERY_LIMIT` on the receiver side (matching Python's
`delivery_resource_advertised` callback), using the new Link
`resource_strategy` infrastructure (gap #9). When a delivery link is
established, LXMRouter sets `ACCEPT_APP` with a callback that checks
`adv.dataSize` against `this.deliveryPerTransferLimit * 1000`. Oversize
resources are rejected via RCL, which the sender handles immediately.

Note: Python also doesn't broadcast `delivery_per_transfer_limit` in
delivery announces (only `[displayName, stampCost]`), so there's no
sender-side fail-fast on either platform — the limit is enforced only on
the receiver via the resource strategy callback.

### 5. ~~LXMF propagation peering subsystem absent~~ — IMPLEMENTED (core phases)

Ported across 4 phases (commits 7a755fa, 3326428, 796abff, cbdf68c):

**Phase 1 — LXMPeer data model**: Full `LXMPeer` class matching Python
`LXMF/LXMPeer.py` with state machine constants, sync strategies,
transfer stats, batching queues, and msgpack serialization compatible
with Python's format. Propagation entries now carry `handledPeers` /
`unhandledPeers` Sets for per-peer tracking.

**Phase 2 — peer()/unpeer() + auto-peering**: `peer()` creates or
updates LXMPeers with maxPeers / maxPeeringCost enforcement and
timebase-rollback protection. `unpeer()` with timestamp guard.
Propagation announces are auto-parsed via Transport 'announce' events
and turned into peer relationships (matches Python's
LXMFPropagationAnnounceHandler). Also fixed a latent
`announcePropagation()` bug where timebase was hardcoded to 0.

**Phase 3 — Receiving side**: `/offer` handler matching Python
`offer_request()` (accepts `[peeringKey, [transientIds]]`, returns
true/false/subset). Peer distribution queue
(`enqueuePeerDistribution` / `flushPeerDistributionQueue`) fans stored
messages out to all peers except the source. LXStamper gained
`generatePeeringKey` / `validatePeeringKey` for PoW-based
authentication. Also fixed a latent bug: `_propagationLinkEstablished`
was calling `link.onRequest` which doesn't exist — switched to
`registerRequestHandler`, so the `/get` client path now actually works.

**Phase 4 — Outbound sync**: `LXMPeer.sync()` as an async state machine
(IDLE → LINK_ESTABLISHING → LINK_READY → REQUEST_SENT → RESPONSE_RECEIVED
→ RESOURCE_TRANSFERRING → IDLE). Builds offers respecting transfer and
sync limits, sends peering key, interprets true/false/subset responses,
packs wanted messages into a Resource, and on completion moves them to
handled. Persistent strategy re-syncs when more work remains.
`LXMRouter.syncPeers()` picks the best IDLE peer with pending work;
wired into a 30-second sync loop alongside the distribution flush.

**Verified with a full end-to-end integration test** (test/lxmf-peer-sync.test.js):
two wired propagation nodes exchange announces, auto-peer, one stores
a message, and the other receives it via a full sync round-trip
(link → /offer → resource → proof).

**Still deferred to Phase 5** (feature/ops work, not correctness):
- Peer rotation by acceptance rate
- Throttle tracking / `clean_throttled_peers`
- Control-destination handlers (`/pn/get/stats`, `/pn/peer/sync`,
  `/pn/peer/unpeer`)
- Peer persistence to storage across restarts
- Auto-peering from incoming sync from unknown peer

**Simplifications vs Python**:
- No `link.identify()` (JS Link lacks identify()), so identity-based
  access control is skipped. Peering works with peeringCost=0.
- No stamp_cost filtering on the sender (assumes stamp_cost=0).
- Fastest-N random pool reduced to first-by-transfer-rate selection.

### 6. ~~LXMF propagation message store is in-memory only~~ — FIXED

`Storage` gained `savePropagationEntry` / `loadPropagationEntries` /
`deletePropagationEntry` and `savePeer` / `loadPeers` / `deletePeer`.
Each propagation entry is persisted under
`storage/propagation/messages/<tidHex>` as a msgpack record with the
destination hash, data blob, received timestamp, size, stamp value,
and the `handledPeers` / `unhandledPeers` hex sets (so sync state
survives restart). Each peer is persisted under
`storage/propagation/peers/<destHex>` via `LXMPeer.toBytes()`.

`LXMRouter.enablePropagation()` became async and loads both entries
and peers from storage on startup. Persistence is wired into
`_lxmfPropagation` (store path), `_pruneOldestMessages`,
`expireMessages`, `_messageGetRequest` (client purge), `peer()` /
`unpeer()`, and post-sync state updates in `LXMPeer.sync()` so the
in-memory state and on-disk state stay consistent.

Verified with 10 new tests covering Storage round-trips for entries
and peers, full router restart with messages + peers intact, prune
deletes from disk, `unpeer()` deletes the peer record, and round-trip
of peer relationships (handled/unhandled sets) across restart.

### 7. ~~Resource: no AWAITING_PROOF state~~ — FIXED

Rolled into the watchdog fix above. `ResourceSender.handleRequest()` now
transitions to `RESOURCE_AWAITING_PROOF` when `sentParts >= totalParts`, and
the watchdog enforces `PROOF_TIMEOUT_FACTOR * rtt + SENDER_GRACE_TIME`.

### 8. ~~Transport: no `random_blobs` list per path~~ — FIXED

Path table entries now carry a `randomBlobs` array (capped at 64, matching
Python `MAX_RANDOM_BLOBS`). On each announce, the blob is checked against
the existing list — if already seen, the announce is rejected as a replay.
New blobs are appended and the list is capped. Also added
`_timebaseFromBlobs()` which extracts the max emission timestamp from the
blob list (matching Python `timebase_from_random_blobs`), used to compare
whether a new announce is actually more recent than the current best path.

### 9. ~~Link: no `resource_strategy` filtering~~ — FIXED

Added `ACCEPT_NONE` (default), `ACCEPT_APP`, `ACCEPT_ALL` constants and
`setResourceStrategy()` / `setResourceCallback()` methods matching Python
`RNS/Link.py:120-122,1296`. `_handleResourceAdv` now dispatches:
- `ACCEPT_NONE` → silently ignore
- `ACCEPT_APP` → call callback with `{dataSize, totalParts, hash, link}`;
  return true to accept, false to reject (sends RCL)
- `ACCEPT_ALL` → auto-accept

LXMF uses `ACCEPT_APP` for delivery links (gap #4).

### 10. ~~Link: no RequestReceipt API~~ — FIXED

`RequestReceipt` class added with SENT/DELIVERED/RECEIVING/READY/FAILED
states, `onResponse`/`onFailed`/`onProgress` callbacks, and
`getResponse()`/`getStatus()` accessors matching Python
`RNS/Link.py:1349-1542`. `link.request()` now returns a Promise with a
`.receipt` property — `await link.request(...)` still resolves to response
data for backward compatibility, while `link.request(...).receipt` gives
the full state machine. Receipts are failed automatically on link teardown.

---

## Per-file details

Full per-file audit reports are retained in `docs/dev/python-parity-details/`
(one file per subsystem) for reference when tackling specific gaps. This
top-level file is the index and the ranked critical-gap list.

## Recommended next steps

1. **Close out task #38** with a note that single-segment is sufficient for
   LXMF at default limits, multi-segment deferred.
2. **LXMF Finding #2** — small, self-contained, unblocks the 1 MB case with a
   clear error instead of the RCL round-trip.
3. **Resource watchdog/retry loop** — biggest reliability win; matches Python
   closely; self-contained within `Resource.js`.
4. **Ratchet rotation + persistence** — restores forward secrecy, biggest
   security win.
5. **Identity multi-ratchet decrypt** — small change, fixes a latent decrypt
   failure mode.
6. **Link resource_strategy + LXMF ACCEPT_APP wiring** — small, pairs well
   with Finding #2.
7. **Transport random_blob list** — small, closes replay window.

Larger items (LXMF propagation peering, persistent message store, LXMPeer
class, Channel integration, RequestReceipt API) can be scheduled as their own
tracks; none are blocking current interop.
