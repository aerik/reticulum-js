# LXMF Protocol Analysis for JavaScript Port

Analysis of the Python reference implementation at https://github.com/markqvist/LXMF (v0.9.4).
Performed 2026-04-06.

**Limitation:** LXMRouter.py is ~3000+ lines and was truncated during analysis. The methods
`lxmf_propagation()`, `process_outbound()`, `flush_peer_distribution_queue()`, and
`offer_request()` (server-side) could not be retrieved in full. These are documented based
on the calling code and protocol flow analysis. Everything else is from verbatim source.

---

## 1. LXMessage — The Message Format

### 1.1 Constants

```
# Message States
GENERATING  = 0x00
OUTBOUND    = 0x01
SENDING     = 0x02
SENT        = 0x04
DELIVERED   = 0x08
REJECTED    = 0xFD
CANCELLED   = 0xFE
FAILED      = 0xFF

# Representations (how the message is carried)
UNKNOWN     = 0x00
PACKET      = 0x01    # Fits in a single RNS packet
RESOURCE    = 0x02    # Sent as an RNS Resource (multi-packet transfer)

# Delivery Methods
OPPORTUNISTIC = 0x01  # Single encrypted packet, no link required
DIRECT        = 0x02  # Over an RNS Link (packet or resource)
PROPAGATED    = 0x03  # Via propagation node store-and-forward
PAPER         = 0x05  # QR code / URI

# Signature Verification Failure Reasons
SOURCE_UNKNOWN    = 0x01
SIGNATURE_INVALID = 0x02

# Ticket System
COST_TICKET    = 0x100   # Stamp value assigned to ticket-validated messages
TICKET_EXPIRY  = 21 days (in seconds)
TICKET_GRACE   = 5 days
TICKET_RENEW   = 14 days
TICKET_INTERVAL = 1 day
```

### 1.2 Size Constants

These depend on RNS constants. Based on standard Reticulum:

```
DESTINATION_LENGTH = RNS.Identity.TRUNCATED_HASHLENGTH // 8    = 16 bytes
SIGNATURE_LENGTH   = RNS.Identity.SIGLENGTH // 8               = 64 bytes (Ed25519)
TICKET_LENGTH      = RNS.Identity.TRUNCATED_HASHLENGTH // 8    = 16 bytes
TIMESTAMP_SIZE     = 8 bytes (double-precision float, msgpack)
STRUCT_OVERHEAD    = 8 bytes (msgpack array/map overhead)

LXMF_OVERHEAD = 2*DESTINATION_LENGTH + SIGNATURE_LENGTH + TIMESTAMP_SIZE + STRUCT_OVERHEAD
              = 2*16 + 64 + 8 + 8 = 112 bytes
```

Packet capacity (content after overhead):
```
ENCRYPTED_PACKET_MDU         = RNS.Packet.ENCRYPTED_MDU + TIMESTAMP_SIZE
ENCRYPTED_PACKET_MAX_CONTENT = ENCRYPTED_PACKET_MDU - LXMF_OVERHEAD + DESTINATION_LENGTH
LINK_PACKET_MDU              = RNS.Link.MDU
LINK_PACKET_MAX_CONTENT      = LINK_PACKET_MDU - LXMF_OVERHEAD
PLAIN_PACKET_MDU             = RNS.Packet.PLAIN_MDU
PLAIN_PACKET_MAX_CONTENT     = PLAIN_PACKET_MDU - LXMF_OVERHEAD + DESTINATION_LENGTH
PAPER_MDU                    = ((2953 - len("lxm://")) * 6) // 8
```

### 1.3 Instance Attributes

Constructor: `__init__(self, destination, source, content="", title="", fields=None,
                       desired_method=None, destination_hash=None, source_hash=None,
                       stamp_cost=None, include_ticket=False)`

Key attributes:
```
destination           # RNS.Destination object (or None for incoming)
destination_hash      # 16 bytes
source                # RNS.Destination object (or None for incoming)
source_hash           # 16 bytes
title                 # bytes (UTF-8 encoded)
content               # bytes (UTF-8 encoded)
fields                # dict (integer keys from FIELD_* constants)
payload               # [timestamp, title, content, fields] (set during pack)
timestamp             # float (Unix epoch, set during pack if None)
signature             # 64 bytes Ed25519
hash                  # 32 bytes (SHA-256, = message_id)
message_id            # alias for hash
transient_id          # 32 bytes (hash of propagation-encrypted data, used for propagation)
packed                # bytes (the complete wire-format message)
packed_size           # int
state                 # one of the state constants
method                # delivery method actually used
representation        # PACKET or RESOURCE
progress              # float 0.0-1.0
rssi, snr, q          # physical layer stats (if available)
incoming              # bool
signature_validated   # bool
unverified_reason     # SOURCE_UNKNOWN or SIGNATURE_INVALID

# Stamp system
stamp                 # bytes (proof-of-work stamp for destination)
stamp_cost            # int (required PoW difficulty)
stamp_value           # int (actual PoW difficulty achieved)
stamp_valid           # bool
stamp_checked         # bool
propagation_stamp     # bytes (separate PoW stamp for propagation node)
propagation_stamp_value # int
propagation_stamp_valid # bool
propagation_target_cost # int
defer_stamp           # bool (default True - generate stamp lazily)
defer_propagation_stamp # bool (default True)
outbound_ticket       # bytes (16 bytes, pre-authorized reply token)
include_ticket        # bool (include a ticket for the recipient to reply)
ratchet_id            # ratchet identifier for forward secrecy

# Transport
transport_encrypted    # bool
transport_encryption   # string description: "Curve25519", "AES-128", or "Unencrypted"
```

### 1.4 Wire Format — pack()

#### Payload Construction

```python
payload = [timestamp, title, content, fields]
# If stamp is ready: payload = [timestamp, title, content, fields, stamp]
```

Payload is msgpack-encoded as an array.

#### Hash Computation

```python
hashed_part = destination_hash + source_hash + msgpack.pack(payload)
message_hash = SHA256(hashed_part)    # RNS.Identity.full_hash
message_id = message_hash             # 32 bytes
```

**IMPORTANT:** The hash is computed over the 4-element payload (WITHOUT the stamp).
If the stamp is appended (as element [4]), the payload is re-packed for signing but
the hash was already computed on the stamp-less version.

#### Signature

```python
signed_part = hashed_part + message_hash
            = destination_hash + source_hash + msgpack.pack(payload) + message_hash
signature = Ed25519_sign(source_private_key, signed_part)   # 64 bytes
```

The signature is computed over the stamp-less payload concatenated with its hash.

#### Packed Wire Format (DIRECT / base format)

```
Offset  Length  Field
------  ------  -----
0       16      destination_hash
16      16      source_hash
32      64      signature (Ed25519)
96      var     msgpack([timestamp, title, content, fields, ?stamp])
```

Total header: 96 bytes fixed, then variable msgpack payload.

#### OPPORTUNISTIC Format

When sent as a single encrypted packet to a SINGLE destination:
```
# The destination_hash is implicit (it's the packet destination)
# So the packet data is: packed[DESTINATION_LENGTH:]
Offset  Length  Field
------  ------  -----
0       16      source_hash
16      64      signature
80      var     msgpack(payload)
```

The receiving side prepends the destination hash from the packet metadata.

#### PROPAGATED Format

For propagation, the message is encrypted end-to-end before being wrapped:

```python
# Inner: encrypt everything after destination_hash with destination's public key
pn_encrypted_data = destination.encrypt(packed[DESTINATION_LENGTH:])
# This encrypts: source_hash + signature + msgpack(payload)

# Propagation data = destination_hash + encrypted_blob
lxmf_data = packed[:DESTINATION_LENGTH] + pn_encrypted_data

# Transient ID (used for dedup on propagation nodes)
transient_id = SHA256(lxmf_data)

# If propagation stamp exists, append it
if propagation_stamp: lxmf_data += propagation_stamp

# Final propagation packet wraps in a timestamped list
propagation_packed = msgpack.pack([time.time(), [lxmf_data]])
```

The propagation_packed format is: `msgpack([timestamp, [lxmf_data, ...]])` — an array
with a float timestamp and an array of one or more lxmf_data blobs.

**Propagation node storage format:** The raw `lxmf_data` is stored to disk (including
any propagation stamp). The file is named: `{hex(transient_id)}_{timestamp}_{stamp_value}`

#### PAPER Format

```python
encrypted_data = destination.encrypt(packed[DESTINATION_LENGTH:])
paper_packed = packed[:DESTINATION_LENGTH] + encrypted_data
# Encoded as URI: lxm://{base32(paper_packed)} or QR code
```

### 1.5 Unpacking — unpack_from_bytes()

```python
destination_hash = lxmf_bytes[0:16]
source_hash      = lxmf_bytes[16:32]
signature        = lxmf_bytes[32:96]
packed_payload   = lxmf_bytes[96:]

unpacked_payload = msgpack.unpack(packed_payload)

# Extract stamp if present (5th element)
if len(unpacked_payload) > 4:
    stamp = unpacked_payload[4]
    unpacked_payload = unpacked_payload[:4]    # Strip stamp for hash verification
    packed_payload = msgpack.pack(unpacked_payload)  # Re-pack without stamp
else:
    stamp = None

# Verify hash
hashed_part = destination_hash + source_hash + packed_payload  # stamp-less
message_hash = SHA256(hashed_part)

# Verify signature
signed_part = hashed_part + message_hash
valid = Ed25519_verify(source_public_key, signature, signed_part)

timestamp = unpacked_payload[0]   # float
title     = unpacked_payload[1]   # bytes
content   = unpacked_payload[2]   # bytes
fields    = unpacked_payload[3]   # dict
```

### 1.6 Container Format (for disk persistence)

```python
container = {
    "state": int,
    "lxmf_bytes": bytes,          # The packed wire format
    "transport_encrypted": bool,
    "transport_encryption": str,
    "method": int
}
# Serialized with msgpack
```

### 1.7 Stamp System

Stamps are proof-of-work tokens that prevent spam. Two types exist:
- **Destination stamp**: proves work to the message recipient
- **Propagation stamp**: proves work to the propagation node

#### Stamp Generation (LXStamper)

```python
WORKBLOCK_EXPAND_ROUNDS         = 3000    # For destination stamps
WORKBLOCK_EXPAND_ROUNDS_PN      = 1000    # For propagation node stamps
WORKBLOCK_EXPAND_ROUNDS_PEERING = 25      # For peering keys
STAMP_SIZE = RNS.Identity.HASHLENGTH // 8 = 32 bytes
```

**Workblock generation:**
```python
def stamp_workblock(material, expand_rounds=3000):
    workblock = b""
    for n in range(expand_rounds):
        workblock += HKDF(
            length=256,
            derive_from=material,
            salt=SHA256(material + msgpack.pack(n)),
            context=None
        )
    return workblock   # expand_rounds * 256 bytes
```

**Stamp validation:**
```python
def stamp_valid(stamp, target_cost, workblock):
    target = 1 << (256 - target_cost)
    result = SHA256(workblock + stamp)    # 32 bytes
    return int.from_bytes(result, "big") <= target
```

**Stamp value (leading zero bits):**
```python
def stamp_value(workblock, stamp):
    material = SHA256(workblock + stamp)
    # Count leading zero bits
    i = int.from_bytes(material, "big")
    value = 0
    while ((i & (1 << 255)) == 0):
        i <<= 1
        value += 1
    return value
```

**Ticket-based stamp bypass:**
```python
# A ticket is 16 random bytes issued by the destination
# Stamp from ticket: truncated_hash(ticket + message_id)
generated_stamp = RNS.Identity.truncated_hash(ticket + message_id)
# Stamp value is set to COST_TICKET (0x100 = 256), always passes
```

---

## 2. LXMF Field Constants (LXMF.py)

```python
APP_NAME = "lxmf"

# Core message fields (dict keys in LXMessage.fields)
FIELD_EMBEDDED_LXMS    = 0x01   # Embedded LXMF messages
FIELD_TELEMETRY        = 0x02   # Telemetry data
FIELD_TELEMETRY_STREAM = 0x03   # Streaming telemetry
FIELD_ICON_APPEARANCE  = 0x04   # Icon/avatar
FIELD_FILE_ATTACHMENTS = 0x05   # File attachments
FIELD_IMAGE            = 0x06   # Image data
FIELD_AUDIO            = 0x07   # Audio data
FIELD_THREAD           = 0x08   # Thread reference
FIELD_COMMANDS         = 0x09   # Commands
FIELD_RESULTS          = 0x0A   # Command results
FIELD_GROUP            = 0x0B   # Group messaging
FIELD_TICKET           = 0x0C   # Reply ticket [expires, ticket_bytes]
FIELD_EVENT            = 0x0D   # Event data
FIELD_RNR_REFS         = 0x0E   # RNR references
FIELD_RENDERER         = 0x0F   # Content renderer hint

FIELD_CUSTOM_TYPE      = 0xFB   # Custom type identifier
FIELD_CUSTOM_DATA      = 0xFC   # Custom data
FIELD_CUSTOM_META      = 0xFD   # Custom metadata

FIELD_NON_SPECIFIC     = 0xFE   # Non-specific field
FIELD_DEBUG            = 0xFF   # Debug data

# Audio Modes (for FIELD_AUDIO)
AM_CODEC2_450PWB  = 0x01    AM_CODEC2_450   = 0x02    AM_CODEC2_700C   = 0x03
AM_CODEC2_1200    = 0x04    AM_CODEC2_1300  = 0x05    AM_CODEC2_1400   = 0x06
AM_CODEC2_1600    = 0x07    AM_CODEC2_2400  = 0x08    AM_CODEC2_3200   = 0x09
AM_OPUS_OGG       = 0x10    AM_OPUS_LBW     = 0x11    AM_OPUS_MBW      = 0x12
AM_OPUS_PTT       = 0x13    AM_OPUS_RT_HDX  = 0x14    AM_OPUS_RT_FDX   = 0x15
AM_OPUS_STANDARD  = 0x16    AM_OPUS_HQ      = 0x17    AM_OPUS_BROADCAST= 0x18
AM_OPUS_LOSSLESS  = 0x19    AM_CUSTOM       = 0xFF

# Renderer Types (for FIELD_RENDERER)
RENDERER_PLAIN    = 0x00
RENDERER_MICRON   = 0x01
RENDERER_MARKDOWN = 0x02
RENDERER_BBCODE   = 0x03

# Propagation Node Metadata Fields (in announce app_data)
PN_META_VERSION       = 0x00
PN_META_NAME          = 0x01
PN_META_SYNC_STRATUM  = 0x02
PN_META_SYNC_THROTTLE = 0x03
PN_META_AUTH_BAND     = 0x04
PN_META_UTIL_PRESSURE = 0x05
PN_META_CUSTOM        = 0xFF
```

### Announce App Data Formats

**Delivery destination announce** (v0.5.0+):
```python
app_data = msgpack.pack([display_name_bytes_or_None, stamp_cost_or_None])
```

**Propagation node announce:**
```python
app_data = msgpack.pack([
    peering_key_or_None,                    # [0] peering key
    timebase_int,                           # [1] peering timebase
    propagation_enabled_bool,               # [2] is propagation node
    propagation_transfer_limit_int,         # [3] per-transfer size limit (KB)
    propagation_sync_limit_int,             # [4] per-sync size limit (KB)
    [stamp_cost, cost_flexibility, peering_cost],  # [5] stamp costs
    {metadata_dict}                         # [6] PN_META_* fields
])
```

---

## 3. LXMRouter — Routing & Delivery Engine

### 3.1 Constants

```python
MAX_DELIVERY_ATTEMPTS   = 5
PROCESSING_INTERVAL     = 4        # seconds between job loop iterations
DELIVERY_RETRY_WAIT     = 10       # seconds between delivery retries
PATH_REQUEST_WAIT       = 7        # seconds to wait for path after request
MAX_PATHLESS_TRIES      = 1
LINK_MAX_INACTIVITY     = 10*60    # 10 minutes
P_LINK_MAX_INACTIVITY   = 3*60     # 3 minutes for propagation links
MESSAGE_EXPIRY          = 30*24*60*60   # 30 days

STAMP_COST_EXPIRY       = 45*24*60*60   # 45 days

# Propagation Node Defaults
NODE_ANNOUNCE_DELAY     = 20       # seconds
MAX_PEERS               = 20
AUTOPEER                = True
AUTOPEER_MAXDEPTH       = 4        # max hops for auto-peering
FASTEST_N_RANDOM_POOL   = 2
ROTATION_HEADROOM_PCT   = 10
ROTATION_AR_MAX         = 0.5

# Stamp Costs
PEERING_COST            = 18       # PoW cost for peering key
MAX_PEERING_COST        = 26       # max accepted peering cost
PROPAGATION_COST_MIN    = 13       # minimum propagation stamp cost
PROPAGATION_COST_FLEX   = 3        # flexibility window
PROPAGATION_COST        = 16       # default propagation stamp cost

# Transfer Limits
PROPAGATION_LIMIT       = 256      # KB per propagation transfer
SYNC_LIMIT              = PROPAGATION_LIMIT * 40  # = 10240 KB per sync
DELIVERY_LIMIT          = 1000     # KB per delivery transfer

# Propagation Transfer States (client-side)
PR_IDLE                 = 0x00
PR_PATH_REQUESTED       = 0x01
PR_LINK_ESTABLISHING    = 0x02
PR_LINK_ESTABLISHED     = 0x03
PR_REQUEST_SENT         = 0x04
PR_RECEIVING            = 0x05
PR_RESPONSE_RECEIVED    = 0x06
PR_COMPLETE             = 0x07
PR_NO_PATH              = 0xF0
PR_LINK_FAILED          = 0xF1
PR_TRANSFER_FAILED      = 0xF2
PR_NO_IDENTITY_RCVD     = 0xF3
PR_NO_ACCESS            = 0xF4
PR_FAILED               = 0xFE

PR_ALL_MESSAGES         = 0x00

# Throttling
PN_STAMP_THROTTLE       = 180      # seconds

# Job Intervals (multiplied by PROCESSING_INTERVAL = 4s)
JOB_OUTBOUND_INTERVAL   = 1        # every 4s
JOB_STAMPS_INTERVAL     = 1        # every 4s
JOB_LINKS_INTERVAL      = 1        # every 4s
JOB_TRANSIENT_INTERVAL  = 60       # every 240s = 4 min
JOB_STORE_INTERVAL      = 120      # every 480s = 8 min
JOB_PEERSYNC_INTERVAL   = 6        # every 24s
JOB_PEERINGEST_INTERVAL = 6        # same as peersync
JOB_ROTATE_INTERVAL     = 336      # every 1344s ≈ 22 min

# Request Paths
STATS_GET_PATH          = "/pn/get/stats"
SYNC_REQUEST_PATH       = "/pn/peer/sync"
UNPEER_REQUEST_PATH     = "/pn/peer/unpeer"
DUPLICATE_SIGNAL        = "lxmf_duplicate"
```

### 3.2 Destinations

The router creates two RNS destinations:

1. **Delivery destination** (`lxmf.delivery`):
   - Created per registered identity via `register_delivery_identity()`
   - SINGLE destination type
   - Receives direct messages via packet callback and link callback
   - Supports ratchets for forward secrecy
   - Announce app_data: `msgpack([display_name, stamp_cost])`

2. **Propagation destination** (`lxmf.propagation`):
   - Created in `__init__()`, activated in `enable_propagation()`
   - SINGLE destination type
   - Registered request handlers:
     - `LXMPeer.OFFER_REQUEST_PATH` ("/offer") → `self.offer_request`
     - `LXMPeer.MESSAGE_GET_PATH` ("/get") → `self.message_get_request`
   - Announce app_data: `msgpack([key, timebase, enabled, transfer_limit, sync_limit, [stamp_cost, flex, peering_cost], {metadata}])`

3. **Control destination** (`lxmf.propagation.control`) — for node administration:
   - Request handlers for stats, sync, unpeer
   - Access restricted to node's own identity

### 3.3 Delivery Flow

#### Delivery via Link Setup

```python
delivery_link_established(link):
    link.track_phy_stats(True)
    link.set_packet_callback(self.delivery_packet)
    link.set_resource_strategy(RNS.Link.ACCEPT_APP)
    link.set_resource_callback(self.delivery_resource_advertised)
    link.set_resource_started_callback(self.resource_transfer_began)
    link.set_resource_concluded_callback(self.delivery_resource_concluded)
    link.set_remote_identified_callback(self.delivery_remote_identified)
```

#### Receiving a Direct Packet

```python
delivery_packet(data, packet):
    packet.prove()  # Send delivery receipt
    if packet.destination_type != RNS.Destination.LINK:
        # OPPORTUNISTIC: prepend destination hash
        method = LXMessage.OPPORTUNISTIC
        lxmf_data = packet.destination.hash + data
    else:
        # DIRECT via link: data is complete
        method = LXMessage.DIRECT
        lxmf_data = data
    
    lxmf_delivery(lxmf_data, packet.destination_type, phy_stats, ratchet_id, method)
```

#### Receiving a Direct Resource

```python
delivery_resource_concluded(resource):
    if resource.status == RNS.Resource.COMPLETE:
        lxmf_delivery(resource.data.read(), resource.link.type, phy_stats, ratchet_id, method=DIRECT)
```

#### The lxmf_delivery() Handler

```python
lxmf_delivery(lxmf_data, destination_type, phy_stats, ratchet_id, method, no_stamp_enforcement, allow_duplicate):
    1. Unpack message from bytes
    2. Extract and remember any included ticket (FIELD_TICKET)
    3. Validate stamp against required cost (using destination tickets for bypass)
    4. If stamp invalid and enforcement enabled → drop message
    5. Set transport encryption info based on destination_type
    6. Check ignored list → drop if source is ignored
    7. Check for duplicate (by message hash) → drop if already received
    8. Record in locally_delivered_transient_ids
    9. Call external delivery callback
```

### 3.4 Outbound Message Flow

#### handle_outbound(lxmessage)

```python
1. Auto-configure stamp_cost from cached announce data if not set
2. Set state to OUTBOUND
3. Attach outbound ticket if available for destination
4. If include_ticket requested, generate and attach as FIELD_TICKET
5. Pack the message (determines method/representation)
6. If OPPORTUNISTIC and no path known, request path + delay
7. Set transport encryption description
8. If stamps not deferred → add to pending_outbound + trigger process_outbound()
9. If stamps deferred → add to pending_deferred_stamps (processed by job loop)
```

#### process_outbound() (inferred from calling code)

Iterates `pending_outbound`, for each message:
- Checks delivery attempts < MAX_DELIVERY_ATTEMPTS (5)
- For OPPORTUNISTIC: sends as single encrypted packet
- For DIRECT: establishes link, sends as packet or resource based on size
- For PROPAGATED: sends to propagation node link as packet or resource
- Handles retries with DELIVERY_RETRY_WAIT (10s) between attempts
- Moves to failed_outbound on max attempts exceeded

### 3.5 Propagation Node — Message Storage

#### Storage Structure

```
{storagepath}/lxmf/
├── messagestore/           # Propagated messages
│   └── {hex_transient_id}_{timestamp}_{stamp_value}
├── peers                   # msgpack serialized peer list
├── local_deliveries        # msgpack dict of delivered message hashes
├── locally_processed       # msgpack dict of processed transient IDs
├── outbound_stamp_costs    # msgpack dict of {dest_hash: [time, cost]}
├── available_tickets       # msgpack dict with outbound/inbound/last_deliveries
├── node_stats              # msgpack dict of node statistics
└── ratchets/               # Ratchet state files
    └── {hex_dest_hash}.ratchets
```

#### Propagation Entry Index (in-memory)

```python
propagation_entries[transient_id] = [
    destination_hash,    # [0] 16 bytes - who this message is for
    filepath,            # [1] string - path to stored file
    received_timestamp,  # [2] float - when received
    msg_size,            # [3] int - file size in bytes
    handled_peers,       # [4] list of peer destination_hashes that have this message
    unhandled_peers,     # [5] list of peer destination_hashes that need this message
    stamp_value,         # [6] int - PoW stamp value
]
```

#### Message File Format

The stored file contains raw `lxmf_data`:
```
Offset  Length  Field
------  ------  -----
0       16      destination_hash (plaintext, used for routing)
16      var     encrypted blob (source_hash + signature + msgpack(payload))
var     32      propagation_stamp (optional, appended at end)
```

The first 16 bytes are read on indexing to determine the destination_hash.
On serving to a client, the last STAMP_SIZE (32) bytes are stripped:
`response_messages.append(lxmf_data[:-LXStamper.STAMP_SIZE])`

#### Message Weight (for storage cleanup priority)

```python
def get_weight(transient_id):
    age_weight = max(1, (now - received) / 60 / 60 / 24 / 4)  # Age in quarter-days
    priority_weight = 0.1 if dest_hash in prioritised_list else 1.0
    return priority_weight * age_weight * msg_size
# Higher weight = cleaned first. Prioritised messages have 10x lower weight.
```

### 3.6 Propagation Sync Protocol

#### Overview

Two separate sync protocols exist:
1. **Client ↔ Propagation Node**: Client downloads its own messages
2. **Propagation Node ↔ Propagation Node (Peer Sync)**: Nodes exchange messages for all destinations

#### Client Download Protocol

```
Client                              Propagation Node
  |                                       |
  |--- Link establish ------------------>|
  |<-- Link established ------------------|
  |                                       |
  |--- identify(client_identity) -------->|
  |                                       |
  |--- request("/get", [None, None]) ---->|  "List my messages"
  |<-- response: [transient_id, ...] -----|  List of available message IDs
  |                                       |
  |--- request("/get",                    |
  |      [wanted_ids, have_ids,           |  "Send me these, delete those"
  |       transfer_limit]) -------------->|
  |<-- response: [lxmf_data, ...] --------|  Message data blobs
  |                                       |
  |--- request("/get",                    |
  |      [None, received_ids]) ---------->|  "Confirm receipt, delete these"
  |                                       |
```

**message_get_request()** (server-side handler):
- If `data = [None, None]`: returns list of `[transient_id, ...]` for messages matching the identified client
- If `data = [wanted_ids, have_ids, ?transfer_limit]`:
  - Deletes messages in `have_ids` from store
  - Returns `[lxmf_data, ...]` for `wanted_ids`, respecting `transfer_limit`
  - Strips propagation stamp from returned data: `lxmf_data[:-STAMP_SIZE]`

**message_list_response()** (client-side callback):
- Compares server's list against local `has_message()` check
- Builds `wants` list (up to `propagation_transfer_max_messages`)
- Builds `haves` list (already have, can delete on server if `!retain_synced_on_node`)
- Sends second request with `[wants, haves, delivery_per_transfer_limit]`

**message_get_response()** (client-side callback):
- For each received `lxmf_data`, calls `lxmf_propagation()` to ingest
- Sends confirmation request `[None, received_hashes]` to delete from server

#### Peer-to-Peer Sync Protocol

```
Local Node                          Remote Peer Node
  |                                       |
  |--- Link establish ------------------>|
  |<-- link_established ------------------|
  |                                       |
  |--- identify(local_identity) -------->|
  |                                       |
  |--- request("/offer",                  |
  |      [peering_key, [tid, ...]]) ----->|  "I have these messages for you"
  |<-- response --------------------------|  One of:
  |    ERROR_NO_IDENTITY                  |  - Need identification
  |    ERROR_NO_ACCESS                    |  - Access denied
  |    ERROR_THROTTLED                    |  - Rate limited
  |    False                              |  - Don't want any
  |    True                               |  - Want all
  |    [tid, ...]                         |  - Want these specific ones
  |                                       |
  |--- RNS.Resource(msgpack(             |
  |      [timestamp, [lxm_data, ...]]))-->|  Send wanted messages
  |<-- Resource.COMPLETE ------------------|  Transfer confirmed
  |                                       |
  |--- Link teardown -------------------->|
```

**Offer construction** (in `LXMPeer.sync()`):
```python
# Build offer list sorted by weight, respecting size limits
offer = [peering_key[0], unhandled_ids]   # peering_key[0] is the stamp bytes

# Size tracking:
per_message_overhead = 16  # bytes per message in transfer
cumulative_size = 24       # initial overhead

# Each message checked against:
# - propagation_transfer_limit (per-message max, in KB)
# - propagation_sync_limit (total sync max, in KB)
```

**offer_request()** (server-side, inferred from offer_response client-side):
- Validates remote identity
- Validates peering key
- Checks which offered transient_ids are wanted (not already in propagation_entries)
- Returns: `False` (want none), `True` (want all), or `[wanted_tid, ...]`

**offer_response()** (client-side, after receiving server's reply):
- For messages not wanted: moves from unhandled → handled
- For wanted messages: reads files from disk, builds transfer:
  ```python
  data = msgpack.pack([time.time(), lxm_list])  # Same format as propagation_packed
  resource = RNS.Resource(data, link, callback=resource_concluded)
  ```
- On transfer complete: marks all as handled, updates stats

**resource_concluded()** (client-side, after transfer completes):
- Marks transferred messages as handled
- If STRATEGY_PERSISTENT and more unhandled messages exist, calls `sync()` again

### 3.7 Peer Management

#### LXMPeer Constants

```python
OFFER_REQUEST_PATH = "/offer"
MESSAGE_GET_PATH   = "/get"

# States
IDLE                  = 0x00
LINK_ESTABLISHING     = 0x01
LINK_READY            = 0x02
REQUEST_SENT          = 0x03
RESPONSE_RECEIVED     = 0x04
RESOURCE_TRANSFERRING = 0x05

# Errors
ERROR_NO_IDENTITY     = 0xF0
ERROR_NO_ACCESS       = 0xF1
ERROR_INVALID_KEY     = 0xF3
ERROR_INVALID_DATA    = 0xF4
ERROR_INVALID_STAMP   = 0xF5
ERROR_THROTTLED       = 0xF6
ERROR_NOT_FOUND       = 0xFD
ERROR_TIMEOUT         = 0xFE

# Strategies
STRATEGY_LAZY         = 0x01    # Only sync when explicitly triggered
STRATEGY_PERSISTENT   = 0x02    # Auto-sync until all messages delivered

MAX_UNREACHABLE       = 14 days (in seconds)
SYNC_BACKOFF_STEP     = 12 minutes (in seconds)
PATH_REQUEST_GRACE    = 7.5 seconds
```

#### Peer Serialization

```python
# to_bytes() produces msgpack dict with:
{
    "destination_hash": bytes,
    "peering_timebase": int,
    "alive": bool,
    "last_heard": float,
    "link_establishment_rate": float,
    "sync_transfer_rate": float,
    "propagation_transfer_limit": float,
    "propagation_sync_limit": int,
    "propagation_stamp_cost": int,
    "propagation_stamp_cost_flexibility": int,
    "peering_cost": int,
    "sync_strategy": int,
    "last_sync_attempt": float,
    "peering_key": [stamp_bytes, value] or None,
    "metadata": dict or None,
    "offered": int,
    "outgoing": int,
    "incoming": int,
    "rx_bytes": int,
    "tx_bytes": int,
    "handled_ids": [transient_id, ...],
    "unhandled_ids": [transient_id, ...],
}
```

#### Peering Key

A peering key is a proof-of-work stamp computed over:
```python
key_material = peer_identity.hash + local_identity.hash
peering_key, value = LXStamper.generate_stamp(
    key_material, 
    peering_cost,
    expand_rounds=WORKBLOCK_EXPAND_ROUNDS_PEERING  # 25
)
# Stored as [stamp_bytes, value_int]
```

### 3.8 Ticket System

Tickets allow pre-authorized replies without PoW stamps.

**Generation** (by message recipient, attached to outgoing messages):
```python
ticket = os.urandom(16)  # TICKET_LENGTH = 16 bytes
expires = now + TICKET_EXPIRY  # 21 days
field_value = [expires, ticket]  # Stored in FIELD_TICKET (0x0C)
```

**Storage:**
```python
available_tickets = {
    "outbound": {destination_hash: [expires, ticket_bytes]},
    "inbound": {destination_hash: {ticket_bytes: [expires]}},
    "last_deliveries": {destination_hash: timestamp}
}
```

**Validation** (on incoming message):
```python
for ticket in inbound_tickets:
    if stamp == truncated_hash(ticket + message_id):
        stamp_value = COST_TICKET  # 0x100 = 256, always valid
        return True
```

### 3.9 Transport Encryption Labels

Set during delivery based on how the message arrived:
```python
SINGLE destination → "Curve25519" (asymmetric)
GROUP destination  → "AES-128" (symmetric)
LINK destination   → "Curve25519" (link-layer)
Other              → None (unencrypted)
```

---

## 4. Key Implementation Notes for JS Port

### 4.1 Cryptographic Primitives Required

- **Ed25519**: Sign/verify (64-byte signatures)
- **X25519/Curve25519**: Key exchange (for RNS link encryption)
- **SHA-256**: Hashing (RNS.Identity.full_hash)
- **Truncated SHA-256**: First 16 bytes of SHA-256 (RNS.Identity.truncated_hash)
- **HKDF**: For stamp workblock generation
- **AES-128**: For GROUP destination encryption (rarely used in LXMF context)

### 4.2 Serialization

- **msgpack**: Used everywhere. Must be binary-compatible with Python's umsgpack.
  - Timestamps are float64 (msgpack float)
  - Payloads are arrays: `[timestamp, title, content, fields]`
  - Fields dict uses integer keys
  - Title and content are raw bytes (UTF-8)

### 4.3 Critical Wire Compatibility Points

1. **Hash computation**: Must match exactly — `SHA256(dest_hash + src_hash + msgpack([ts, title, content, fields]))`
2. **Signature**: Over `hash_input + SHA256(hash_input)` — the hash is appended to its own input
3. **Stamp**: The stamp is element [4] of the payload array, but excluded from hash computation
4. **Propagation wrapping**: `dest_hash + encrypt(src_hash + sig + msgpack(payload))`
5. **Propagation transfer format**: `msgpack([timestamp, [lxmf_data_blob, ...]])`
6. **Transient ID**: `SHA256(dest_hash + encrypted_blob)` — before propagation stamp is appended
7. **File naming**: `{hex(transient_id)}_{float_timestamp}_{int_stamp_value}`

### 4.4 RNS Dependencies

LXMF relies heavily on these RNS primitives:
- `RNS.Identity` — key management, signing, encryption, hashing
- `RNS.Destination` — addressing (SINGLE, GROUP, PLAIN types)
- `RNS.Link` — reliable bidirectional channels
- `RNS.Packet` — single-shot data delivery
- `RNS.Resource` — multi-packet reliable transfer
- `RNS.Transport` — path discovery, announce handling

### 4.5 Message Size Limits Summary

| Method | Max Content | Notes |
|--------|-------------|-------|
| Opportunistic (SINGLE) | ~295 bytes | ENCRYPTED_PACKET_MAX_CONTENT |
| Opportunistic (PLAIN) | ~368 bytes | PLAIN_PACKET_MAX_CONTENT |
| Direct (packet) | LINK_PACKET_MAX_CONTENT | Sent over established link |
| Direct (resource) | Unlimited* | Multi-packet transfer |
| Propagated (packet) | LINK_PACKET_MAX_CONTENT | Rare, very small messages only |
| Propagated (resource) | PROPAGATION_LIMIT * 1000 | Default 256 KB |
| Paper | ~2210 bytes | QR code capacity |

*Subject to DELIVERY_LIMIT (default 1000 KB per transfer)

### 4.6 Propagation Transfer Limit

Default: 256 KB per single transfer, 10240 KB (10 MB) per full sync session.
These are configurable per node and communicated in announce app_data.
