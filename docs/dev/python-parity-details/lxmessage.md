# lxmf/LXMessage.js vs LXMF/LXMessage.py — Parity Detail

Source: parallel audit agent, 2026-04-11.

## Summary

**Wire format is byte-exact.** JS file is a focused serialization layer
(~360 LOC); Python file also carries delivery-system integration, stamping,
tickets, and file I/O (~800+ LOC). The non-serialization features live in
other JS modules (LXMRouter, LXStamper) or are intentionally absent.

## Symbol table

### Constants

| Symbol | Status | Notes |
|--------|--------|-------|
| DESTINATION_LENGTH (16) | MATCHED | |
| SIGNATURE_LENGTH (64) | MATCHED | Ed25519 |
| LXMF_OVERHEAD (96) | MATCHED | 16+16+64 |
| State constants (GENERATING/OUTBOUND/SENDING/SENT/DELIVERED/REJECTED/CANCELLED/FAILED) | MATCHED | All present |
| Representation (UNKNOWN/PACKET/RESOURCE) | MATCHED | |
| Delivery methods (OPPORTUNISTIC=0 / DIRECT=1 / PROPAGATED=2 / PAPER=3) | MATCHED | |
| SOURCE_UNKNOWN / SIGNATURE_INVALID | MATCHED | |
| FIELD_* (15 total) | MATCHED | 0x01–0x0F core, 0xFB–0xFD custom, 0xFE–0xFF debug |
| RENDERER_PLAIN / MICRON / MARKDOWN | MATCHED | |
| RENDERER_BBCODE (0x03) | MISSING | |

### Serialization

| Symbol | Status | Notes |
|--------|--------|-------|
| pack() | MATCHED (byte-exact) | `dest_hash + src_hash + sig + msgpack([ts, title, content, fields, ?stamp])` |
| unpackFromBytes() | MATCHED | Extracts stamp at pos 4 if present; verifies signature over `hashed_part + hash` |
| Signature computation | MATCHED | `sign(concat(dest_hash + src_hash + msgpack(payload)) + sha256_hash)` |
| Hash computation | MATCHED | `SHA256(dest_hash + src_hash + msgpack([ts, title, content, fields]))` (stamp excluded) |
| packForPropagation() | PARTIAL | JS: async encryption + optional stamp. Python: inline in pack(). Same wire format. |

### Accessors

| Symbol | Status | Notes |
|--------|--------|-------|
| set_title_from_string / bytes | MISSING | JS uses direct property |
| title_as_string | MISSING | |
| set_content_from_string / bytes | MISSING | |
| content_as_string | MISSING | |
| set_fields / get_fields | MISSING | |

### Delivery/transport integration

All **MISSING** (lives in LXMRouter.js in JS):
- send()
- determine_transport_encryption()
- validate_stamp()
- get_stamp(), get_propagation_stamp()
- packed_container()
- write_to_directory()
- as_uri(), as_qr() (paper format)
- unpack_from_file()

### Properties

| Symbol | Status | Notes |
|--------|--------|-------|
| destination / source (property decorators) | MISSING | JS uses hash fields directly |
| stamp_cost / stamp_value / stamp_valid / stamp_checked | MISSING | Stamping in LXStamper |
| propagation_stamp_* | MISSING | Generated on-demand |
| defer_stamp / defer_propagation_stamp | MISSING | Options in packForPropagation |
| outbound_ticket / include_ticket | MISSING | |
| rssi / snr / q | MISSING | No telemetry |
| ratchet_id / packet_representation / resource_representation | MISSING | Transport tracking |
| transport_encrypted / transport_encryption | PARTIAL | Flags tracked, not computed |
| propagation_packed / paper_packed | PARTIAL | JS has propagation_packed only |
| transient_id | MATCHED | SHA256(destination_hash + encrypted_data) |

## Critical gaps

1. **RENDERER_BBCODE missing** — low impact; add if cross-renderer interop matters.
2. **No title/content string accessors** — minor API difference; users access the bytes directly in JS.
3. **Paper format (as_uri / as_qr)** — not ported. Not critical for current use.

## Verdict

**Wire format: production-safe for cross-platform message exchange.** JS is a
focused subset; the gaps are in delivery/stamping/storage, not serialization.
Byte-exact signature verification confirmed between JS and Python.
