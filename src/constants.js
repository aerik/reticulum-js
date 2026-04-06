/**
 * Protocol constants — matching the Python reference implementation.
 *
 * Source: RNS/Reticulum.py, RNS/Packet.py, RNS/Identity.py, RNS/Destination.py
 */

// --- Identity ---
export const IDENTITY_HASH_LENGTH = 16;       // bytes (128 bits, truncated SHA-256)
export const IDENTITY_KEY_LENGTH = 32;        // bytes per key (X25519 and Ed25519)
export const IDENTITY_KEYSIZE = 64;           // bytes (32 enc + 32 sig = full public key)
export const IDENTITY_SIGLENGTH = 64;         // Ed25519 signature length
export const IDENTITY_NAME_HASH_LENGTH = 10;  // bytes (80 bits, truncated SHA-256 of name)
export const IDENTITY_DERIVED_KEY_LENGTH = 64; // bytes from HKDF for encrypt/decrypt
export const IDENTITY_TOKEN_OVERHEAD = 48;    // 16 IV + (up to 16 pad) + 32 HMAC — but actual = 16+32=48 min
export const IDENTITY_RATCHETSIZE = 32;       // bytes (X25519 public key)

// --- Destination Types ---
export const DEST_SINGLE = 0x00;
export const DEST_GROUP  = 0x01;
export const DEST_PLAIN  = 0x02;
export const DEST_LINK   = 0x03;

// --- Destination Directions ---
export const DEST_IN  = 0x11;
export const DEST_OUT = 0x12;

// --- Packet Types (bits 1-0 of flags byte) ---
export const PACKET_DATA         = 0x00;
export const PACKET_ANNOUNCE     = 0x01;
export const PACKET_LINK_REQUEST = 0x02;
export const PACKET_PROOF        = 0x03;

// --- Transport Types (bit 4 of flags byte) ---
export const TRANSPORT_BROADCAST = 0x00;
export const TRANSPORT_TRANSPORT = 0x01;
export const TRANSPORT_RELAY     = 0x02;
export const TRANSPORT_TUNNEL    = 0x03;

// --- Header Types (bit 6 of flags byte) ---
export const HEADER_1 = 0x00;   // 1 address field (16 bytes)
export const HEADER_2 = 0x01;   // 2 address fields (32 bytes)

// --- Flags Byte Bit Layout ---
// Bit 7:    IFAC flag (interface access code present)
// Bit 6:    Header type (0=HEADER_1, 1=HEADER_2)
// Bit 5:    Context flag (0=unset, 1=set; used for ratchets in announces)
// Bit 4:    Transport type (0=BROADCAST, 1=TRANSPORT)
// Bits 3-2: Destination type (0=SINGLE, 1=GROUP, 2=PLAIN, 3=LINK)
// Bits 1-0: Packet type (0=DATA, 1=ANNOUNCE, 2=LINKREQUEST, 3=PROOF)
export const FLAG_UNSET = 0x00;
export const FLAG_SET   = 0x01;

// --- Packet Limits ---
export const MTU             = 500;     // Default MTU (LoRa-compatible)
export const HEADER_MINSIZE  = 2;       // Flags + hops
export const ADDR_SIZE       = 16;      // One address field (destination hash)
export const CONTEXT_SIZE    = 1;       // Context byte
export const MAX_HOPS        = 128;

// Packet overhead for header type 1 (flags + hops + 1 addr + context)
export const HEADER1_SIZE = HEADER_MINSIZE + ADDR_SIZE + CONTEXT_SIZE;    // 19 bytes
// Packet overhead for header type 2 (flags + hops + 2 addr + context)
export const HEADER2_SIZE = HEADER_MINSIZE + (ADDR_SIZE * 2) + CONTEXT_SIZE; // 35 bytes

// MDU = maximum data unit (payload capacity)
export const MDU = MTU - HEADER2_SIZE;  // 465 bytes (worst-case header)
// Encrypted MDU accounts for encryption overhead
export const ENCRYPTED_MDU = Math.floor((MDU - IDENTITY_TOKEN_OVERHEAD - IDENTITY_KEYSIZE / 16) / 16) * 16 - 1; // 383 bytes

// --- Link ---
export const LINK_CURVE = 'x25519';
export const LINK_KEYSIZE = 32;

// --- Announce ---
export const ANNOUNCE_SIGNATURE_LENGTH = 64;  // Ed25519 signature

// --- Reticulum ---
export const SHARED_INSTANCE_PORT   = 37428;
export const INSTANCE_CONTROL_PORT  = 37429;

// --- IFAC (Interface Access Code) ---
export const IFAC_NONE = 0x00;
export const DEFAULT_IFAC_SIZE = 16;   // bytes
export const IFAC_MIN_SIZE = 1;

// --- HDLC Framing ---
export const HDLC_FLAG     = 0x7E;
export const HDLC_ESC      = 0x7D;
export const HDLC_ESC_MASK = 0x20;

// --- KISS Framing ---
export const KISS_FEND     = 0xC0;
export const KISS_FESC     = 0xDB;
export const KISS_TFEND    = 0xDC;
export const KISS_TFESC    = 0xDD;
export const KISS_CMD_DATA = 0x00;

// --- TCP ---
export const TCP_INITIAL_CONNECT_TIMEOUT = 5;   // seconds
export const TCP_RECONNECT_WAIT          = 5;   // seconds
export const TCP_HW_MTU                  = 262144; // bytes

// --- Transport ---
export const PATHFINDER_RW  = 0.5;     // random window (seconds) for announce rebroadcast
export const PATHFINDER_E   = 604800;  // path expiry: 7 days (seconds)
export const PATHFINDER_R   = 1;       // max retries for announce rebroadcast
export const PATHFINDER_G   = 0;       // guard time

// --- Context Codes (application-level) ---
export const CONTEXT_NONE         = 0x00;
export const CONTEXT_RESOURCE     = 0x01;
export const CONTEXT_RESOURCE_ADV = 0x02;
export const CONTEXT_RESOURCE_REQ = 0x03;
export const CONTEXT_RESOURCE_HMU = 0x04;
export const CONTEXT_RESOURCE_PRF = 0x05;
export const CONTEXT_RESOURCE_ICL = 0x06;
export const CONTEXT_RESOURCE_RCL = 0x07;
export const CONTEXT_CACHE_REQUEST = 0x08;
export const CONTEXT_REQUEST      = 0x09;
export const CONTEXT_RESPONSE     = 0x0A;
export const CONTEXT_PATH_RESPONSE = 0x0B;
export const CONTEXT_COMMAND      = 0x0C;
export const CONTEXT_COMMAND_STATUS = 0x0D;
export const CONTEXT_CHANNEL      = 0x0E;
export const CONTEXT_KEEPALIVE    = 0xFA;
export const CONTEXT_LINKIDENTIFY = 0xFB;
export const CONTEXT_LINKCLOSE    = 0xFC;
export const CONTEXT_LINKPROOF    = 0xFD;
export const CONTEXT_LRRTT        = 0xFE;
export const CONTEXT_LRPROOF      = 0xFF;
