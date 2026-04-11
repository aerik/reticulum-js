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
| `Identity.js` ↔ `RNS/Identity.py` | ~75% | Crypto primitives match exactly (HKDF/AES/Ed25519/X25519). Announce validation lives in `Announce.js` not Identity. No `recall()`/`remember()` (uses `Transport.announceTable`). **Multi-ratchet decrypt missing** — JS tries only one ratchet. |
| `Destination.js` ↔ `RNS/Destination.py` | ~40% | Skeleton: hash, callbacks, name expansion. `announce()` is in `src/Announce.js` (architectural split). **No ratchet management**, **no request handlers**, **no `encrypt()`/`decrypt()` dispatch**, **no `incoming_link_request()`**, **no GROUP destination support**. |
| `Link.js` ↔ `RNS/Link.py` | ~85% | Handshake, encryption, watchdog, STALE/TIMEOUT, RCL/ICL/PRF dispatch all correct. Missing: `RequestReceipt` API, resource strategy, MDU calc, mode negotiation, Channel, physical stats, `identify()`. |
| `Resource.js` ↔ `RNS/Resource.py` | ~70% | Advertisement/parts/HMU/proof all match after the 9180b98 fixes. **No watchdog/retry loop.** No adaptive window tuning. No `AWAITING_PROOF` state. No multi-segment, no auto-compression, no metadata, no input_file streaming. Status enum values diverge (JS has 6, Python has 9). |
| `Transport.js` ↔ `RNS/Transport.py` | ~65% | Announce validation/forwarding, path table, dedup, link proof routing work. Missing: `random_blobs` list per path (replay window), path state machine, tunnel mode, control destinations (blackhole/instance/network/probe), shared instance, `await_path`. Gateway/boundary/AP modes are intentional edge-only divergence. |
| `lxmf/LXMRouter.js` ↔ `LXMF/LXMRouter.py` | ~35% | Delivery flows (OPPORTUNISTIC/DIRECT/PROPAGATED) and basic propagation storage work. **Propagation peering subsystem entirely absent** (~40% of Python): no LXMPeer, no `peer()/unpeer()/sync_peers`, no offer protocol, no peer rotation. Also missing: message persistence (in-memory only), stamping/tickets, access control, delivery-limit broadcast in announce (Finding #2). |
| `lxmf/LXMessage.js` ↔ `LXMF/LXMessage.py` | ~90% | Wire format byte-exact. Pack/unpack/signature/hash all match. Missing only: `RENDERER_BBCODE` constant, accessor helpers (`title_as_string` etc.), paper format (`as_uri`/`as_qr`), delivery system integration (intentionally in LXMRouter). |

**Interface layer** (`src/interfaces/*`): not audited. Known scope: JS has
`WebSocketInterface` (JS-only), `UDPInterface`, `TCPClient/Server`,
`LocalInterface`, `AutoInterface`. Missing vs. Python: I2P, AX25, Backbone,
KISS, Pipe, RNode variants, Serial, Weave — all intentional edge-device scope.

## Critical gaps (ranked)

### 1. Resource transfer has no retry / watchdog loop  *(reliability)*

**Impact**: On lossy or slow links a single dropped packet causes the whole
transfer to wait out the 120 s global timeout. Python retries up to 16 parts
(`MAX_RETRIES`), 4 advertisements (`MAX_ADV_RETRIES`), with `PER_RETRY_DELAY`
(0.5 s) and `SENDER_GRACE_TIME` (10 s), plus a `watchdog_job` daemon thread.
JS has none of this.

**Files**: `src/Resource.js` — no watchdog, no retry counters, no
`PART_TIMEOUT_FACTOR` etc.

**Fix shape**: add a watchdog interval on `ResourceSender` that tracks
`lastProgressAt`, retries unacked parts, and escalates to rejection on
max-retries. Separate watchdog on `ResourceReceiver` that times out outstanding
part requests. Port the constants block from `RNS/Resource.py:130-190`.

### 2. Forward secrecy: no ratchet rotation or persistence  *(crypto)*

**Impact**: JS reads ratchet pubkeys out of announces and can encrypt *to* a
ratcheted peer, but never rotates its own ratchet, never persists ratchet keys
across restarts, and has no `enforce_ratchets` mode. Every restart = same base
key forever. A compromise of the base private key decrypts all past traffic.

**Files**: `src/Identity.js` has `rotateRatchet()` as a manual instance method
only. `src/Destination.js` has no `enable_ratchets()`, `set_ratchet_interval()`,
or `_persist_ratchets()`. No `known_ratchets` static store anywhere.

**Fix shape**: port Python's `Destination.enable_ratchets()` +
`rotate_ratchets()` + `_persist_ratchets()` (uses umsgpack to
`storage/ratchets/{hash}`), plus the 30-day `RATCHET_EXPIRY`. Wire
`rotate_ratchets()` into the announce path so each announce carries a fresh
ratchet when due.

### 3. Identity.decrypt() tries only one ratchet  *(interop reliability)*

**Impact**: Python's `decrypt(ciphertext, ratchets=[list], enforce_ratchets,
ratchet_id_receiver)` walks a list of known ratchets until one works. JS only
tries `_ratchetPriv` then the base key. If a peer rotated ratchets rapidly and
sent a few messages under different ratchets, JS decrypts zero or one.

**Files**: `src/Identity.js:decrypt()`.

**Fix shape**: accept a ratchets list, iterate trying each, optionally enforce
(fail if base-key decryption is the only one that works).

### 4. LXMF: sender doesn't check receiver `delivery_per_transfer_limit`  *(known: Finding #2)*

Already tracked in `docs/resource-transfer-issues.md`. Short version: Python
LXMF rejects oversize resources with RCL (which the Link layer now handles
correctly as of 9180b98), but the fail-fast path — parsing the receiver's
advertised limit out of their LXMF announce app_data and erroring before even
opening the link — is not implemented. Also, JS's own announce doesn't include
its delivery_limit, so Python peers sending to JS can't fail-fast either.

**Files**: `src/lxmf/LXMRouter.js` — both sides (`handleOutbound` and
`announceDelivery`).

### 5. LXMF propagation peering subsystem absent  *(feature)*

**Impact**: JS can act as a client of a propagation node (`/get` works), and
can act as a basic propagation node itself (in-memory store). It cannot peer
with other propagation nodes: no offer protocol, no sync strategies, no peer
rotation, no LXMPeer class, no propagation cost negotiation. A JS propagation
node is effectively a leaf — messages only flow in from clients, never to
other nodes.

**Files**: `src/lxmf/LXMRouter.js`. No equivalent of `LXMPeer.py`.

**Fix shape**: large. Port `LXMPeer` class first, then `peer()`/`unpeer()`,
then offer-protocol handlers (`/pn/peer/sync` etc.), then the distribution
queue. This is ~40% of Python LXMRouter's line count.

### 6. LXMF propagation message store is in-memory only  *(data-loss)*

**Impact**: JS propagation store lives in Maps. Process restart = every
propagated message gone. Python uses `messagestore/` directory with filename
encoding for timestamp + stamp value, atomic replace on write.

**Files**: `src/lxmf/LXMRouter.js:enablePropagation()` and friends.

**Fix shape**: add a storage-backed propagation store with the same
filename/scoring convention as Python, so a node can be restarted without
losing queued messages.

### 7. Resource: no AWAITING_PROOF state / wrong sender-side timeout  *(correctness)*

**Impact**: `ResourceSender.handleProof()` exists but the sender doesn't
transition to `AWAITING_PROOF` after sending the last part; it just waits on
the generic 120 s link timeout. Python uses a separate `PROOF_TIMEOUT_FACTOR`
(3×RTT-ish) for this phase so failures are detected ~10× faster.

**Files**: `src/Resource.js:ResourceSender`, `src/Link.js:sendResource()`.

### 8. Transport: no `random_blobs` list per path  *(replay-window)*

**Impact**: Python stores the last N `random_blobs` per path entry
(`IDX_PT_RANDBLOBS`) so it can compute `timebase_from_random_blobs` and reject
replayed announces. JS parses the current `random_blob` from each announce but
doesn't retain history.

**Files**: `src/Transport.js:validateAnnounce` and announce table schema.

**Fix shape**: widen the announce-table entry to carry a bounded list of recent
blobs, add Python's replay check.

### 9. Link: no `resource_strategy` filtering  *(feature)*

**Impact**: JS auto-accepts every inbound resource. Python supports
`ACCEPT_NONE`, `ACCEPT_APP` (callback), `ACCEPT_ALL`. LXMF uses ACCEPT_APP to
enforce its delivery limit. JS has no equivalent, so even if JS implements
Finding #2 above, a hostile peer can still burn bandwidth by sending resources
that the JS application doesn't want.

**Files**: `src/Link.js:_handleResourceAdv`.

### 10. Link: no RequestReceipt API  *(feature)*

**Impact**: High-level `link.request(path, data, callback, timeout)` →
`RequestReceipt` doesn't exist. Callers have to emit RESOURCE-tagged data
manually. Python's receipt tracks SENT / DELIVERED / READY / FAILED states.

**Files**: `src/Link.js` — no `request()` method, no `RequestReceipt` class.

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
