# Resource Transfer Issues — Investigation Notes

Investigation date: 2026-04-10
Triggering question: "Why does a 1 MB LXMF DIRECT send to Python LXMF fail with
`Link closed during resource transfer` while 30/100/500 KB succeed?"

## Status (2026-04-11)

- **Finding 1 (RCL handling) — FIXED.** Sender now recognises inbound
  `RESOURCE_RCL` packets and rejects `sendResource()` immediately with
  `"Resource rejected by receiver (possibly exceeds delivery limit)"`.
  Also wired `RESOURCE_ICL` handling on the receiver side. Verified with
  `scripts/test-resource-reject-js.mjs` — reject path completes in ~15ms.
- **Finding 3 (missing sendProof) — FIXED.** `ResourceReceiver._verifyAndComplete`
  now calls `sendProof()` after successful verification, matching Python's
  `Resource.assemble()` which calls `self.prove()` at COMPLETE. Verified with
  `scripts/test-big-resource-js.mjs` — 500KB/1MB pure-JS transfers complete in
  a few hundred ms (previously timed out at 120s).
- **Finding 2 (delivery_limit fail-fast) — STILL OPEN.** Not yet wired.

## TL;DR (historical)

Three distinct bugs were uncovered while investigating the 1 MB failure. The
1 MB failure itself is *not* a bug in our sender — it's a Python LXMF-side
hard limit that we were silently hitting because we didn't respect the
receiver's advertised limit and didn't handle the explicit rejection packet
Python sends back.

1. **[Sender] We don't handle `CONTEXT_RESOURCE_RCL`** — Python tells us
   "resource rejected," we ignore it, wait ~20 s, then the link dies.
2. **[Sender] We don't check the receiver's LXMF `delivery_limit`** — Python
   broadcasts this in its LXMF announce app_data; we should fail-fast before
   even opening the link.
3. **[Receiver] Our `Link._handleResourceAdv` never calls `receiver.sendProof()`**
   after assembling a resource. JS-to-JS Resource transfers therefore always
   time out on the sender side. (This works in Python-interop only because
   Python-as-receiver sends the proof itself.)

## Root cause of the reported 1 MB failure

Python LXMF's delivery path installs an `ACCEPT_APP` resource callback on
every delivery link that rejects oversized transfers:

```python
# .venv/Lib/site-packages/LXMF/LXMRouter.py:1861
def delivery_resource_advertised(self, resource):
    size = resource.get_data_size()
    limit = self.delivery_per_transfer_limit*1000
    if limit != None and size > limit:
        RNS.log("Rejecting ... exceeds the limit of ...", RNS.LOG_DEBUG)
        return False
    else:
        return True
```

The default is `DELIVERY_LIMIT = 1000` (file: `LXMF/LXMRouter.py:56`), so
`limit = 1000 * 1000 = 1,000,000 bytes ≈ 977 KB`.

Our 1 MB test message packs to **1,048,701 bytes** (message body +
LXMF header), which exceeds the cap by ~48 KB. Empirical results:

| Size   | Packed bytes | Result    |
|--------|-------------:|-----------|
| 30 KB  |       30,893 | DELIVERED |
| 100 KB |      102,765 | DELIVERED |
| 500 KB |      512,125 | DELIVERED |
| 1 MB   |    1,048,701 | FAILED    |

When the LXMF callback returns `False`, `RNS.Resource.reject(packet)` is
called. That function sends a `RESOURCE_RCL` packet back to the sender *and
returns silently* — no info-level log. That's why we never see an "Accepting
resource advertisement" line on the Python side for the 1 MB attempts.

Then 20 seconds later Python's link watchdog (or keepalive path) closes the
idle link with `destination_closed`, which is what our sender sees.

## Finding 1 — we don't handle `CONTEXT_RESOURCE_RCL`

`src/constants.js:117` defines `CONTEXT_RESOURCE_RCL = 0x07` (matching
Python's `RNS.Packet.RESOURCE_RCL = 0x07` in `RNS/Packet.py:79`).
`src/Resource.js:28` imports it. But **nothing in the codebase actually
handles an inbound RESOURCE_RCL packet**. Verified by
`grep -rnE "RESOURCE_RCL" src/` — only the constant definition and the
unused import.

Consequence: when Python rejects a resource, we don't notice. `sendResource`
just keeps waiting for a `RESOURCE_REQ` that will never come, until the
`timeoutMs` (120 s) fires or the peer tears the link down. Currently the
link-teardown happens first at ~20 s, so the user sees
`Link closed during resource transfer` instead of the real reason.

**Fix shape**: extend `Link._handleInbound` (or wherever link-context data
packets are dispatched) to recognise `CONTEXT_RESOURCE_RCL`. The packet
payload is the resource hash (see Python `Resource.reject` in
`RNS/Resource.py:154`). On receipt:

1. Look up the outgoing resource by hash in `link._outgoingResources`.
2. Reject its promise with a clear error:
   `Error('Resource rejected by receiver (possibly exceeds delivery limit)')`
3. Remove it from the map.

Should also handle the symmetric `CONTEXT_RESOURCE_ICL = 0x06` (initiator
cancel) on the receiver side so in-flight incoming resources get cleaned up
when the sender cancels mid-transfer.

## Finding 2 — we don't respect the receiver's `delivery_limit`

Python LXMF announces advertise the receiver's `delivery_limit` in
`app_data`. See `LXMF/LXMRouter.py:790` and `:1535`:

```python
# Peered config carries the limit the remote will accept
[wants, haves, self.delivery_per_transfer_limit]
```

Our sender side (`src/lxmf/LXMRouter.js`) never reads this — it happily tries
to send anything, and the user finds out the message was too big only when
the link dies 20 s later.

**Fix shape**: when we receive an LXMF announce from a delivery destination,
parse the advertised `delivery_limit` (in KB) and stash it on the cached
announce entry. In `LXMRouter.handleOutbound`, before choosing DIRECT/RESOURCE,
check `message.packed.length > limit*1000` and fail-fast with
`Error('Message exceeds recipient delivery limit: <size> > <limit> bytes')`.

Exact app_data layout to confirm when implementing — easiest path is to
capture a real Python announce and inspect the msgpack.

## Finding 3 — JS receiver never sends `RESOURCE_PRF` after assembly

`src/Link.js:574` handles inbound `CONTEXT_RESOURCE_ADV` by creating a
`ResourceReceiver`, wiring up `onComplete` to emit `resource_complete` /
resolve a pending request, and calling `receiver.accept()`. What it **never
does** is call `receiver.sendProof()`.

`ResourceReceiver.sendProof()` exists in `src/Resource.js:637` and is
correctly implemented (sends a `PACKET_PROOF` with `CONTEXT_RESOURCE_PRF`
containing `resource_hash + sha256(data + resource_hash)`), but it is *never
called by anyone* in the codebase. Verified by
`grep -n "sendProof" src/`.

Consequence: a pure-JS resource transfer (`initiatorLink.sendResource(data)`
→ `responderLink` auto-accept) ends with the receiver fully assembling and
verifying the data, but the **sender times out** waiting for a proof that
nobody sent. Reproduced with `scripts/test-big-resource-js.mjs 500`:

```
[Resource] Resource assembled and verified: 512000 bytes
[Link] Resource complete: 512000 bytes, requestId=null, pendingRequests=0
FAILED in 120036ms: Resource transfer timeout after 120000ms
```

Python-interop happens to work because Python-as-receiver has its own
proof-sending path (`RNS/Resource.py` — `__receive_job` → `send_proof`), so
we never noticed this bug in end-to-end tests.

**Fix shape**: in `Link.js:581` inside the `receiver.onComplete` callback,
after the request-response/generic-emit branching, unconditionally call
`receiver.sendProof()`. (Or more precisely: call it whenever the resource
verified successfully, `receiver.status === RESOURCE_COMPLETE`.)

## Recommendation on task #38 (multi-segment Resource sending)

Multi-segment won't help the reported 1 MB failure. Python's LXMF callback
inspects `resource.get_data_size()` which is the *total* logical data size
regardless of segmentation, so chopping the payload into segments doesn't
move the cap.

Single-segment transfers work cleanly up to ~977 KB against default-configured
Python LXMF. For interop with Python LXMF that's the effective limit; to go
higher the receiver has to raise `delivery_limit` themselves.

Multi-segment is still a real missing feature for non-LXMF resource transfers
(and for LXMF if we eventually tune the limit up). But it's not blocking the
user-visible 1 MB failure, and shouldn't be the next thing worked on unless
we're willing to also investigate Python's segment-handling end-to-end.

Suggested course:
- Mark task #38 findings in its description: "single-segment verified to
  977 KB against default Python LXMF; multi-segment deferred as it doesn't
  help the observed failure."
- Prioritise findings #1 and #3 above — they're small, self-contained
  correctness bugs that can land as a single PR.
- Finding #2 is the "proper fix" for the user-facing symptom (graceful
  fail-fast with a clear error). Do after #1 lands.
- Then move on to task #39 (Resource compression on send) which is still
  useful and independent.

## Files referenced in this investigation

- `src/lxmf/LXMRouter.js` — our sender-side LXMF router
- `src/Link.js:574` — `_handleResourceAdv` (needs sendProof call)
- `src/Link.js:873` — `_handlePacketProof` (already routes `CONTEXT_RESOURCE_PRF`)
- `src/Link.js:1014` — `_handleResourceProof` (already calls `sender.handleProof`)
- `src/Resource.js:637` — `ResourceReceiver.sendProof` (defined, never called)
- `src/constants.js:116-117` — `CONTEXT_RESOURCE_ICL/RCL` (defined, not wired)
- `.venv/Lib/site-packages/LXMF/LXMRouter.py:56` — `DELIVERY_LIMIT = 1000`
- `.venv/Lib/site-packages/LXMF/LXMRouter.py:1846` — `delivery_link_established`
- `.venv/Lib/site-packages/LXMF/LXMRouter.py:1861` — the limit check
- `.venv/Lib/site-packages/RNS/Resource.py:154` — `Resource.reject` (sends `RCL`)
- `.venv/Lib/site-packages/RNS/Link.py:1069` — routing `RESOURCE_ADV` through strategy

## Repro commands used during investigation

```bash
# JS-to-Python direct send (runs against test-lxmf-recv.py in --listen mode):
node scripts/big-send.mjs <recv_delivery_hash> 1024   # 1 MB → FAILED
node scripts/big-send.mjs <recv_delivery_hash> 500    # 500 KB → DELIVERED

# Pure JS-to-JS resource test (exposed finding #3):
node scripts/test-big-resource-js.mjs 500             # FAILED: timeout after 120s

# Measure the advertisement packet size (all sizes yield 413 bytes, so adv
# size is NOT the issue — the cap is purely on data_size):
node scripts/measure-adv-size.mjs
```
