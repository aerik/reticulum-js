#!/usr/bin/env python3
"""
Validate a JS-generated announce packet using the Python RNS reference implementation.

This script takes the raw packet hex from the JS debug script and runs it through
RNS's actual validation pipeline to see exactly where (if anywhere) it fails.

Usage: python scripts/debug-announce-validate.py
"""

import sys
import hashlib
import struct

# ── Import RNS ──
try:
    import RNS
    from RNS.Cryptography.Ed25519 import Ed25519PrivateKey, Ed25519PublicKey
    from RNS.Cryptography.X25519 import X25519PrivateKey, X25519PublicKey
except ImportError:
    print("ERROR: pip install rns")
    raise SystemExit(1)

# ── The raw packet hex from the JS debug script ──
# This is the deterministic output with fixed seeds and timestamp
JS_PACKET_HEX = "01000db29f928732ad31bfeed2b78128c43f0014ca9e4d387bccf35746e0407daaacc6b28a4f8445ef5a5158894db983e240707d59c5623dd40a74aa4d5a32ac645d3b3f95daeae4c22be25476dd6a486f73826ec60bc318e2c0f0d9080000000000006553f100b043a287c6ee20a7aebae64576ac184650cdc685806ecea1d0c5923ec6388b76c27b9431fa760bfb3e60b53264e09241aefb8bb631a250f876f17bbb5bf0fd0b54657374204170702044617461"

raw = bytes.fromhex(JS_PACKET_HEX)

print("=== Python Validation of JS-Generated Announce ===")
print()
print(f"Raw packet: {len(raw)} bytes")
print(f"Hex: {raw.hex()}")
print()

# ── Step 1: Parse the packet ──
print("--- Step 1: Parse packet header ---")
flags = raw[0]
hops = raw[1]

header_type    = (flags & 0b01000000) >> 6
context_flag   = (flags & 0b00100000) >> 5
transport_type = (flags & 0b00010000) >> 4
dest_type      = (flags & 0b00001100) >> 2
packet_type    = (flags & 0b00000011)

print(f"  flags byte: 0x{flags:02x} (0b{flags:08b})")
print(f"    header_type:    {header_type}")
print(f"    context_flag:   {context_flag}")
print(f"    transport_type: {transport_type}")
print(f"    dest_type:      {dest_type}")
print(f"    packet_type:    {packet_type}")
print(f"  hops: {hops}")

DST_LEN = RNS.Reticulum.TRUNCATED_HASHLENGTH // 8  # 16
destination_hash = raw[2:2+DST_LEN]
context = raw[DST_LEN+2]
data = raw[DST_LEN+3:]

print(f"  dest_hash: {destination_hash.hex()}")
print(f"  context:   0x{context:02x}")
print(f"  data:      {len(data)} bytes")
print()

# ── Step 2: Run validate_announce logic manually ──
print("--- Step 2: Validate announce (manual) ---")

keysize       = RNS.Identity.KEYSIZE // 8          # 64
name_hash_len = RNS.Identity.NAME_HASH_LENGTH // 8  # 10
sig_len       = RNS.Identity.SIGLENGTH // 8          # 64
ratchetsize   = RNS.Identity.RATCHETSIZE // 8        # 32

print(f"  KEYSIZE={keysize}, NAME_HASH_LENGTH={name_hash_len}, SIGLENGTH={sig_len}")

# Extract fields
public_key = data[:keysize]
print(f"  public_key ({len(public_key)}): {public_key.hex()}")

if context_flag == 1:
    print("  Has ratchet: YES")
    name_hash   = data[keysize:keysize+name_hash_len]
    random_hash = data[keysize+name_hash_len:keysize+name_hash_len+10]
    ratchet     = data[keysize+name_hash_len+10:keysize+name_hash_len+10+ratchetsize]
    signature   = data[keysize+name_hash_len+10+ratchetsize:keysize+name_hash_len+10+ratchetsize+sig_len]
    app_data    = b""
    if len(data) > keysize+name_hash_len+10+sig_len+ratchetsize:
        app_data = data[keysize+name_hash_len+10+sig_len+ratchetsize:]
else:
    print("  Has ratchet: NO")
    ratchet     = b""
    name_hash   = data[keysize:keysize+name_hash_len]
    random_hash = data[keysize+name_hash_len:keysize+name_hash_len+10]
    signature   = data[keysize+name_hash_len+10:keysize+name_hash_len+10+sig_len]
    app_data    = b""
    if len(data) > keysize+name_hash_len+10+sig_len:
        app_data = data[keysize+name_hash_len+10+sig_len:]

print(f"  name_hash  ({len(name_hash)}): {name_hash.hex()}")
print(f"  random_hash ({len(random_hash)}): {random_hash.hex()}")
print(f"  signature  ({len(signature)}): {signature.hex()}")
print(f"  app_data   ({len(app_data)}): {app_data.hex()}")
print()

# ── Step 3: Reconstruct signed_data and verify signature ──
print("--- Step 3: Signature verification ---")

signed_data = destination_hash + public_key + name_hash + random_hash + ratchet + app_data
print(f"  signed_data ({len(signed_data)}): {signed_data.hex()}")

# Load identity from public key
identity = RNS.Identity(create_keys=False)
identity.load_public_key(public_key)
print(f"  identity hash: {identity.hash.hex()}")

# Verify signature
try:
    sig_valid = identity.validate(signature, signed_data)
    print(f"  Signature valid: {sig_valid}")
except Exception as e:
    print(f"  Signature validation error: {e}")
    sig_valid = False
print()

# ── Step 4: Verify destination hash ──
print("--- Step 4: Destination hash verification ---")
hash_material = name_hash + identity.hash
expected_hash = RNS.Identity.full_hash(hash_material)[:RNS.Reticulum.TRUNCATED_HASHLENGTH//8]
print(f"  name_hash + identity_hash = {hash_material.hex()}")
print(f"  expected dest_hash: {expected_hash.hex()}")
print(f"  actual dest_hash:   {destination_hash.hex()}")
print(f"  Match: {destination_hash == expected_hash}")
print()

# ── Step 5: Run actual RNS validate_announce ──
print("--- Step 5: Full RNS.Identity.validate_announce() ---")

# Create a mock packet object
class MockPacket:
    pass

packet = MockPacket()
packet.packet_type = RNS.Packet.ANNOUNCE
packet.destination_hash = destination_hash
packet.context_flag = context_flag
packet.data = data
packet.rssi = None
packet.snr = None
packet.q = None
packet.hops = hops
packet.receiving_interface = None
packet.transport_id = None

# Use the packet_hash method
packet_hash = RNS.Identity.full_hash(
    bytes([flags & 0x0F]) + raw[2:]
)
packet.packet_hash = packet_hash

def mock_get_hash():
    return packet_hash
packet.get_hash = mock_get_hash

try:
    result = RNS.Identity.validate_announce(packet, only_validate_signature=True)
    print(f"  validate_announce(only_sig=True): {result}")
except Exception as e:
    print(f"  validate_announce error: {e}")
    import traceback
    traceback.print_exc()

print()
print("=== SUMMARY ===")
if sig_valid and destination_hash == expected_hash:
    print("The JS-generated announce packet is VALID according to Python RNS.")
    print("The announce format is byte-compatible.")
    print()
    print("If announces are being silently ignored, check:")
    print("  1. IFAC (Interface Access Code) configuration mismatch")
    print("  2. HDLC framing issues during transport")
    print("  3. WebSocket binary/text message type mismatch")
    print("  4. Announce timing/duplicate detection in Transport.inbound()")
    print("  5. Interface ingress limiting")
else:
    print("The JS-generated announce packet FAILS validation!")
    if not sig_valid:
        print("  -> Signature verification FAILED")
    if destination_hash != expected_hash:
        print("  -> Destination hash MISMATCH")
