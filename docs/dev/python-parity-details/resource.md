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
| AUTO_COMPRESS_MAX_SIZE | MISSING (task #39) |

### Retry / timeout

| Symbol | Status | Notes |
|--------|--------|-------|
| PART_TIMEOUT_FACTOR | MISSING | No receiver-side part retry |
| PART_TIMEOUT_FACTOR_AFTER_RTT | MISSING | No RTT-based scaling |
| PROOF_TIMEOUT_FACTOR | MISSING | Sender uses global 120s, not proof-phase timeout |
| MAX_RETRIES | MISSING | Python: 16 |
| MAX_ADV_RETRIES | MISSING | Python: 4 |
| SENDER_GRACE_TIME / PROCESSING_GRACE / RETRY_GRACE_TIME | MISSING | No grace constants |
| PER_RETRY_DELAY | MISSING | No per-retry delay |
| WATCHDOG_MAX_SLEEP | MISSING | No watchdog job |

### States

| Symbol | Status | Notes |
|--------|--------|-------|
| NONE | MATCHED | |
| ADVERTISING (JS) vs QUEUED/ADVERTISED (Py) | PARTIAL | JS collapses QUEUED+ADVERTISED into ADVERTISING |
| TRANSFERRING | MATCHED | |
| AWAITING_PROOF | MISSING | JS doesn't transition after last part sent |
| ASSEMBLING | MISSING | JS goes directly to COMPLETE |
| COMPLETE | MATCHED | |
| FAILED | MATCHED | |
| CORRUPT | MISSING | JS uses FAILED instead |
| REJECTED | MATCHED (added 9180b98) | |

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
| advertise() / _advertise_job | PARTIAL | JS one-shot; Python retries on watchdog |
| assemble() / _assemble() | MATCHED | Calls prove() on success (9180b98) |
| prove() / sendProof() | MATCHED (9180b98) | |
| validate_proof (sender-side) | PARTIAL | handleProof exists but sender never transitions AWAITING_PROOF |
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
| Compression (bz2) | MISSING (task #39) | |
| Metadata support | PARTIAL | FLAG unpacked, never used |
| Multi-segment (split) | MISSING (task #38) | |
| watchdog_job / threading | MISSING | No background monitor |
| Progress tracking / callback | MATCHED | |

## Critical gaps

1. **No watchdog/retry loop** — see parity doc gap #1.
2. **Sender doesn't track AWAITING_PROOF** — see parity doc gap #7.
3. **No adaptive window tuning** — fixed WINDOW_MAX_SLOW (10) on all links;
   Python would drop to 4 on very slow links.
4. **Collision guard unused** — linear scan on each request over the entire
   parts array. Slow for large transfers.
5. **State enum divergence** — Python has 9 states, JS has 6. Not a wire
   issue; matters only if external code inspects status values.

## Verdict

**Happy-path parity is restored by 9180b98.** The remaining gaps affect
reliability (lossy links, slow links) and adaptability, not basic interop.
Watchdog/retry is the next correctness-critical item.
