# Transport.js vs RNS/Transport.py — Parity Detail

Source: parallel audit agent, 2026-04-11.

## Summary

reticulum-js Transport is a **simplified, edge-node-focused port** with core
routing infrastructure present. Announce forwarding, path tables, dedup, and
link proof routing are implemented. Missing: server-side transport modes,
tunnel support, control destinations beyond path_request, shared-instance
detection, path state machine, `random_blobs` list per path. Most missing
pieces are intentional edge-only divergence.

## Symbol table (condensed)

### Constants & modes

| Symbol | Status | Notes |
|--------|--------|-------|
| BROADCAST (0x00) / TRANSPORT (0x01) | MATCHED | |
| RELAY (0x02) | JS-ONLY | Defined in constants but unused |
| TUNNEL (0x03) | MISSING | Constant defined, no implementation |
| MODE_TRANSPORT / GATEWAY / BOUNDARY / AP | MISSING | Edge-only — intentional divergence |

### Path table & tables

| Symbol | Status | Notes |
|--------|--------|-------|
| path_table | MATCHED | destHex → {timestamp, nextHop, hops, expires, interface, announcePacketHash} |
| IDX_PT_* tuple indices | PARTIAL | JS uses object properties |
| reverse_table | MATCHED | For proof routing |
| announceTable / announce_table | MATCHED | identity + appData cache |
| linkTable (active_links) | MATCHED | by link_id hash |
| pendingLinks | MATCHED | awaiting proof |

### Announce handling

| Symbol | Status | Notes |
|--------|--------|-------|
| validateAnnounce | MATCHED | Signature + random_blob check |
| pendingAnnounces (rebroadcast queue) | MATCHED | With PATHFINDER_RW delay |
| _scheduleAnnounceRebroadcast | MATCHED | |
| _processAnnounceRebroadcasts | MATCHED | Sends on all ifaces except origin |
| random_blobs list per path | MISSING | JS tracks single blob; Python keeps list for ratchet replay check |
| held_announces | MISSING | No state-pending hold mechanism |
| announce_handlers (registered) | MISSING | Only EventEmitter 'announce' event |
| receive_path_responses (per-handler) | MISSING | No per-handler config |

### Path request / response

| Symbol | Status | Notes |
|--------|--------|-------|
| requestPath(destHash, callback) | MATCHED | Returns Promise in JS |
| _handlePathRequest | MATCHED | Re-transmits cached announce |
| path_request_handler | MATCHED | |
| path_request_destination | MATCHED | PLAIN dest |

### Link handling

| Symbol | Status |
|--------|--------|
| _handleLinkRequest | MATCHED |
| _handleProof | MATCHED |
| registerLink / registerPendingLink | MATCHED |

### Forwarding & routing

| Symbol | Status | Notes |
|--------|--------|-------|
| _forwardPacket | MATCHED | Decrements hops, rewrites header on final hop |
| transportType rewriting (BROADCAST on final hop) | MATCHED | |
| transportId wrapping (HEADER_2) | MATCHED | |
| remaining_hops calc | MATCHED | MAX_HOPS - packet.hops |

### Dedup

| Symbol | Status |
|--------|--------|
| packet_hashlist | MATCHED |
| packet_hashlist_prev | MATCHED |
| _isDuplicate | MATCHED |
| _addToHashlist / culling | MATCHED |

### Maintenance

| Symbol | Status | Notes |
|--------|--------|-------|
| _cullTables | MATCHED | |
| startMaintenance / stopMaintenance | MATCHED | Timers for cleanup + rebroadcast |
| REVERSE_TIMEOUT / DESTINATION_TIMEOUT / PATHFINDER_E | MATCHED | |

### Callbacks & events

| Symbol | Status |
|--------|--------|
| emit('announce', info) | MATCHED |
| emit('linkEstablished', link) | MATCHED |
| emit('proof', {packet}) | MATCHED |
| dest._callbacks.packet | MATCHED |
| dest._callbacks.link | MATCHED |

### Transmission

| Symbol | Status |
|--------|--------|
| transmit(packet) | MATCHED |
| IFAC masking | MATCHED |
| inbound(raw, fromInterface) | MATCHED |
| registerInterface | MATCHED |

### Missing (Python-only)

| Symbol | Status | Notes |
|--------|--------|-------|
| Interface mode checks | MISSING | Intentional edge-only |
| Tunnel support | MISSING | Intentional edge-only |
| Shared instance | MISSING | Intentional |
| Discovery handler | MISSING | Static registration only |
| Control destinations (blackhole/instance/network/probe) | MISSING | Only path_request implemented |
| path_states / mark_path_unresponsive | MISSING | No path state machine |
| await_path | MISSING | |
| hops_to / next_hop / has_path | MISSING | Apps access pathTable directly |
| Packet caching (cache/get_cached_packet) | MISSING | |

### JS-only

| Symbol | Notes |
|--------|-------|
| _evictOldest | Explicit size-cap enforcement |
| getIdentity(destHash) | Convenience |
| requestPath returns Promise | vs Python callback-based |

## Critical gaps

1. **random_blobs list per path** — see parity doc gap #8. Replay window for
   ratcheted announces is weaker than Python's.
2. **No path state machine** — can't mark paths unresponsive based on failed
   link establishments; may keep trying dead paths.
3. **Held announces** — Python temporarily holds announces pending path state
   transitions; JS may rebroadcast too eagerly.
4. **Control destinations** — only path_request; no blackhole / instance /
   network / probe. Operational visibility is reduced.

## Verdict

**Functionally sound for edge-node use.** Missing pieces are mostly
server-mode features and advanced state management. Replay window gap is
worth tracking if announce replay is in the threat model.
