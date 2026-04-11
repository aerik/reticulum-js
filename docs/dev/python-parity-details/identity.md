# Identity.js vs RNS/Identity.py — Parity Detail

Source: parallel audit agent, 2026-04-11.

## Summary

Core cryptography (X25519 ECDH, Ed25519 signatures, HKDF-SHA256, AES-CBC+HMAC)
matches exactly. Critical gaps: static identity persistence (recall/remember),
announce validation (moved to `src/Announce.js`), multi-ratchet decryption,
and ratchet persistence.

## Symbol table

| Symbol | Status | Notes |
|--------|--------|-------|
| generate() | MATCHED | X25519 + Ed25519 keypairs |
| fromPublicKey(64-byte blob) | MATCHED | 32 enc_pub + 32 sig_pub |
| fromPrivateKey(64-byte priv) | MATCHED | Derives publics |
| export() / exportPrivateKey() | MATCHED | JS: 128-byte full; Python: 64-byte priv only |
| IDENTITY_HASH_LENGTH | MATCHED | 16 bytes |
| DERIVED_KEY_LENGTH | MATCHED | 64 bytes. Python legacy=32 not in JS. |
| NAME_HASH_LENGTH | MATCHED | 10 bytes |
| TRUNCATED_HASHLENGTH | MATCHED | 16 bytes |
| full_hash() / sha256Hash() | MATCHED | SHA-256 → 32 bytes |
| truncated_hash() | MATCHED | SHA-256[:16] |
| sign(data) | MATCHED | Ed25519 → 64 bytes |
| verify(sig, data) | MATCHED | Ed25519 verify |
| encrypt(plaintext, ratchet?) | PARTIAL | JS async, Python sync. Format: `ephemeral_pub(32) + IV(16) + ciphertext + HMAC(32)`. Same. |
| decrypt(ciphertext, ratchets?) | **PARTIAL — CRITICAL** | Python walks a list of ratchets + enforce flag; JS tries only `_ratchetPriv` then base key. |
| __decrypt() / _decryptWith() | MATCHED | HKDF(ikm=shared, salt=identity_hash, info=empty), split signing/enc, verify HMAC, decrypt |
| HKDF parameters | MATCHED | RFC 5869, 64-byte output, split [0:32]/[32:64] |
| rotateRatchet() | MATCHED (instance only) | Generates new X25519 keypair |
| ratchetPublicKey getter | MATCHED | Returns current or null |
| setRemoteRatchet(pub) | MATCHED | Stores known remote ratchet |
| known_ratchets static store | MISSING | No persistent ratchet store |
| ratchet_id / name hash for announces | MISSING | Python: `full_hash(ratchet_pub)[:NAME_HASH_LENGTH//8]` |
| remember(packet_hash, dest_hash, pub_key, app_data) | MISSING | Announce table is in Transport instead |
| recall(target_hash, from_identity_hash?) | MISSING | Lookup via `Transport.announceTable` |
| recall_app_data(dest_hash) | MISSING | Not implemented |
| known_destinations (static dict) | MISSING | Transport holds it |
| save/load_known_destinations() | MISSING | Delegated to Storage class |
| validate_announce() | MOVED | Lives in `src/Announce.js` as `validateAnnounce` |
| get_private_key() | MATCHED | enc_prv + sig_prv (64 bytes) |
| get_public_key() | MATCHED | enc_pub + sig_pub (64 bytes) |
| hasPrivateKey() | MATCHED | |

## Critical gaps

1. **Multi-ratchet decrypt missing** — see parity doc gap #3. Single ratchet
   is tried; if peer rotated, decrypt fails.

2. **No persistent ratchet storage** — see parity doc gap #2. Instance state
   only; restart loses the rotation chain.

3. **Announce validation moved** — not a bug, but future readers should know
   it's in `Announce.js` not `Identity.js`.

4. **Legacy 32-byte HKDF mode** not supported — low risk unless interop with
   very old RNS builds is required.

## Verdict

Crypto primitives: **parity**. State management and ratchet lifecycle: **gap**.
Announce validation: **architectural divergence** (Announce.js).
