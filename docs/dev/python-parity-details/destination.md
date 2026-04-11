# Destination.js vs RNS/Destination.py — Parity Detail

Source: parallel audit agent, 2026-04-11. Some claims corrected after cross-check.

## Summary

JS `Destination.js` is a skeleton: hash, direction/type constants, and
callback slots. Several methods the initial audit called "missing" actually
live in sibling modules (announce in `src/Announce.js`, encrypt/decrypt in
`Identity.js`). Genuinely missing: ratchet management, request handlers,
GROUP destination support, and the `incoming_link_request()` dispatcher.

## Corrections to initial audit

- `announce()` is **not** in `Destination.js` — it's implemented as
  `createAnnounce(destination, appData, options)` in `src/Announce.js`. This
  is an architectural split, not a missing feature.
- Ratchet **wire-format packing** IS present (in `Announce.js`). What's
  missing is the *management* layer (rotation, persistence, enforcement).
- `encrypt()`/`decrypt()` on Destinations intentionally delegate to
  `Identity.js` in JS rather than wrapping it on Destination.

## Symbol table

| Symbol | Status | Notes |
|--------|--------|-------|
| DEST_SINGLE / GROUP / PLAIN / LINK | MATCHED | 0x00-0x03 |
| DEST_IN / OUT | MATCHED | 0x11, 0x12 |
| constructor | PARTIAL | Accepts identity/direction/type/name/aspects. Missing: dot validation, auto-identity for IN non-PLAIN, Transport registration, proof_strategy, default_app_data, links list, request_handlers |
| Destination.expand_name() | MISSING | Static helper for app_name.aspects string — not critical |
| Destination.hash() static | MISSING | Core hash derivation is hardcoded in constructor; no static version to compute hashes without instantiating |
| Destination.app_and_aspects_from_name() | MISSING | Reverse parser, not critical |
| computeHash() (static) | JS-ONLY | Accepts pre-computed name_hash + identity_hash |
| nameHash | MATCHED | 10-byte truncated SHA-256(app_name.aspects) |
| hash / hexHash | MATCHED | 16-byte truncated SHA-256(name_hash + identity.hash) |
| fullName | PARTIAL | JS builds statically; Python builds via expand_name() |
| announce() | MOVED | → `Announce.js:createAnnounce()` |
| accepts_links / accept_link_requests | MISSING | No policy field |
| setPacketCallback / _callbacks.packet | PARTIAL | Stored; no receive() dispatcher |
| setLinkCallback / _callbacks.link | PARTIAL | Stored; no incoming_link_request() dispatcher |
| setProofCallback / _callbacks.proof | PARTIAL | Signature vague |
| encrypt() / decrypt() | DELEGATED | Use `Identity.encrypt/decrypt` directly |
| sign() | DELEGATED | Use `identity.sign` directly |
| ratchets / ratchet_ fields | **MISSING** | No management layer |
| rotate_ratchets() | MISSING | No rotation scheduler |
| enable_ratchets() | MISSING | No load-from-disk |
| enforce_ratchets() | MISSING | No base-key-reject mode |
| set_retained_ratchets() | MISSING | No retention cap |
| set_ratchet_interval() | MISSING | No interval config |
| _reload_ratchets() / _persist_ratchets() | MISSING | No file I/O |
| register_request_handler() | MISSING | No RPC dispatch |
| deregister_request_handler() | MISSING | |
| request_handlers dict | MISSING | |
| receive() | MISSING | No packet dispatcher on Destination |
| incoming_link_request() | MISSING | Handled by Transport instead |
| GROUP destination keys | MISSING | create_keys/get_private_key/load_private_key absent |
| set_default_app_data / clear | MISSING | Announces pass app_data per call |
| Callbacks class | STYLE | Python has object; JS uses dict |

## Critical gaps

1. **Ratchet management** (entire subsystem). See parity doc gap #2.
2. **Request handlers** — can't act as RPC server.
3. **GROUP destinations** — not supported at all.
4. **Destination.hash() static** — can't compute a destination hash without
   constructing a full Destination object.

## Verdict

Treat `Destination.js` as an identity+callback holder, not a full Python
Destination. For outbound operations the real logic is split between
`Announce.js` (announce packing) and `Identity.js` (encrypt/sign). This works
for current uses but makes the API surface noticeably smaller.
