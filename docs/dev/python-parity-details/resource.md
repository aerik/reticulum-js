# Resource.js vs RNS/Resource.py — Parity Detail

Source: parallel audit agent, 2026-04-11.

## Summary

Core wire protocol (advertisement, parts, HMU, proof) matches after commit
9180b98 fixes. Missing: the entire watchdog/retry infrastructure, adaptive
window tuning, AWAITING_PROOF state tracking, auto-compression (task #39),
multi-segment (task #38), metadata, input_file streaming.

Known issues documented separately in `docs/resource-transfer-issues.md` are
not re-reported here.

## Symbol table

### Window tuning

| Symbol | Status | Notes |
|--------|--------|-------|
| WINDOW_INITIAL | MATCHED | 4 |
| WINDOW_MIN_INITIAL | MATCHED | 2 |
| WINDOW_MAX_SLOW | MATCHED | 10 |
| WINDOW_MAX_FAST | MATCHED | 75 |
| WINDOW_FLEXIBILITY | MATCHED | 4 |
| WINDOW_MAX_VERY_SLOW | MISSING | Python caps at 4 for very slow links |
| FAST_RATE_THRESHOLD / VERY_SLOW_RATE_THRESHOLD | MISSING | No adaptive window scaling |
| RATE_FAST / RATE_VERY_SLOW | MISSING | Thresholds for adaptation (50 Kbps / 2 Kbps) |

### Hashmap / collision

| Symbol | Status | Notes |
|--------|--------|-------|
| MAPHASH_LEN | MATCHED | 4 |
| RANDOM_HASH_SIZE | MATCHED | 4 |
| HASHMAP_MAX_LEN | MATCHED | 74 |
| COLLISION_GUARD_SIZE | MISSING | Python: `2*WINDOW_MAX + HASHMAP_MAX_LEN`. JS searches entire parts array on request → O(n) |

### Size caps

| Symbol | Status |
|--------|--------|
| MAX_EFFICIENT_SIZE | MISSING (task #38) |
| AUTO_COMPRESS_MAX_SIZE | MATCHED | 64 MiB; exported from Resource.js |

### Retry / timeout

| Symbol | Status | Notes |
|--------|--------|-------|
| PART_TIMEOUT_FACTOR | MATCHED | 4 |
| PART_TIMEOUT_FACTOR_AFTER_RTT | MISSING | No RTT-based switch — stays at 4 |
| PROOF_TIMEOUT_FACTOR | MATCHED | 3 |
| MAX_RETRIES | MATCHED | 16 |
| MAX_ADV_RETRIES | MATCHED | 4 |
| MAX_PROOF_RETRIES | MATCHED | 3 |
| SENDER_GRACE_TIME / PROCESSING_GRACE / RETRY_GRACE_TIME | MATCHED | Same values |
| PER_RETRY_DELAY | MATCHED | 0.5 |
| WATCHDOG_INTERVAL | MATCHED | 1s (Python's WATCHDOG_MAX_SLEEP) |

### States

| Symbol | Status | Notes |
|--------|--------|-------|
| NONE | MATCHED | 0x00 |
| QUEUED | MATCHED | 0x01 (added with watchdog) |
| ADVERTISED | MATCHED | 0x02 (renamed from ADVERTISING) |
| TRANSFERRING | MATCHED | 0x03 |
| AWAITING_PROOF | MATCHED | 0x04 (added with watchdog) |
| ASSEMBLING | MATCHED (constant) | 0x05 — state exists but receiver still transitions straight to COMPLETE inside `_verifyAndComplete`. Not yet used as an intermediate step. |
| COMPLETE | MATCHED | 0x06 |
| FAILED | MATCHED | 0x07 |
| CORRUPT | MATCHED (constant) | 0x08 — defined but receiver still uses FAILED on hash mismatch |
| REJECTED | MATCHED | 0x09 in JS (Python uses 0x00 — see Resource.js note) |

### Advertisement

| Symbol | Status | Notes |
|--------|--------|-------|
| Pack (msgpack keys t, d, n, h, r, o, i, l, q, f, m) | MATCHED | |
| Flag bits (encrypted, compressed, split, is_request, is_response, has_metadata) | MATCHED (parsed) | has_metadata unpacked but unused |
| reject() static | MATCHED | Sends RESOURCE_RCL |
| accept() static | PARTIAL | JS only in Link layer, minimal |

### Send/receive flow

| Symbol | Status | Notes |
|--------|--------|-------|
| advertise() / _advertise_job | MATCHED | Watchdog retries adv up to MAX_ADV_RETRIES |
| assemble() / _assemble() | MATCHED | Calls prove() on success (9180b98) |
| prove() / sendProof() | MATCHED (9180b98) | |
| validate_proof (sender-side) | MATCHED | handleProof + AWAITING_PROOF state transition |
| receive_part / receivePart | MATCHED | Identify by map_hash, grow window |
| request_next / _requestNext | MATCHED | Windowed requesting with exhaustion flag |
| request / handleRequest | MATCHED | Parse, send parts, send HMU if exhausted |
| cancel() (initiator) | MATCHED (9180b98) | Sends RESOURCE_ICL |
| cancel() (receiver) | MATCHED (9180b98) | |
| _rejected() | MATCHED (9180b98) | |
| hashmap_update / _applyHashmapUpdate | MATCHED | |
| hashmap_update_packet / handleHashmapUpdate | MATCHED | |
| get_map_hash / computeMapHash | MATCHED | SHA256(part + randomHash)[0:4] |
| Encryption (full stream, not per-packet) | MATCHED | |
| Compression (bz2) | PARTIAL | Sender path fully wired: `autoCompress` option, size limit check, "only use compressed if smaller" decision, FLAG_COMPRESSED flag bit, hash computed on uncompressed data. A `compressBz2(data)` encoder must be registered via `setCompressor()` in src/utils/compress.js — no bz2 encoder bundled. Receiver-side decompression has always worked (seek-bzip vendored decoder). |
| Metadata support | PARTIAL | FLAG unpacked, never used |
| Multi-segment (split) | MISSING (task #38) | |
| watchdog_job / threading | MATCHED | setInterval-based; same state-branch logic as Python's __watchdog_job |
| Progress tracking / callback | MATCHED | |

## Critical gaps

1. ~~**No watchdog/retry loop**~~ — **FIXED**. Sender handles ADVERTISED /
   TRANSFERRING / AWAITING_PROOF branches with adv-retry, global max-wait,
   and proof-wait cancel. Receiver retries `_requestNext()` on part-timeout
   with window shrink and bounded retries. Verified with
   `scripts/test-resource-retry-js.mjs` — 64 KB transfer survives 3 dropped
   parts and recovers in ~13 s.
2. ~~**Sender doesn't track AWAITING_PROOF**~~ — **FIXED**. State transition
   added in `handleRequest` when `sent_parts == total_parts`.
3. **No adaptive window tuning** — fixed WINDOW_MAX_SLOW (10) on all links;
   Python would drop to 4 on very slow links.
4. **Collision guard unused** — linear scan on each request over the entire
   parts array. Slow for large transfers.
5. **EIFR / rate-based timing not ported** — JS uses an RTT × outstanding-parts
   approximation for the receiver-side timeout. Python's EIFR math is more
   accurate on lossy links.
6. **CORRUPT / ASSEMBLING states defined but unused** — receiver still
   transitions directly from TRANSFERRING to COMPLETE or FAILED. Not
   observable to callers but diverges from Python's fine-grained lifecycle.

## Verdict

**Happy-path parity is restored by 9180b98.** The remaining gaps affect
reliability (lossy links, slow links) and adaptability, not basic interop.
Watchdog/retry is the next correctness-critical item.
