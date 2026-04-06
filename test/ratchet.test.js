import { describe, it, expect } from 'vitest';
import { Identity } from '../src/Identity.js';
import { Destination } from '../src/Destination.js';
import { Packet } from '../src/Packet.js';
import { createAnnounce, validateAnnounce } from '../src/Announce.js';
import { equal, fromUtf8 } from '../src/utils/bytes.js';
import { DEST_SINGLE, DEST_IN, FLAG_SET, FLAG_UNSET } from '../src/constants.js';

describe('Ratchet key management', () => {
  it('rotateRatchet returns 32-byte public key', () => {
    const id = Identity.generate();
    const pub = id.rotateRatchet();
    expect(pub).toHaveLength(32);
    expect(id.ratchetPublicKey).not.toBeNull();
    expect(equal(id.ratchetPublicKey, pub)).toBe(true);
  });

  it('successive rotations produce different keys', () => {
    const id = Identity.generate();
    const pub1 = id.rotateRatchet();
    const pub2 = id.rotateRatchet();
    expect(equal(pub1, pub2)).toBe(false);
  });

  it('throws on public-only identity', () => {
    const full = Identity.generate();
    const pubOnly = Identity.fromPublicKey(full.publicKey);
    expect(() => pubOnly.rotateRatchet()).toThrow();
  });

  it('setRemoteRatchet stores a ratchet for a remote identity', () => {
    const id = Identity.generate();
    const remote = Identity.fromPublicKey(id.publicKey);
    const ratchetPub = id.rotateRatchet();

    remote.setRemoteRatchet(ratchetPub);
    expect(equal(remote.ratchetPublicKey, ratchetPub)).toBe(true);
  });
});

describe('Ratcheted encryption', () => {
  it('encrypts with ratchet and decrypts with ratchet private key', async () => {
    const recipient = Identity.generate();
    const ratchetPub = recipient.rotateRatchet();

    // Sender encrypts using recipient's ratchet
    const sender = Identity.fromPublicKey(recipient.publicKey);
    const plaintext = fromUtf8('ratcheted message');
    const ciphertext = await sender.encrypt(plaintext, ratchetPub);

    // Recipient decrypts — ratchet key is tried first
    const decrypted = await recipient.decrypt(ciphertext);
    expect(equal(decrypted, plaintext)).toBe(true);
  });

  it('falls back to base key when ratchet does not match', async () => {
    const recipient = Identity.generate();
    recipient.rotateRatchet(); // set a ratchet

    // Encrypt without ratchet (using base key)
    const sender = Identity.fromPublicKey(recipient.publicKey);
    const plaintext = fromUtf8('base key message');
    const ciphertext = await sender.encrypt(plaintext); // no ratchet arg

    // Recipient should decrypt successfully via fallback to base key
    const decrypted = await recipient.decrypt(ciphertext);
    expect(equal(decrypted, plaintext)).toBe(true);
  });

  it('old ratchet key cannot decrypt after rotation', async () => {
    const recipient = Identity.generate();
    const oldRatchet = recipient.rotateRatchet();

    // Encrypt with old ratchet
    const sender = Identity.fromPublicKey(recipient.publicKey);
    const ciphertext = await sender.encrypt(fromUtf8('old'), oldRatchet);

    // Rotate — old ratchet private key is gone
    recipient.rotateRatchet();

    // Should still decrypt via base key fallback
    // (Python behavior: tries ratchets list, then base key)
    // Our impl: tries current ratchet (won't match), then base key (won't match either
    // because it was encrypted with a ratchet, not the base key)
    await expect(recipient.decrypt(ciphertext)).rejects.toThrow(/HMAC/);
  });
});

describe('Ratcheted announces', () => {
  it('creates announce with ratchet (context_flag=1)', () => {
    const id = Identity.generate();
    const ratchetPub = id.rotateRatchet();
    const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'test', 'ratchet');

    const pkt = createAnnounce(dest, null, { ratchet: ratchetPub });

    expect(pkt.contextFlag).toBe(FLAG_SET);
    // Data should be 180 bytes minimum (64+10+10+32+64)
    expect(pkt.data.length).toBeGreaterThanOrEqual(180);
  });

  it('creates announce without ratchet (context_flag=0)', () => {
    const id = Identity.generate();
    const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'test');

    const pkt = createAnnounce(dest);

    expect(pkt.contextFlag).toBe(FLAG_UNSET);
    expect(pkt.data.length).toBeGreaterThanOrEqual(148);
  });

  it('validates a ratcheted announce', () => {
    const id = Identity.generate();
    const ratchetPub = id.rotateRatchet();
    const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'test', 'ratchet');

    const pkt = createAnnounce(dest, fromUtf8('with ratchet'), { ratchet: ratchetPub });
    const raw = pkt.pack();
    const parsed = Packet.parse(raw);

    expect(parsed.contextFlag).toBe(FLAG_SET);

    const result = validateAnnounce(parsed);
    expect(result).not.toBeNull();
    expect(result.ratchet).not.toBeNull();
    expect(result.ratchet).toHaveLength(32);
    expect(equal(result.ratchet, ratchetPub)).toBe(true);
    expect(equal(result.appData, fromUtf8('with ratchet'))).toBe(true);
  });

  it('validates ratcheted announce with no app data', () => {
    const id = Identity.generate();
    const ratchetPub = id.rotateRatchet();
    const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'test');

    const pkt = createAnnounce(dest, null, { ratchet: ratchetPub });
    const parsed = Packet.parse(pkt.pack());
    const result = validateAnnounce(parsed);

    expect(result).not.toBeNull();
    expect(result.ratchet).not.toBeNull();
    expect(result.appData).toBeNull();
  });

  it('round-trips through pack/parse/validate', () => {
    const id = Identity.generate();
    const ratchetPub = id.rotateRatchet();
    const dest = new Destination(id, DEST_IN, DEST_SINGLE, 'lxmf', 'delivery');
    const appData = fromUtf8('ratcheted node');

    const pkt = createAnnounce(dest, appData, { ratchet: ratchetPub });
    const parsed = Packet.parse(pkt.pack());
    const result = validateAnnounce(parsed);

    expect(result).not.toBeNull();
    expect(equal(result.identity.hash, id.hash)).toBe(true);
    expect(equal(result.ratchet, ratchetPub)).toBe(true);
    expect(equal(result.appData, appData)).toBe(true);
    expect(equal(result.destinationHash, dest.hash)).toBe(true);
  });
});
