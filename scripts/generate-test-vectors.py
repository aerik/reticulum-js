"""
Generate test vectors from the Python RNS reference implementation.

Run with: .venv/Scripts/python.exe scripts/generate-test-vectors.py

Outputs JSON test vectors that the Node.js tests can consume to
verify wire-format compatibility.
"""

import json
import os
import sys
import time
import hashlib

try:
    import RNS
except ImportError:
    print("Error: RNS not installed. Run: .venv/Scripts/python.exe -m pip install rns")
    sys.exit(1)

# Initialize RNS in a minimal way (no network, no interfaces)
reticulum = RNS.Reticulum(configdir=os.path.join(os.path.dirname(__file__), '..', '.rns_test_config'))


def generate_identity_vectors():
    """Generate identity keypairs and verify hash computation."""
    identity = RNS.Identity(create_keys=True)

    pub_key = identity.get_public_key()
    prv_key = identity.get_private_key()

    return {
        "public_key_hex": pub_key.hex(),
        "private_key_hex": prv_key.hex(),
        "hash_hex": identity.hash.hex(),
        "hexhash": identity.hexhash,
        "public_key_length": len(pub_key),
        "private_key_length": len(prv_key),
        "hash_length": len(identity.hash),
    }


def generate_destination_vectors():
    """Generate destination hashes for known names + keys."""
    identity = RNS.Identity(create_keys=True)

    # Test several app name / aspect combinations
    test_cases = [
        ("test_app", ["service"]),
        ("myapp", []),
        ("lxmf", ["delivery"]),
        ("nomadnetwork", ["node"]),
        ("app", ["a", "b", "c"]),
    ]

    results = []
    for app_name, aspects in test_cases:
        dest = RNS.Destination(
            identity,
            RNS.Destination.IN,
            RNS.Destination.SINGLE,
            app_name,
            *aspects
        )

        name_hash = dest.name_hash

        results.append({
            "app_name": app_name,
            "aspects": aspects,
            "full_name": dest.name,
            "identity_public_key_hex": identity.get_public_key().hex(),
            "identity_hash_hex": identity.hash.hex(),
            "name_hash_hex": name_hash.hex(),
            "name_hash_length": len(name_hash),
            "destination_hash_hex": dest.hash.hex(),
            "destination_hash_length": len(dest.hash),
        })

    # Also test PLAIN destination
    plain_dest = RNS.Destination(
        None,
        RNS.Destination.IN,
        RNS.Destination.PLAIN,
        "broadcast",
        "channel"
    )
    results.append({
        "app_name": "broadcast",
        "aspects": ["channel"],
        "type": "PLAIN",
        "full_name": plain_dest.name,
        "identity_public_key_hex": None,
        "identity_hash_hex": None,
        "name_hash_hex": plain_dest.name_hash.hex(),
        "name_hash_length": len(plain_dest.name_hash),
        "destination_hash_hex": plain_dest.hash.hex(),
        "destination_hash_length": len(plain_dest.hash),
    })

    return {
        "identity_public_key_hex": identity.get_public_key().hex(),
        "identity_private_key_hex": identity.get_private_key().hex(),
        "identity_hash_hex": identity.hash.hex(),
        "cases": results,
    }


def generate_announce_vectors():
    """Generate an announce and verify hash computation."""
    identity = RNS.Identity(create_keys=True)

    dest = RNS.Destination(
        identity,
        RNS.Destination.IN,
        RNS.Destination.SINGLE,
        "test_app",
        "announce_test"
    )

    pub_key = identity.get_public_key()
    name_hash = dest.name_hash

    # Verify name hash: SHA256(name_without_identity)[:10]
    app_name = "test_app"
    aspects = ["announce_test"]
    name_for_hash = ".".join([app_name] + aspects)
    computed_name_hash = hashlib.sha256(name_for_hash.encode("utf-8")).digest()[:10]

    assert computed_name_hash == name_hash, \
        f"Name hash mismatch: computed={computed_name_hash.hex()} vs actual={name_hash.hex()}"

    # Verify destination hash: SHA256(name_hash + identity_hash)[:16]
    identity_hash = identity.hash
    hash_material = name_hash + identity_hash
    computed_dest_hash = hashlib.sha256(hash_material).digest()[:16]

    assert computed_dest_hash == dest.hash, \
        f"Dest hash mismatch: computed={computed_dest_hash.hex()} vs actual={dest.hash.hex()}"

    return {
        "app_name": app_name,
        "aspects": aspects,
        "name_for_hash": name_for_hash,
        "identity_public_key_hex": pub_key.hex(),
        "identity_private_key_hex": identity.get_private_key().hex(),
        "identity_hash_hex": identity_hash.hex(),
        "name_hash_hex": name_hash.hex(),
        "destination_hash_hex": dest.hash.hex(),
        "hash_computation_verified": True,
    }


def generate_encryption_vectors():
    """Generate encrypt/decrypt test vectors."""
    recipient = RNS.Identity(create_keys=True)

    plaintext = b"Hello from Python RNS!"

    # Encrypt for recipient
    ciphertext = recipient.encrypt(plaintext)

    # Verify decrypt works
    decrypted = recipient.decrypt(ciphertext)
    assert decrypted == plaintext, "Python decrypt failed"

    return {
        "recipient_public_key_hex": recipient.get_public_key().hex(),
        "recipient_private_key_hex": recipient.get_private_key().hex(),
        "recipient_hash_hex": recipient.hash.hex(),
        "plaintext_hex": plaintext.hex(),
        "ciphertext_hex": ciphertext.hex(),
        "ciphertext_length": len(ciphertext),
        "note": "Node.js should be able to decrypt this ciphertext using the recipient private key",
    }


def generate_signing_vectors():
    """Generate sign/verify test vectors."""
    identity = RNS.Identity(create_keys=True)

    message = b"Reticulum test message for signing"
    signature = identity.sign(message)

    assert identity.validate(signature, message), "Python verify failed"

    return {
        "public_key_hex": identity.get_public_key().hex(),
        "private_key_hex": identity.get_private_key().hex(),
        "message_hex": message.hex(),
        "signature_hex": signature.hex(),
        "signature_length": len(signature),
    }


def main():
    version = RNS.__version__ if hasattr(RNS, '__version__') else "unknown"
    print(f"Generating test vectors with RNS {version}...")

    vectors = {
        "generated_by": f"Python RNS {version}",
        "generated_at": int(time.time()),
        "identity": generate_identity_vectors(),
        "destinations": generate_destination_vectors(),
        "announce": generate_announce_vectors(),
        "encryption": generate_encryption_vectors(),
        "signing": generate_signing_vectors(),
    }

    output_path = os.path.join(os.path.dirname(__file__), '..', 'test', 'vectors.json')
    with open(output_path, 'w') as f:
        json.dump(vectors, f, indent=2)

    print(f"Test vectors written to {output_path}")
    print(f"  Identity hash: {vectors['identity']['hash_hex']}")
    print(f"  Destination cases: {len(vectors['destinations']['cases'])}")
    print(f"  Announce hash verified: {vectors['announce']['hash_computation_verified']}")
    print(f"  Encryption ciphertext: {vectors['encryption']['ciphertext_length']} bytes")
    print(f"  Signature: {vectors['signing']['signature_length']} bytes")

if __name__ == '__main__':
    main()
