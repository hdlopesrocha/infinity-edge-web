// NIP-04: secp256k1 ECDH + AES-256-CBC over the WebCrypto API, and the
// `ciphertext?iv=...` wire shape the DM transport publishes.
import { describe, expect, it } from 'vitest';
import { nip04Decrypt, nip04Encrypt } from '../src/game/nostr/nip04';
import { bytesToHex, randomBytes, schnorrPubkey } from '../src/game/nostr/crypto';

function keypair(): { sk: Uint8Array; pub: string } {
  const sk = randomBytes(32);
  return { sk, pub: bytesToHex(schnorrPubkey(sk)) };
}

describe('nip04 encrypted DMs', () => {
  it('round-trips in both directions', async () => {
    const alice = keypair();
    const bob = keypair();
    const body = 'hello 🚀\nmulti-line secret';
    const fromAlice = await nip04Encrypt(alice.sk, bob.pub, body);
    expect(fromAlice).toMatch(/\?iv=/);
    expect(await nip04Decrypt(bob.sk, alice.pub, fromAlice)).toBe(body);

    const fromBob = await nip04Encrypt(bob.sk, alice.pub, body);
    expect(await nip04Decrypt(alice.sk, bob.pub, fromBob)).toBe(body);
  });

  it('produces a different ciphertext for the same plaintext (fresh IV)', async () => {
    const alice = keypair();
    const bob = keypair();
    const a = await nip04Encrypt(alice.sk, bob.pub, 'same');
    const b = await nip04Encrypt(alice.sk, bob.pub, 'same');
    expect(a).not.toBe(b);
  });

  it('fails with the wrong key', async () => {
    const alice = keypair();
    const bob = keypair();
    const eve = keypair();
    const payload = await nip04Encrypt(alice.sk, bob.pub, 'for bob only');
    // A third party cannot decrypt, and neither can bob pretending it came
    // from eve (the ECDH secret does not match).
    expect(await nip04Decrypt(eve.sk, alice.pub, payload)).toBeNull();
    expect(await nip04Decrypt(bob.sk, eve.pub, payload)).toBeNull();
  });

  it('returns null on malformed payloads', async () => {
    const alice = keypair();
    const bob = keypair();
    expect(await nip04Decrypt(alice.sk, bob.pub, '')).toBeNull();
    expect(await nip04Decrypt(alice.sk, bob.pub, 'no-iv-here')).toBeNull();
    expect(await nip04Decrypt(alice.sk, bob.pub, 'AAAA?iv=AAAA')).toBeNull();       // bad base64 / short iv
    expect(await nip04Decrypt(alice.sk, bob.pub, '!!!!?iv=!!!!')).toBeNull();       // invalid base64
    const good = await nip04Encrypt(alice.sk, bob.pub, 'ok');
    expect(await nip04Decrypt(alice.sk, bob.pub, good)).toBe('ok');
    // A tampered ciphertext no longer authenticates.
    expect(await nip04Decrypt(alice.sk, bob.pub, 'ZZ' + good)).toBeNull();
  });
});
