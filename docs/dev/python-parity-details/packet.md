# Packet.js vs RNS/Packet.py — Parity Detail

Source: parallel audit agent, 2026-04-11.

## Summary

Wire format is largely compatible for basic packet serialization/deserialization.
JS Packet is leaner than Python: missing `PacketReceipt` / `ProofDestination`
classes and proof/receipt handling. `pack()` in JS does not encrypt (assumes
pre-encrypted input); Python's pack() encrypts automatically based on
destination type + context. Hash computation is equivalent.

## Symbol table

| Symbol | Status | Notes |
|--------|--------|-------|
| Packet class | MATCHED | Flags byte, hops, addresses, context, payload all present |
| Flag bit layout | MATCHED | ifac(7), header_type(6), context_flag(5), transport_type(4), dest_type(3-2), packet_type(1-0) |
| HEADER_1 format | MATCHED | 2 + 16 + 1 = 19 bytes |
| HEADER_2 format | MATCHED | 2 + 16 + 16 + 1 = 35 bytes |
| pack() | MATCHED (wire format) | Creates identical byte layout |
| parse()/unpack() | MATCHED | Extracts flags, hops, addresses, context, payload correctly |
| Packet types 0x00-0x03 | MATCHED | DATA, ANNOUNCE, LINKREQUEST, PROOF |
| Context codes | MATCHED | All 15 contexts present in JS constants |
| Destination types | MATCHED | SINGLE/GROUP/PLAIN/LINK (0x00-0x03) |
| Transport types | MATCHED | BROADCAST(0x00), TRANSPORT(0x01) |
| _computeHash / get_hashable_part | MATCHED | Both strip bits 7-4 from flags, skip transport_id for HEADER_2 |
| Hash algorithm | PARTIAL | JS uses `sha256Hash()` directly; Python uses `Identity.full_hash()`. Same bytes, different abstraction. |
| send() / resend() | MISSING | Python Packet has send logic; JS delegates to Transport (architectural) |
| prove() | MISSING | JS has no prove() on Packet itself (Link.provePacket exists) |
| PacketReceipt class | MISSING | No receipt tracking, no delivery callbacks, no proof wait timeouts |
| ProofDestination class | MISSING | No helper for proof routing |
| validate_proof_packet() | MISSING | Link handles link/proof validation separately |
| getTruncatedHash() | MISSING | JS computes only full 32-byte hash |
| get_rssi/snr/q | MISSING | No physical stats on packets |
| LRPROOF special case | PARTIAL | Python Packet.pack() substitutes link_id for destination.hash when context==LRPROOF. JS does this in Link.js, not Packet.js. **Verify end-to-end.** |
| Encryption in pack() | MISSING (by design) | Python pack() auto-encrypts; JS assumes caller pre-encrypted. This works because every JS call site encrypts explicitly. |
| IFAC field | MISSING on both | Neither side reads/writes IFAC data in the header itself; done by Transport's mask_ifac() |

## Critical gaps

1. **LRPROOF substitution**: the Packet audit flagged Python Packet.pack()
   writing `destination.link_id` in place of `destination.hash` when context is
   LRPROOF. In JS this happens elsewhere (Link.js). Not a bug if every LRPROOF
   code path is routed through Link, but worth a grep to verify nothing else
   calls Packet.pack() for LRPROOF with a regular destination.

2. **Missing PacketReceipt**: callers that want "wait for proof of this
   packet" currently use `Link.sendWithProof()` which exists but is
   Link-scoped. There's no equivalent for non-Link destinations.

3. **No truncated hash helper**: any Python peer sending truncated-hash
   references in a protocol extension will confuse JS.

## Verdict

Wire format: **parity**. Encryption architecture: **intentional divergence**
(callers encrypt, not Packet). Receipt API: **missing** but largely covered by
`Link.sendWithProof`. LRPROOF path needs a cross-check.
