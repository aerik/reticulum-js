# Cryptographic Primitives

All crypto is implemented via `@noble/curves` and `@noble/hashes` — pure JavaScript, no native bindings, works identically in Node.js and browsers.

## Primitives

| Primitive | Library | Usage |
|-----------|---------|-------|
| X25519 | `@noble/curves/ed25519.js` | ECDH key exchange (identity encryption, link handshake) |
| Ed25519 | `@noble/curves/ed25519.js` | Signing (announces, link proofs, IFAC) |
| AES-256-CBC | `globalThis.crypto.subtle` | Symmetric encryption (identity encrypt, link data) |
| HKDF-SHA256 | `@noble/hashes/hkdf.js` | Key derivation (identity encrypt, link session keys, IFAC) |
| SHA-256 | `@noble/hashes/sha2.js` | Hashing (identity, destination, packet dedup) |
| HMAC-SHA256 | `@noble/hashes/hmac.js` | Message authentication (encrypted tokens) |
| PKCS7 | Manual | Padding for AES-CBC (WebCrypto handles this automatically) |

## Key Formats

### Identity (X25519 + Ed25519)

```
Public key blob:  [X25519 pub: 32B] [Ed25519 pub: 32B] = 64 bytes
Private key blob: [X25519 prv: 32B] [Ed25519 prv: 32B] = 64 bytes
Identity hash:    SHA-256(public_key_blob)[:16] = 16 bytes (128 bits)
```

X25519 comes first, Ed25519 second. This matches the Python reference.

### Destination Hash

```
Name hash:        SHA-256("appname.aspect1.aspect2")[:10] = 10 bytes
Destination hash: SHA-256(name_hash + identity_hash)[:16] = 16 bytes (SINGLE)
                  SHA-256(name_hash)[:16] = 16 bytes (PLAIN/GROUP)
```

## Identity Encryption (Fernet-like Token)

Used for encrypting data addressed to a specific identity.

### Encrypt

```
1. Generate ephemeral X25519 keypair
2. ECDH: shared_secret = X25519(ephemeral_prv, recipient_enc_pub)  [or ratchet pub]
3. HKDF-SHA256:
     IKM    = shared_secret (32B)
     Salt   = recipient_identity_hash (16B)
     Info   = empty bytes
     Output = 64 bytes
4. Split: signing_key = derived[0:32], encryption_key = derived[32:64]
5. IV = random 16 bytes
6. ciphertext = AES-256-CBC(PKCS7(plaintext), encryption_key, IV)
7. hmac = HMAC-SHA256(signing_key, IV + ciphertext)
8. Output: ephemeral_pub(32) + IV(16) + ciphertext + hmac(32)
```

### Decrypt

```
1. Extract ephemeral_pub (first 32 bytes), token (rest)
2. ECDH: shared_secret = X25519(our_enc_prv, ephemeral_pub)
3. HKDF: same params as encrypt, with our identity hash as salt
4. Split: signing_key, encryption_key
5. Verify: HMAC-SHA256(signing_key, IV + ciphertext) == received_hmac
6. Decrypt: AES-256-CBC(ciphertext, encryption_key, IV), PKCS7 unpad
```

### Ratchets

An identity can generate an X25519 ratchet keypair. The ratchet public key is included in announces (context_flag=1). Senders use the ratchet key instead of the base encryption key for ECDH, providing forward secrecy if the base key is later compromised.

## Link Session Keys

Used for all data on an established Link.

```
1. Both sides generate ephemeral X25519 keypairs
2. ECDH: shared_secret = X25519(our_ephemeral_prv, peer_ephemeral_pub)
3. HKDF-SHA256:
     IKM    = shared_secret (32B)
     Salt   = link_id (16B)
     Info   = empty bytes
     Output = 64 bytes
4. Split: signing_key = derived[0:32], encryption_key = derived[32:64]
```

Per-packet encryption is identical to the identity token scheme: random IV + AES-256-CBC + HMAC-SHA256. The same keys are used for the entire link lifetime (no ratcheting on links — forward secrecy comes from the ephemeral ECDH).

## IFAC (Interface Access Codes)

```
1. ifac_origin = SHA-256(networkname) + SHA-256(passphrase)
2. ifac_key = HKDF(ikm=SHA-256(ifac_origin), salt=IFAC_SALT, length=64)
     IFAC_SALT = 0xadf54d882c9a9b80771eb4995d702d4a3e733391b2a0f53f416d9f907e55cff8
3. ifac_identity = Identity.fromPrivateKey(ifac_key)
4. On transmit: sign packet → take last N bytes as IFAC → XOR mask packet
5. On receive: extract IFAC → unmask → verify signature
```

IFAC provides authentication (only nodes sharing the same networkname/passphrase) and obfuscation (XOR masking, NOT encryption) at the interface level.
