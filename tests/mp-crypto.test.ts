// Password-protected room signalling: the PBKDF2-SHA256 + AES-GCM round trip
// and the seal/open wrapper the manager uses. Everything runs on WebCrypto,
// which Node exposes as `globalThis.crypto` (no DOM needed).

import { describe, expect, it } from 'vitest';
import {
  PBKDF2_ITERATIONS,
  SALT_BYTES,
  decryptJson,
  deriveKey,
  encryptJson,
  newSalt,
  openSignal,
  sealSignal,
} from '../src/game/mp/crypto';
import type { SignalMessage } from '../src/game/nostr/event';

describe('mp signalling crypto', () => {
  it('derives a key from password + salt and round-trips a JSON payload', async () => {
    const salt = newSalt();
    expect(salt).toMatch(new RegExp(`^[0-9a-f]{${SALT_BYTES * 2}}$`));
    const key = await deriveKey('hunter2', salt);
    const payload = {
      sdp: 'v=0\r\na=fingerprint:sha-256 AA:BB\r\n',
      name: 'Pilot',
      candidates: [{ candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 }],
    };
    const sealed = await encryptJson(key, payload);
    expect(typeof sealed).toBe('string');
    // The plaintext never appears in the ciphertext blob.
    expect(sealed).not.toContain('v=0');
    expect(sealed).not.toContain('Pilot');
    expect(await decryptJson(key, sealed)).toEqual(payload);
  });

  it('is deterministic across two derivations of the same password + salt', async () => {
    // Both ends derive independently; they must agree byte for byte.
    const salt = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const hostKey = await deriveKey('shared secret', salt);
    const guestKey = await deriveKey('shared secret', salt);
    const sealed = await encryptJson(hostKey, { hello: 'world' });
    expect(await decryptJson(guestKey, sealed)).toEqual({ hello: 'world' });
  });

  it('uses a fresh IV so equal payloads encrypt differently', async () => {
    const key = await deriveKey('pw', newSalt());
    const a = await encryptJson(key, { x: 1 });
    const b = await encryptJson(key, { x: 1 });
    expect(a).not.toBe(b);
    expect(await decryptJson(key, a)).toEqual({ x: 1 });
    expect(await decryptJson(key, b)).toEqual({ x: 1 });
  });

  it('rejects the wrong password, a tampered ciphertext and junk', async () => {
    const salt = newSalt();
    const key = await deriveKey('right', salt);
    const wrong = await deriveKey('wrong', salt);
    const sealed = await encryptJson(key, { secret: true });
    expect(await decryptJson(wrong, sealed)).toBeNull();

    const bytes = Buffer.from(sealed, 'base64');
    bytes[bytes.length - 1] ^= 0x01; // flip one ciphertext bit (GCM auth fails)
    expect(await decryptJson(key, bytes.toString('base64'))).toBeNull();
    expect(await decryptJson(key, '')).toBeNull();
    expect(await decryptJson(key, 'not base64 !!')).toBeNull();
  });

  it('seals only the sensitive signalling fields and opens them back', async () => {
    const key = await deriveKey('pw', newSalt());
    const sealed = await sealSignal(key, {
      kind: 'offer', offerId: 'abc123', sdp: 'v=0 SECRET', name: 'Host', sig: 'deadbeef',
    });
    // Routing metadata stays readable for the relay and the receiver.
    expect(sealed.kind).toBe('offer');
    expect(sealed.offerId).toBe('abc123');
    expect(sealed.enc).toBeTruthy();
    expect(sealed.sdp).toBeUndefined();
    expect(sealed.name).toBeUndefined();
    expect(JSON.stringify(sealed)).not.toContain('SECRET');

    const opened = await openSignal(key, { v: 1, room: 'r', to: '', ...sealed } as SignalMessage);
    expect(opened?.sdp).toBe('v=0 SECRET');
    expect(opened?.name).toBe('Host');
    expect(opened?.sig).toBe('deadbeef');
    expect(opened?.offerId).toBe('abc123');
  });

  it('keeps unprotected signalling as plaintext and refuses key mismatches', async () => {
    // No key: seal/open are pass-throughs.
    const plain = await sealSignal(null, { kind: 'offer', sdp: 'v=0' });
    expect(plain.sdp).toBe('v=0');
    expect(plain.enc).toBeUndefined();
    const opened = await openSignal(null, { v: 1, room: 'r', to: '', kind: 'offer', sdp: 'v=0' });
    expect(opened?.sdp).toBe('v=0');

    // A sealed payload cannot be opened without the key...
    expect(await openSignal(null, { v: 1, room: 'r', to: '', kind: 'offer', enc: 'x' })).toBeNull();
    // ...and a plaintext payload is refused when a key is expected.
    const key = await deriveKey('pw', newSalt());
    expect(await openSignal(key, { v: 1, room: 'r', to: '', kind: 'offer', sdp: 'v=0' })).toBeNull();
  });

  it('pins the KDF cost so the wire format stays hard to brute force', () => {
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(100_000);
    expect(SALT_BYTES).toBe(16);
  });
});
