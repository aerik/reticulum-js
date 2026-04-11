# lxmf/LXMRouter.js vs LXMF/LXMRouter.py — Parity Detail

Source: parallel audit agent, 2026-04-11.

## Summary

Delivery flows (OPPORTUNISTIC/DIRECT/PROPAGATED) and basic propagation storage
work. **Propagation peering subsystem (~40% of Python LXMRouter's line count)
is entirely absent**: no LXMPeer class, no peer()/unpeer(), no sync strategies,
no offer protocol. Also missing: message persistence (in-memory only),
stamping/tickets, access control (allow/deny lists), and the broadcast of
`delivery_per_transfer_limit` in announces (Finding #2).

Overall: ~60% functional parity on delivery, ~20% on propagation.

## Symbol table (condensed)

### Constants

| Symbol | Status |
|--------|--------|
| MAX_DELIVERY_ATTEMPTS (5) | MATCHED |
| PROCESSING_INTERVAL (4s) | MATCHED |
| DELIVERY_RETRY_WAIT (10s) | MATCHED |
| PATH_REQUEST_WAIT (7s) | MATCHED (unused in JS) |
| LINK_MAX_INACTIVITY (600s) | MATCHED |
| P_LINK_MAX_INACTIVITY (180s) | MATCHED |
| MESSAGE_EXPIRY (30d) | MATCHED |
| STAMP_COST_EXPIRY (45d) | MISSING |
| NODE_ANNOUNCE_DELAY (20s) | MISSING |
| MAX_PEERS / AUTOPEER / AUTOPEER_MAXDEPTH | MISSING |
| ROTATION_HEADROOM / AR_MAX | MISSING |
| PEERING_COST / MAX_PEERING_COST | MISSING |
| PROPAGATION_COST_MIN/FLEX | MISSING |
| SYNC_LIMIT | PARTIAL (constant only) |
| PR_* state constants (16) | MATCHED |
| PR_ALL_MESSAGES | MATCHED |
| DUPLICATE_SIGNAL | MISSING |
| STATS_GET_PATH / SYNC_REQUEST_PATH / UNPEER_REQUEST_PATH | MISSING |

### Constructor & init

| Symbol | Status | Notes |
|--------|--------|-------|
| constructor | PARTIAL | No storagepath validation, no peering/stamping init |
| identity | MATCHED | |
| propagation_node flag | MATCHED | |
| delivery_destinations | MATCHED | Map |
| propagation_destination | MATCHED | Single dest |
| propagation_entries (message store) | MATCHED (in-memory only) | |
| locallyDeliveredIds / locallyProcessedIds | MATCHED | Dedup |
| pendingOutbound / outbound_queue | MATCHED | |
| peers / static_peers | MISSING | |
| from_static_only | MISSING | |
| allow/deny lists | MISSING | |
| _enforce_stamps / pending_deferred_stamps | MISSING | |

### Announce & discovery

| Symbol | Status | Notes |
|--------|--------|-------|
| announce() | PARTIAL | JS: delivery only |
| announceDelivery() | MATCHED | Broadcasts delivery dest + app_data |
| announceAll() | MATCHED | |
| announcePropagation() | MATCHED | Fixed cost [0,0,0] in JS |
| get_announce_app_data() | MATCHED | [displayName, stampCost] |
| get_propagation_node_app_data() | PARTIAL | JS hardcoded fixed values |
| get_propagation_node_announce_metadata() | MISSING | |
| register_announce_handler() | MISSING | No delivery/propagation handlers wired |

### Delivery registration

| Symbol | Status | Notes |
|--------|--------|-------|
| registerDeliveryIdentity() | PARTIAL | JS: basic dest + link callback |
| set_inbound_stamp_cost() | MISSING | |
| stampCost | PARTIAL | Stored, not enforced |

### Delivery callbacks

| Symbol | Status |
|--------|--------|
| register_delivery_callback / _messageCallback | MATCHED |
| onMessage() | MATCHED |
| onDeliveryTo() | MATCHED |

### Delivery flow

| Symbol | Status |
|--------|--------|
| OPPORTUNISTIC | MATCHED |
| DIRECT | MATCHED |
| PROPAGATED | MATCHED |
| handleOutbound / process_outbound | MATCHED |
| Message state machine (OUTBOUND→SENDING→SENT→DELIVERED/FAILED) | MATCHED |
| _dispatch | MATCHED |
| _sendOpportunistic / _sendDirect / _sendPropagated | MATCHED |
| _drainDirectQueue / _drainPropagationQueue | MATCHED |
| MAX_DELIVERY_ATTEMPTS enforcement | MATCHED |
| DELIVERY_RETRY_WAIT backoff | MATCHED |

### Delivery receive

| Symbol | Status | Notes |
|--------|--------|-------|
| delivery_link_established | PARTIAL | Python: ratchet enforcement |
| delivery_packet / _deliveryPacket | MATCHED | |
| _deliveryLinkData | MATCHED | |
| _lxmfDelivery | MATCHED | Parse, dedup, emit |
| Link proof | MATCHED | link.provePacket on receipt |
| Transient ID dedup | MATCHED | sha256(msg_without_stamp) |

### Propagation node — message storage

| Symbol | Status | Notes |
|--------|--------|-------|
| enablePropagation | PARTIAL | JS: simple in-memory |
| disablePropagation | MATCHED | |
| _lxmfPropagation | MATCHED | Stores received messages |
| _pruneOldestMessages | MATCHED | |
| expireMessages | MATCHED | |
| Storage format | PARTIAL | JS: Map in RAM; Python: disk files with ts/stamp in name |
| Persistence | MISSING | Restart = loss |

### Propagation peering — ENTIRELY MISSING

All of: `peer()`, `unpeer()`, `rotate_peers()`, `sync_peers()`,
`request_messages_from_propagation_node()`, `LXMPeer` class, LAZY/PERSISTENT
sync strategies, offer/request protocol (only `_messageGetRequest` wired),
peer distribution queue, stamp cost negotiation, `max_peering_cost`,
throttled peers.

### Propagation request handlers

All of: stats_get_request, peer_sync_request, peer_unpeer_request,
compile_stats, control destination request registration — all **MISSING**.

### Stamping / tickets

All **MISSING**: enforce_stamps, ignore_stamps, generate_ticket,
available_tickets, outbound_stamp_costs, process_deferred_stamps.

### Message filtering

All **MISSING**: allow, disallow, allow_control, disallow_control, prioritise,
unprioritise, ignore_destination, unignore_destination, set_authentication,
requires_authentication, identity_allowed.

### Message store management

Most **MISSING**: set_message_storage_limit (dynamic), message_storage_limit,
message_storage_size, information_storage_limit, clean_message_store,
clean_transient_id_caches, clean_outbound_stamp_costs, clean_available_tickets.

### Job scheduling

| Symbol | Status | Notes |
|--------|--------|-------|
| jobloop() | MISSING | Background thread |
| jobs() | MISSING | |
| Threading / signal handlers | MISSING | No SIGINT/SIGTERM/atexit |

(JS uses `setInterval` for outbound processing only.)

### Message lifecycle

| Symbol | Status |
|--------|--------|
| get_pending_outbound / getPendingOutbound | MATCHED |
| cancel_outbound | MISSING |
| fail_message / _failMessage | MATCHED |
| get_outbound_progress | MISSING |
| get_outbound_lxm_stamp_cost | MISSING |
| get_outbound_lxm_propagation_stamp_cost | MISSING |

### Receive flow (client)

| Symbol | Status |
|--------|--------|
| /get request handler | MATCHED |
| Message list protocol | MATCHED |
| Transfer limit on response | MATCHED |
| Stamp stripping on serve | MATCHED |

### Delivery limit

| Symbol | Status | Notes |
|--------|--------|-------|
| delivery_per_transfer_limit in announce | MISSING | Finding #2 |
| Receiver limit in app_data | MISSING | JS announceDelivery omits it |

## Critical gaps

1. **Propagation peering system** — see parity doc gap #5.
2. **Delivery limit broadcast** — Finding #2.
3. **Message store persistence** — see parity doc gap #6.
4. **Stamping & tickets** — no PoW rate limiting.
5. **Access control** — no allow/deny lists.
6. **Announce handlers** — no automatic peer discovery.
7. **Background jobs + signal handling** — no graceful shutdown.

## Verdict

**Delivery flows work end-to-end** (verified against Python LXMF in prior
sessions). The propagation node can act as a leaf store-and-forward for
connected clients. **It cannot function as a peer in a multi-node propagation
mesh** and it cannot survive a restart. Treat the JS propagation node as
"client-facing only" for now.
