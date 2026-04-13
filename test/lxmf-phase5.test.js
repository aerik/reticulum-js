/**
 * Tests for LXMF Phase 5 — peer rotation, unreachable culling, throttling,
 * and the control destination (stats, sync, unpeer).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Transport } from '../src/Transport.js';
import { Identity } from '../src/Identity.js';
import { Destination } from '../src/Destination.js';
import { LXMRouter } from '../src/lxmf/LXMRouter.js';
import { LXMPeer } from '../src/lxmf/LXMPeer.js';
import { EventEmitter } from '../src/utils/events.js';
import { toHex, randomBytes, equal } from '../src/utils/bytes.js';
import {
  PEER_IDLE, ROTATION_AR_MAX, PEER_MAX_UNREACHABLE,
  PN_STAMP_THROTTLE, ERROR_THROTTLED, ERROR_NO_IDENTITY,
  ERROR_NOT_FOUND, ERROR_INVALID_DATA,
  STATS_GET_PATH, SYNC_REQUEST_PATH, UNPEER_REQUEST_PATH,
} from '../src/lxmf/constants.js';

class MockInterface extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.online = true;
    this.sent = [];
  }
  send(data) { this.sent.push(new Uint8Array(data)); }
}

function makeRouter(options = {}) {
  const iface = new MockInterface('mock');
  const transport = new Transport();
  transport.registerInterface(iface);
  const router = new LXMRouter(transport, { autoStart: false, ...options });
  return { router, transport, iface };
}

function addPeer(router, destHash, { offered = 0, outgoing = 0, alive = true, unhandled = 0 } = {}) {
  // Bypass router.peer() so tests can deliberately push past maxPeers
  // without triggering rotation. Constructs an LXMPeer directly.
  const peer = new LXMPeer(router, destHash);
  peer.alive = alive;
  peer.lastHeard = Date.now() / 1000;
  peer.peeringTimebase = 1000;
  peer.offered = offered;
  peer.outgoing = outgoing;
  peer.lastSyncAttempt = offered > 0 ? 1 : 0; // "tested" iff it has stats
  peer.propagationStampCost = 0;
  peer.propagationStampCostFlexibility = 0;
  peer.peeringCost = 0;
  peer.propagationTransferLimit = 256;
  peer.propagationSyncLimit = 256;
  router.peers.set(toHex(destHash), peer);
  if (unhandled > 0) {
    for (let i = 0; i < unhandled; i++) {
      const tidHex = `unhandled${i}_${toHex(destHash).slice(0, 8)}`;
      router.propagationEntries.set(tidHex, {
        destinationHash: randomBytes(16),
        data: randomBytes(100),
        received: Date.now() / 1000,
        size: 100,
        stampValue: 0,
        handledPeers: new Set(),
        unhandledPeers: new Set(),
      });
      peer.addUnhandledMessage(tidHex);
    }
  }
  return peer;
}

describe('LXMRouter.rotatePeers', () => {
  it('does nothing when under capacity', () => {
    const { router } = makeRouter({ maxPeers: 10 });
    addPeer(router, randomBytes(16), { offered: 10, outgoing: 1 });
    router.rotatePeers();
    expect(router.peers.size).toBe(1);
  });

  it('drops low-acceptance-rate peers when over capacity', () => {
    const { router } = makeRouter({ maxPeers: 3 });
    // Fill above capacity with known-tested peers.
    const good1 = randomBytes(16);
    const good2 = randomBytes(16);
    const bad = randomBytes(16);
    addPeer(router, good1, { offered: 10, outgoing: 10 });   // 100% AR
    addPeer(router, good2, { offered: 10, outgoing: 9 });    // 90% AR
    addPeer(router, bad, { offered: 10, outgoing: 1 });      // 10% AR
    // Force one over the (max_peers - headroom) threshold
    addPeer(router, randomBytes(16), { offered: 10, outgoing: 0 }); // 0% AR

    router.rotatePeers();
    // The worst peers should be dropped first.
    expect(router.peers.has(toHex(good1))).toBe(true);
    expect(router.peers.has(toHex(good2))).toBe(true);
    expect(router.peers.has(toHex(bad))).toBe(false);
  });

  it('skips rotation when untested peers fill the headroom', () => {
    const { router } = makeRouter({ maxPeers: 10 });
    // Fill above capacity entirely with untested peers (bypass peer() which
    // would call rotatePeers itself).
    for (let i = 0; i < 11; i++) {
      const h = randomBytes(16);
      const peer = new LXMPeer(router, h);
      peer.lastSyncAttempt = 0; // untested
      router.peers.set(toHex(h), peer);
    }
    expect(router.peers.size).toBe(11);
    router.rotatePeers();
    // Should not drop anyone — everyone is still being evaluated
    expect(router.peers.size).toBe(11);
  });

  it('does not drop peers with acceptance rate above threshold', () => {
    const { router } = makeRouter({ maxPeers: 2 });
    const p1 = randomBytes(16);
    const p2 = randomBytes(16);
    const p3 = randomBytes(16);
    addPeer(router, p1, { offered: 10, outgoing: 9 });
    addPeer(router, p2, { offered: 10, outgoing: 8 });
    addPeer(router, p3, { offered: 10, outgoing: 7 });
    router.rotatePeers();
    // All three have AR ≥ 70%, above the 50% threshold → no drops
    expect(router.peers.size).toBe(3);
  });

  it('does not drop static peers', () => {
    const { router } = makeRouter({ maxPeers: 2 });
    const staticHash = randomBytes(16);
    addPeer(router, staticHash, { offered: 10, outgoing: 0 }); // 0% AR
    router.staticPeers.add(toHex(staticHash));

    addPeer(router, randomBytes(16), { offered: 10, outgoing: 8 });
    addPeer(router, randomBytes(16), { offered: 10, outgoing: 9 });

    router.rotatePeers();
    expect(router.peers.has(toHex(staticHash))).toBe(true);
  });
});

describe('syncPeers unreachable culling', () => {
  it('removes peers not heard from within MAX_UNREACHABLE', () => {
    const { router } = makeRouter();
    const h1 = randomBytes(16);
    const h2 = randomBytes(16);
    addPeer(router, h1, { unhandled: 0 });
    addPeer(router, h2, { unhandled: 0 });
    // Age out the first peer
    const p1 = router.peers.get(toHex(h1));
    p1.lastHeard = (Date.now() / 1000) - PEER_MAX_UNREACHABLE - 1;

    router.syncPeers();
    expect(router.peers.has(toHex(h1))).toBe(false);
    expect(router.peers.has(toHex(h2))).toBe(true);
  });

  it('does not cull static peers regardless of lastHeard', () => {
    const { router } = makeRouter();
    const h = randomBytes(16);
    addPeer(router, h);
    router.staticPeers.add(toHex(h));
    const p = router.peers.get(toHex(h));
    p.lastHeard = 0;
    router.syncPeers();
    expect(router.peers.has(toHex(h))).toBe(true);
  });
});

describe('Throttled peers', () => {
  it('cleanThrottledPeers removes expired entries', () => {
    const { router } = makeRouter();
    const now = Date.now() / 1000;
    router.throttledPeers.set('expired_peer', now - 10);
    router.throttledPeers.set('active_peer', now + 100);
    router.cleanThrottledPeers();
    expect(router.throttledPeers.has('expired_peer')).toBe(false);
    expect(router.throttledPeers.has('active_peer')).toBe(true);
  });

  it('_offerRequest returns ERROR_THROTTLED for throttled peer', () => {
    const { router } = makeRouter();
    router.enablePropagation(Identity.generate());

    // Fake remote identity on a fake link
    const remoteIdentity = Identity.generate();
    const remoteDest = new Destination(remoteIdentity, 0x12, 0x00, 'lxmf', 'propagation');
    const fakeLink = { _remoteIdentity: remoteIdentity };

    // Throttle this peer
    router.throttledPeers.set(toHex(remoteDest.hash), (Date.now() / 1000) + 60);

    const response = router._offerRequest([null, [randomBytes(16)]], fakeLink);
    expect(response).toBe(ERROR_THROTTLED);
  });

  it('_offerRequest clears expired throttle and proceeds', () => {
    const { router } = makeRouter();
    router.enablePropagation(Identity.generate());

    const remoteIdentity = Identity.generate();
    const remoteDest = new Destination(remoteIdentity, 0x12, 0x00, 'lxmf', 'propagation');
    const fakeLink = { _remoteIdentity: remoteIdentity };

    // Expired throttle entry
    router.throttledPeers.set(toHex(remoteDest.hash), (Date.now() / 1000) - 10);

    const response = router._offerRequest([null, [randomBytes(16)]], fakeLink);
    // Should proceed — response is true (we want the new offered message)
    expect(response).toBe(true);
    // Expired entry should be cleaned
    expect(router.throttledPeers.has(toHex(remoteDest.hash))).toBe(false);
  });
});

describe('Control endpoint handlers', () => {
  let router;
  let identity;

  beforeEach(async () => {
    const mk = makeRouter();
    router = mk.router;
    identity = Identity.generate();
    await router.enablePropagation(identity);
  });

  it('control destination is created on enablePropagation', () => {
    expect(router.controlDestination).not.toBeNull();
    expect(router.controlDestination.requestHandlers.size).toBe(3);
  });

  it('controlAllowedList defaults to [identity.hash]', () => {
    expect(router.controlAllowedList).toHaveLength(1);
    expect(equal(router.controlAllowedList[0], identity.hash)).toBe(true);
  });

  describe('_statsGetRequest', () => {
    it('returns stats dict for valid caller', () => {
      const stats = router._statsGetRequest(identity);
      expect(stats).not.toBeNull();
      expect(stats.totalPeers).toBe(0);
      expect(stats.maxPeers).toBe(router.maxPeers);
      expect(stats.messagestore).toBeDefined();
      expect(stats.messagestore.count).toBe(0);
      expect(stats.peers).toBeDefined();
    });

    it('returns ERROR_NO_IDENTITY for null caller', () => {
      expect(router._statsGetRequest(null)).toBe(ERROR_NO_IDENTITY);
    });

    it('includes all peers in stats.peers map', () => {
      addPeer(router, randomBytes(16), { offered: 5, outgoing: 3 });
      addPeer(router, randomBytes(16), { offered: 10, outgoing: 8 });
      const stats = router._statsGetRequest(identity);
      expect(stats.totalPeers).toBe(2);
      expect(Object.keys(stats.peers)).toHaveLength(2);
      for (const peerStats of Object.values(stats.peers)) {
        expect(peerStats.messages).toBeDefined();
        expect(peerStats.acceptanceRate).toBeDefined();
      }
    });
  });

  describe('_peerSyncRequest', () => {
    it('triggers sync for known peer', () => {
      const destHash = randomBytes(16);
      const peer = addPeer(router, destHash, { unhandled: 1 });
      let syncCalled = false;
      peer.sync = async () => { syncCalled = true; return false; };
      const response = router._peerSyncRequest(destHash, identity);
      expect(response).toBe(true);
      expect(syncCalled).toBe(true);
    });

    it('returns ERROR_NOT_FOUND for unknown peer', () => {
      const response = router._peerSyncRequest(randomBytes(16), identity);
      expect(response).toBe(ERROR_NOT_FOUND);
    });

    it('returns ERROR_INVALID_DATA for wrong-size input', () => {
      expect(router._peerSyncRequest(new Uint8Array(10), identity)).toBe(ERROR_INVALID_DATA);
      expect(router._peerSyncRequest(null, identity)).toBe(ERROR_INVALID_DATA);
    });

    it('returns ERROR_NO_IDENTITY for unauthenticated caller', () => {
      expect(router._peerSyncRequest(randomBytes(16), null)).toBe(ERROR_NO_IDENTITY);
    });
  });

  describe('_peerUnpeerRequest', () => {
    it('removes the peer', () => {
      const destHash = randomBytes(16);
      addPeer(router, destHash);
      expect(router.peers.size).toBe(1);
      const response = router._peerUnpeerRequest(destHash, identity);
      expect(response).toBe(true);
      expect(router.peers.size).toBe(0);
    });

    it('returns ERROR_NOT_FOUND for unknown peer', () => {
      expect(router._peerUnpeerRequest(randomBytes(16), identity)).toBe(ERROR_NOT_FOUND);
    });

    it('returns ERROR_INVALID_DATA for wrong-size input', () => {
      expect(router._peerUnpeerRequest(new Uint8Array(10), identity)).toBe(ERROR_INVALID_DATA);
    });
  });
});

describe('compileStats', () => {
  it('returns null when not a propagation node', () => {
    const { router } = makeRouter();
    expect(router.compileStats()).toBeNull();
  });

  it('includes message store and peer counts', async () => {
    const { router } = makeRouter({ maxPeers: 15 });
    await router.enablePropagation(Identity.generate());

    // Add a peer and a propagation entry
    addPeer(router, randomBytes(16), { offered: 5, outgoing: 4 });
    router.propagationEntries.set('msg1', {
      destinationHash: randomBytes(16),
      data: randomBytes(500),
      received: Date.now() / 1000,
      size: 500,
      stampValue: 0,
      handledPeers: new Set(),
      unhandledPeers: new Set(),
    });

    const stats = router.compileStats();
    expect(stats.totalPeers).toBe(1);
    expect(stats.maxPeers).toBe(15);
    expect(stats.messagestore.count).toBe(1);
    expect(stats.messagestore.bytes).toBe(500);
    expect(stats.uptime).toBeGreaterThanOrEqual(0);
  });
});
