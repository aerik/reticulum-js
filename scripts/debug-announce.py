#!/usr/bin/env python3
"""
Debug script: Generate a deterministic announce packet using the Python RNS
reference implementation and print a detailed byte-level breakdown for
comparison with the JS implementation.

Usage: python scripts/debug-announce.py

Requires: pip install rns
"""

import hashlib
import struct

# ── Try to use RNS's own Ed25519 if available, else fall back to PyNaCl/pure Python ──

try:
    from RNS.Cryptography.Ed25519 import Ed25519PrivateKey, Ed25519PublicKey
    from RNS.Cryptography.X25519 import X25519PrivateKey, X25519PublicKey
    print("Using RNS.Cryptography backend")
    USE_RNS_CRYPTO = True
except ImportError:
    USE_RNS_CRYPTO = False
    try:
        from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey as _X25519PrivateKey
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey as _Ed25519PrivateKey
        from cryptography.hazmat.primitives import serialization
        print("Using PyCA cryptography backend")
    except ImportError:
        print("ERROR: Install either 'rns' or 'cryptography' package")
        raise SystemExit(1)


# ── helpers ────────────────────────────────────────────────────────────────

def to_hex(data: bytes) -> str:
    return data.hex()

def sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()

def truncated_hash(data: bytes, length: int) -> bytes:
    return sha256(data)[:length]

def hex_dump(label: str, data: bytes, offset: int):
    print(f"  {label:<22} offset={offset:>3}  len={len(data):>3}  {to_hex(data)}")


# ── deterministic keys ─────────────────────────────────────────────────────
# Same seeds as the JS script

ENC_SEED = bytes([0xAA] * 32)
SIG_SEED = bytes([0xBB] * 32)

if USE_RNS_CRYPTO:
    enc_priv = X25519PrivateKey.from_private_bytes(ENC_SEED)
    sig_priv = Ed25519PrivateKey.from_private_bytes(SIG_SEED)
    enc_pub_bytes = enc_priv.public_key().public_bytes()
    sig_pub_bytes = sig_priv.public_key().public_bytes()
    def sign(message: bytes) -> bytes:
        return sig_priv.sign(message)
else:
    enc_priv_obj = _X25519PrivateKey.from_private_bytes(ENC_SEED)
    sig_priv_obj = _Ed25519PrivateKey.from_private_bytes(SIG_SEED)
    enc_pub_bytes = enc_priv_obj.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    sig_pub_bytes = sig_priv_obj.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    def sign(message: bytes) -> bytes:
        return sig_priv_obj.sign(message)

# Public key blob = X25519 pub (32) + Ed25519 pub (32) = 64 bytes
public_key = enc_pub_bytes + sig_pub_bytes

# Identity hash = SHA-256(publicKey)[:16]
identity_hash = truncated_hash(public_key, 16)

print("=== Python Announce Debug ===")
print()
print("Identity:")
print(f"  enc_seed  (X25519 priv): {to_hex(ENC_SEED)}")
print(f"  sig_seed  (Ed25519 priv): {to_hex(SIG_SEED)}")
print(f"  enc_pub   (X25519 pub) : {to_hex(enc_pub_bytes)}")
print(f"  sig_pub   (Ed25519 pub): {to_hex(sig_pub_bytes)}")
print(f"  public_key (64 bytes)  : {to_hex(public_key)}")
print(f"  identity_hash (16 bytes): {to_hex(identity_hash)}")
print()

# ── destination ────────────────────────────────────────────────────────────

APP_NAME = "lxmf"
ASPECT = "delivery"
dest_name = f"{APP_NAME}.{ASPECT}"  # "lxmf.delivery"

# name_hash = SHA-256("lxmf.delivery")[:10]
# Python: RNS.Identity.full_hash(expand_name(None, app_name, *aspects).encode("utf-8"))[:10]
# expand_name(None, "lxmf", "delivery") = "lxmf.delivery"
name_hash = truncated_hash(dest_name.encode("utf-8"), 10)

# dest_hash = SHA-256(name_hash + identity_hash)[:16]
# Python: RNS.Identity.full_hash(name_hash + identity.hash)[:16]
dest_hash = truncated_hash(name_hash + identity_hash, 16)

print("Destination:")
print(f"  name string           : {dest_name}")
print(f"  name_hash (10 bytes)  : {to_hex(name_hash)}")
print(f"  dest_hash (16 bytes)  : {to_hex(dest_hash)}")
print()

# ── random blob ────────────────────────────────────────────────────────────
# Python: RNS.Identity.get_random_hash()[0:5] + int(time.time()).to_bytes(5, "big")
# For reproducibility we use fixed values matching the JS script.

FIXED_RANDOM = bytes(5)  # 5 zero bytes
FIXED_TIME = 1700000000

random_hash = FIXED_RANDOM + FIXED_TIME.to_bytes(5, "big")

print("Random blob:")
print(f"  random (5 bytes)      : {to_hex(FIXED_RANDOM)}")
print(f"  timestamp             : {FIXED_TIME}")
print(f"  random_blob (10 bytes): {to_hex(random_hash)}")
print()

# ── app data ───────────────────────────────────────────────────────────────

app_data = b"Test App Data"
print("App data:")
print(f"  bytes                 : {to_hex(app_data)}")
print(f'  string                : "Test App Data"')
print()

# ── signature ──────────────────────────────────────────────────────────────
# Python: signed_data = self.hash + self.identity.get_public_key() + self.name_hash + random_hash + app_data
# (no ratchet in this test)

signed_data = dest_hash + public_key + name_hash + random_hash + app_data

print("Signed data construction:")
print(f"  dest_hash     (16)    : {to_hex(dest_hash)}")
print(f"  public_key    (64)    : {to_hex(public_key)}")
print(f"  name_hash     (10)    : {to_hex(name_hash)}")
print(f"  random_blob   (10)    : {to_hex(random_hash)}")
print(f"  app_data      ({len(app_data)})    : {to_hex(app_data)}")
print(f"  signed_data total     : {len(signed_data)} bytes")
print(f"  signed_data hex       : {to_hex(signed_data)}")
print()

signature = sign(signed_data)

print(f"Signature (64 bytes)    : {to_hex(signature)}")
print()

# Verify our own signature
if USE_RNS_CRYPTO:
    sig_pub_obj = Ed25519PublicKey.from_public_bytes(sig_pub_bytes)
    try:
        sig_pub_obj.verify(signature, signed_data)
        print("Self-verify             : True")
    except Exception:
        print("Self-verify             : False")
else:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey as _Ed25519PublicKey
    pub_obj = _Ed25519PublicKey.from_public_bytes(sig_pub_bytes)
    try:
        pub_obj.verify(signature, signed_data)
        print("Self-verify             : True")
    except Exception:
        print("Self-verify             : False")
print()

# ── announce data ──────────────────────────────────────────────────────────
# Python: announce_data = identity.get_public_key() + name_hash + random_hash + signature + app_data

announce_data = public_key + name_hash + random_hash + signature + app_data

print("Announce data layout:")
off = 0
hex_dump("public_key (64)", public_key, off); off += 64
hex_dump("name_hash (10)", name_hash, off); off += 10
hex_dump("random_blob (10)", random_hash, off); off += 10
hex_dump("signature (64)", signature, off); off += 64
hex_dump(f"app_data ({len(app_data)})", app_data, off); off += len(app_data)
print(f"  total announce_data   : {len(announce_data)} bytes")
print()

# ── packet header ──────────────────────────────────────────────────────────
# Python flags: (header_type << 6) | (context_flag << 5) | (transport_type << 4) | (dest_type << 2) | packet_type
# Note: Python does NOT include IFAC flag in get_packed_flags() -- IFAC is added later by the interface.
# IFAC flag is bit 7, and Python's get_packed_flags() starts from bit 6.

IFAC_FLAG = 0
HEADER_TYPE = 0      # HEADER_1
CONTEXT_FLAG = 0     # no ratchet
TRANSPORT_TYPE = 0   # BROADCAST
DEST_TYPE = 0        # SINGLE
PACKET_TYPE = 1      # ANNOUNCE

# Python formula: (header_type << 6) | (context_flag << 5) | (transport_type << 4) | (dest_type << 2) | packet_type
flags = (HEADER_TYPE << 6) | (CONTEXT_FLAG << 5) | (TRANSPORT_TYPE << 4) | (DEST_TYPE << 2) | PACKET_TYPE

hops = 0
context = 0x00  # CONTEXT_NONE

print("Packet header:")
print(f"  flags byte            : 0x{flags:02x} (0b{flags:08b})")
print(f"    IFAC flag           : {IFAC_FLAG}")
print(f"    header type         : {HEADER_TYPE} (HEADER_1)")
print(f"    context flag        : {CONTEXT_FLAG} (no ratchet)")
print(f"    transport type      : {TRANSPORT_TYPE} (BROADCAST)")
print(f"    dest type           : {DEST_TYPE} (SINGLE)")
print(f"    packet type         : {PACKET_TYPE} (ANNOUNCE)")
print(f"  hops byte             : 0x{hops:02x}")
print(f"  dest_hash (16 bytes)  : {to_hex(dest_hash)}")
print(f"  context byte          : 0x{context:02x}")
print()

# ── full packet ────────────────────────────────────────────────────────────
# Python: header = struct.pack("!B", flags) + struct.pack("!B", hops) + dest_hash + bytes([context])
# raw = header + ciphertext (= announce_data for announces)

header = struct.pack("!B", flags) + struct.pack("!B", hops)
full_packet = header + dest_hash + bytes([context]) + announce_data

print("Full packet breakdown:")
off = 0
hex_dump("flags (1)", header[0:1], off); off += 1
hex_dump("hops (1)", header[1:2], off); off += 1
hex_dump("dest_hash (16)", dest_hash, off); off += 16
hex_dump("context (1)", bytes([context]), off); off += 1
hex_dump("announce_data", announce_data, off)
print(f"  total packet size     : {len(full_packet)} bytes")
print()

print("=== FULL PACKET HEX ===")
print(to_hex(full_packet))
print()

# ── comparison notes ───────────────────────────────────────────────────────
print("=== KEY EXPORT ===")
print(f"ENC_SEED = {to_hex(ENC_SEED)}")
print(f"SIG_SEED = {to_hex(SIG_SEED)}")
print(f"FIXED_TIME = {FIXED_TIME}")
