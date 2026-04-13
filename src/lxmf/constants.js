/**
 * LXMF constants — matching the Python reference implementation (LXMF/LXMF.py, LXMRouter.py, LXMPeer.py).
 */

export const APP_NAME = 'lxmf';

// --- LXMRouter Constants ---

export const MAX_DELIVERY_ATTEMPTS = 5;
export const PROCESSING_INTERVAL = 4;          // seconds
export const DELIVERY_RETRY_WAIT = 10;         // seconds
export const PATH_REQUEST_WAIT = 7;            // seconds
export const LINK_MAX_INACTIVITY = 10 * 60;    // 10 minutes
export const P_LINK_MAX_INACTIVITY = 3 * 60;   // 3 minutes (propagation links)
export const MESSAGE_EXPIRY = 30 * 24 * 60 * 60; // 30 days

// Propagation node defaults
export const PROPAGATION_LIMIT = 256;          // KB per transfer
export const SYNC_LIMIT = PROPAGATION_LIMIT * 40; // 10240 KB per sync
export const DELIVERY_LIMIT = 1000;            // KB per delivery transfer

// Propagation transfer states (client-side)
export const PR_IDLE               = 0x00;
export const PR_PATH_REQUESTED     = 0x01;
export const PR_LINK_ESTABLISHING  = 0x02;
export const PR_LINK_ESTABLISHED   = 0x03;
export const PR_REQUEST_SENT       = 0x04;
export const PR_RECEIVING          = 0x05;
export const PR_RESPONSE_RECEIVED  = 0x06;
export const PR_COMPLETE           = 0x07;
export const PR_NO_PATH            = 0xF0;
export const PR_LINK_FAILED        = 0xF1;
export const PR_TRANSFER_FAILED    = 0xF2;
export const PR_NO_IDENTITY_RCVD   = 0xF3;
export const PR_NO_ACCESS          = 0xF4;
export const PR_FAILED             = 0xFE;
export const PR_ALL_MESSAGES       = 0x00;

// --- LXMPeer Constants ---

export const OFFER_REQUEST_PATH = '/offer';
export const MESSAGE_GET_PATH = '/get';

// Peer states
export const PEER_IDLE                  = 0x00;
export const PEER_LINK_ESTABLISHING     = 0x01;
export const PEER_LINK_READY            = 0x02;
export const PEER_REQUEST_SENT          = 0x03;
export const PEER_RESPONSE_RECEIVED     = 0x04;
export const PEER_RESOURCE_TRANSFERRING = 0x05;

// Peer errors
export const ERROR_NO_IDENTITY  = 0xF0;
export const ERROR_NO_ACCESS    = 0xF1;
export const ERROR_INVALID_KEY  = 0xF3;
export const ERROR_INVALID_DATA = 0xF4;
export const ERROR_INVALID_STAMP = 0xF5;
export const ERROR_THROTTLED    = 0xF6;
export const ERROR_NOT_FOUND    = 0xFD;
export const ERROR_TIMEOUT      = 0xFE;

// Peer sync strategies
export const STRATEGY_LAZY       = 0x01;
export const STRATEGY_PERSISTENT = 0x02;

// Peering defaults — match Python LXMF/LXMRouter.py:40-60
export const MAX_PEERS             = 20;
export const AUTOPEER              = true;
export const AUTOPEER_MAXDEPTH     = 4;
export const PEERING_COST          = 0;
export const MAX_PEERING_COST      = 255;
export const ROTATION_HEADROOM_PCT = 10;    // % of max_peers reserved for new peers
export const ROTATION_AR_MAX       = 0.5;   // drop peers with acceptance rate below this
export const PN_STAMP_THROTTLE     = 180;   // seconds — throttle duration
export const FASTEST_N_RANDOM_POOL = 8;     // top-N fastest peers for random selection
export const DEFAULT_SYNC_STRATEGY = STRATEGY_PERSISTENT;

// Control paths — match Python LXMF/LXMRouter.py:82-84
export const STATS_GET_PATH       = '/pn/get/stats';
export const SYNC_REQUEST_PATH    = '/pn/peer/sync';
export const UNPEER_REQUEST_PATH  = '/pn/peer/unpeer';

// LXMPeer timing — match Python LXMF/LXMPeer.py:37-50
export const PEER_MAX_UNREACHABLE   = 14 * 24 * 60 * 60; // 14 days
export const PEER_SYNC_BACKOFF_STEP = 12 * 60;            // 12 minutes
export const PEER_PATH_REQUEST_GRACE = 7.5;               // seconds

// Propagation node metadata keys
export const PN_META_NAME = 'name';
