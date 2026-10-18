// Host certificates + channel authentication: the bindings that stop a client
// (or a relay) from impersonating the room's host.
import { describe, expect, it } from 'vitest';
import {
  answerPayload, authPayload, createHostCert, importCertKey, newNonce, signAnswer, signAuth,
  verifyAnswer, verifyAuth, verifyHostCert,
} from '../src/game/mp/cert';
import { bytesToHex, hexToBytes, randomBytes, schnorrPubkey } from '../src/game/nostr/crypto';
import { finalizeEvent, roomFromEvent, roomTemplate, tagValue } from '../src/game/nostr/event';

const ROOM = '0123456789abcdef01234567';

function keypair(): { sk: Uint8Array; pub: string } {
  const sk = randomBytes(32);
  return { sk, pub: bytesToHex(schnorrPubkey(sk)) };
}

describe('host certificates', () => {
  it('binds the WebRTC key to the room author and expires', async () => {
    const host = keypair();
    const bundle = await createHostCert(ROOM, host.pub, host.sk, 3600);
    expect(bundle.cert.key.length).toBeGreaterThan(100);
    expect(bundle.cert.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(await verifyHostCert(ROOM, host.pub, bundle.cert)).toBe(true);

    // Another room, another host or a tampered certificate must not verify.
    expect(await verifyHostCert('ffffffffffffffffffffffff', host.pub, bundle.cert)).toBe(false);
    const other = keypair();
    expect(await verifyHostCert(ROOM, other.pub, bundle.cert)).toBe(false);
    expect(await verifyHostCert(ROOM, host.pub, { ...bundle.cert, expires: bundle.cert.expires + 1 })).toBe(false);
    const expired = await createHostCert(ROOM, host.pub, host.sk, -10);
    expect(await verifyHostCert(ROOM, host.pub, expired.cert)).toBe(false);
  });

  it('publishes the certificate with the room event', async () => {
    const host = keypair();
    const bundle = await createHostCert(ROOM, host.pub, host.sk, 3600);
    const now = Math.floor(Date.now() / 1000);
    const evt = finalizeEvent(roomTemplate({
      id: ROOM,
      content: {
        v: 1, game: 'ctf-easy', type: 'CTF', title: 'CTF', host: 'Pilot',
        players: 1, max: 8, ice: [], created: now, cert: bundle.cert,
      },
      ttlSec: 1800,
      created_at: now,
    }), host.sk);
    expect(tagValue(evt, 'expiration')).toBe(String(now + 1800));
    const room = roomFromEvent(evt)!;
    expect(room.cert).not.toBeNull();
    expect(room.cert!.key).toBe(bundle.cert.key);
    expect(await verifyHostCert(room.id, room.hostPubkey, room.cert!)).toBe(true);
  });

  it('signs answer SDPs so a rogue endpoint cannot complete the call', async () => {
    const host = keypair();
    const bundle = await createHostCert(ROOM, host.pub, host.sk, 3600);
    const publicKey = await importCertKey(bundle.cert);
    const guest = keypair();
    const sdp = 'v=0\r\na=fingerprint:sha-256 AA:BB\r\n';
    const sig = await signAnswer(bundle.privateKey, ROOM, host.pub, guest.pub, sdp);
    expect(await verifyAnswer(publicKey, ROOM, host.pub, guest.pub, sdp, sig)).toBe(true);
    // Tampered SDP (a swapped DTLS fingerprint), wrong recipient, wrong room.
    expect(await verifyAnswer(publicKey, ROOM, host.pub, guest.pub, sdp.replace('AA', 'CC'), sig)).toBe(false);
    expect(await verifyAnswer(publicKey, ROOM, host.pub, host.pub, sdp, sig)).toBe(false);
    expect(await verifyAnswer(publicKey, 'ffffffffffffffffffffffff', host.pub, guest.pub, sdp, sig)).toBe(false);
    // A rogue "host" signing its own answer with its own certificate fails.
    const rogue = await createHostCert(ROOM, host.pub, keypair().sk, 3600); // not the author's sig
    expect(await verifyHostCert(ROOM, host.pub, rogue.cert)).toBe(false);
    const rogueSig = await signAnswer(rogue.privateKey, ROOM, host.pub, guest.pub, sdp);
    expect(await verifyAnswer(publicKey, ROOM, host.pub, guest.pub, sdp, rogueSig)).toBe(false);
    expect(await verifyAnswer(publicKey, ROOM, host.pub, guest.pub, sdp, '')).toBe(false);
  });

  it('authenticates the channel with the room key (challenge-response)', () => {
    const host = keypair();
    const guest = keypair();
    const nonce = newNonce();
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    const sig = signAuth(host.sk, ROOM, host.pub, guest.pub, nonce);
    expect(verifyAuth(host.pub, ROOM, guest.pub, nonce, sig)).toBe(true);
    // A guest with its own key cannot answer the host's challenge.
    const impersonator = keypair();
    const forged = signAuth(impersonator.sk, ROOM, impersonator.pub, guest.pub, nonce);
    expect(verifyAuth(host.pub, ROOM, guest.pub, nonce, forged)).toBe(false);
    // Replays/other rooms/guests fail too.
    expect(verifyAuth(host.pub, ROOM, guest.pub, newNonce(), sig)).toBe(false);
    expect(verifyAuth(host.pub, 'ffffffffffffffffffffffff', guest.pub, nonce, sig)).toBe(false);
    expect(verifyAuth(host.pub, ROOM, host.pub, nonce, sig)).toBe(false);
    // The payloads are stable strings shared with the C++ server.
    expect(Buffer.from(authPayload(ROOM, host.pub, guest.pub, nonce)).toString())
      .toBe(`ie3d-mp-auth-v1|${ROOM}|${host.pub}|${guest.pub}|${nonce}`);
    expect(Buffer.from(answerPayload(ROOM, host.pub, guest.pub, 'v=0')).toString())
      .toMatch(new RegExp(`^ie3d-mp-answer-v1\\|${ROOM}\\|${host.pub}\\|${guest.pub}\\|[0-9a-f]{64}$`));
    // And a signature over the auth payload verifies with the raw BIP-340 path.
    expect(schnorrPubkey(host.sk)).toEqual(hexToBytes(host.pub));
  });
});
