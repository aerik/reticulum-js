# Packet Wire Format

## Flags Byte (byte 0)

```
Bit 7:    IFAC flag (interface access code present)
Bit 6:    Header type (0=HEADER_1, 1=HEADER_2)
Bit 5:    Context flag (ratchet flag for announces)
Bit 4:    Transport type (0=BROADCAST, 1=TRANSPORT)
Bits 3-2: Destination type (0=SINGLE, 1=GROUP, 2=PLAIN, 3=LINK)
Bits 1-0: Packet type (0=DATA, 1=ANNOUNCE, 2=LINKREQUEST, 3=PROOF)
```

## Header Layouts

### HEADER_1 (normal, direct/broadcast)

```
Offset  Size   Field
0       1      Flags byte
1       1      Hop count (0-255)
2       16     Destination hash
18      1      Context byte
19+     var    Payload (data/ciphertext)
```

Total header: 19 bytes. Max payload: 500 - 19 = 481 bytes.

### HEADER_2 (packet in transport, has transport ID)

```
Offset  Size   Field
0       1      Flags byte
1       1      Hop count
2       16     Transport ID (next-hop transport node hash)
18      16     Destination hash
34      1      Context byte
35+     var    Payload
```

Total header: 35 bytes. Max payload: 500 - 35 = 465 bytes.

**Note:** In HEADER_2, transport ID comes BEFORE destination hash.

## Packet Hash (for dedup)

Transport-independent — same logical packet produces the same hash regardless of HEADER_1 vs HEADER_2:

```
hashable = (flags & 0x0F)           // only lower 4 bits (destType + packetType)
         + raw[2:] for HEADER_1     // everything after flags+hops
         + raw[18:] for HEADER_2    // skip transport ID
packet_hash = SHA-256(hashable)
```

## Packet Types

| Value | Name | Description |
|-------|------|-------------|
| 0x00 | DATA | Application data |
| 0x01 | ANNOUNCE | Destination advertisement |
| 0x02 | LINKREQUEST | Link establishment request |
| 0x03 | PROOF | Cryptographic proof |

## Destination Types

| Value | Name | Description |
|-------|------|-------------|
| 0x00 | SINGLE | Encrypted, point-to-point (requires identity) |
| 0x01 | GROUP | Symmetric key (not multi-hop) |
| 0x02 | PLAIN | Unencrypted broadcast (local-only, hops <= 1) |
| 0x03 | LINK | Virtual encrypted channel |

## Context Codes

| Value | Name | Usage |
|-------|------|-------|
| 0x00 | NONE | General data |
| 0x01 | RESOURCE | Resource data segment |
| 0x02 | RESOURCE_ADV | Resource advertisement |
| 0x03 | RESOURCE_REQ | Resource request |
| 0x05 | RESOURCE_PRF | Resource proof |
| 0x09 | REQUEST | Link request/response API |
| 0x0A | RESPONSE | Link request/response API |
| 0x0E | CHANNEL | Channel message |
| 0xFA | KEEPALIVE | Link keepalive |
| 0xFB | LINKIDENTIFY | Link identity |
| 0xFC | LINKCLOSE | Link teardown |
| 0xFD | LINKPROOF | Link proof |
| 0xFE | LRRTT | Link RTT measurement |
| 0xFF | LRPROOF | Link request proof |

## Announce Data Layout

### Without ratchet (context_flag = 0)

```
Offset  Size   Field
0       64     Public key (32B X25519 + 32B Ed25519)
64      10     Name hash (SHA-256 of name string, truncated)
74      10     Random blob (5B random + 5B big-endian timestamp)
84      64     Ed25519 signature
148+    var    App data (optional)
```

### With ratchet (context_flag = 1)

```
Offset  Size   Field
0       64     Public key
64      10     Name hash
74      10     Random blob
84      32     Ratchet (X25519 public key)
116     64     Ed25519 signature
180+    var    App data (optional)
```

### Signed data

```
signed_data = destination_hash + public_key + name_hash + random_blob [+ ratchet] [+ app_data]
```

Note: `destination_hash` is in the packet header, not in the announce data blob. The signature binds the announce to its destination.

## Constants

| Constant | Value |
|----------|-------|
| MTU | 500 bytes |
| HEADER_MINSIZE | 19 bytes |
| MAX_HOPS | 128 |
| IDENTITY_HASH_LENGTH | 16 bytes |
| NAME_HASH_LENGTH | 10 bytes |
| SIGNATURE_LENGTH | 64 bytes |
| SHARED_INSTANCE_PORT | 37428 |
