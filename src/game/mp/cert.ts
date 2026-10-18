// Host certificates for multiplayer rooms.
//
// A room is signed by its creator's Nostr key. That alone lets a *relay* not
// forge rooms, but clients also need to be sure the WebRTC peer they reach is
// the room's host. Two bindings close that gap:
//
// 1. Certificate (this file): the host generates an ephemeral P-256 key pair
//    and publishes a certificate - the SPKI public key plus a BIP-340
//    signature by the room's Nostr key over `ie3d-mp-cert-v1|room|host|...`.
//    Every answer SDP (which carries the DTLS fingerprint) is signed with the
//    certificate key, so the guest knows the negotiated WebRTC endpoint was
//    produced by the host's key for this room. Guest code refuses answers
//    whose certificate signature does not verify.
//
// 2. Channel authentication (authPayload below): immediately after the data
//    channel opens the guest sends a random nonce; the host answers with a
//    BIP-340 signature by the room's Nostr key over
//    `ie3d-mp-auth-v1|room|hostPubkey|guestPubkey|nonce`. Only the holder of
//    the room key can produce it, so another client (or a relay) cannot
//    impersonate the host even if it can publish signalling events.

import { bytesToHex, hexToBytes, randomBytes, schnorrSign, schnorrVerify, sha256 } from '../nostr/crypto';
import type { HostCert } from '../nostr/event';

const encoder = new TextEncoder();

function base64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** WebCrypto BufferSource (the DOM typing rejects ArrayBufferLike views). */
function source(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

function fromBase64(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export interface HostCertBundle {
  cert: HostCert;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

/** The exact string the room key signs (and guests verify). */
export function certPayload(
  roomId: string, hostPubkey: string, cert: { key: string; created: number; expires: number },
): Uint8Array {
  return encoder.encode(
    `ie3d-mp-cert-v1|${roomId}|${hostPubkey}|${cert.created}|${cert.expires}|${cert.key}`);
}

/** Creates a room certificate signed by the host's Nostr secret key. */
export async function createHostCert(
  roomId: string, hostPubkey: string, secretKey: Uint8Array, ttlSeconds = 24 * 3600,
): Promise<HostCertBundle> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
  const now = Math.floor(Date.now() / 1000);
  const cert = { key: base64(spki), created: now, expires: now + ttlSeconds, sig: '' };
  cert.sig = bytesToHex(schnorrSign(certPayload(roomId, hostPubkey, cert), secretKey));
  return { cert, privateKey: pair.privateKey, publicKey: pair.publicKey };
}

/** Verifies a room certificate against the room author's Nostr key. */
export async function verifyHostCert(
  roomId: string, hostPubkey: string, cert: HostCert,
): Promise<boolean> {
  if (!cert.key || !cert.sig) return false;
  if (cert.expires > 0 && cert.expires * 1000 < Date.now()) return false;
  try {
    return schnorrVerify(
      certPayload(roomId, hostPubkey, cert), hexToBytes(hostPubkey), hexToBytes(cert.sig),
    );
  } catch {
    return false;
  }
}

/** Imports the certificate's P-256 key (for verifying the host's answers). */
export async function importCertKey(cert: HostCert): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki', source(fromBase64(cert.key)), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'],
  );
}

/** The exact string a host signs for an answer SDP (fingerprint included). */
export function answerPayload(
  roomId: string, from: string, to: string, sdp: string,
): Uint8Array {
  return encoder.encode(
    `ie3d-mp-answer-v1|${roomId}|${from}|${to}|${bytesToHex(sha256(encoder.encode(sdp)))}`);
}

export async function signAnswer(
  privateKey: CryptoKey, roomId: string, from: string, to: string, sdp: string,
): Promise<string> {
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, privateKey, source(answerPayload(roomId, from, to, sdp)));
  return base64(sig);
}

export async function verifyAnswer(
  publicKey: CryptoKey, roomId: string, from: string, to: string, sdp: string, sig: string,
): Promise<boolean> {
  if (!sig) return false;
  try {
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, publicKey, source(fromBase64(sig)),
      source(answerPayload(roomId, from, to, sdp)));
  } catch {
    return false;
  }
}

/** Random 16-byte hex nonce for the channel challenge. */
export function newNonce(): string {
  return bytesToHex(randomBytes(16));
}

/** The exact string the host signs over a guest's nonce. */
export function authPayload(
  roomId: string, hostPubkey: string, guestPubkey: string, nonce: string,
): Uint8Array {
  return encoder.encode(`ie3d-mp-auth-v1|${roomId}|${hostPubkey}|${guestPubkey}|${nonce}`);
}

/** Host side: BIP-340 signature over the guest's channel challenge. */
export function signAuth(
  secretKey: Uint8Array, roomId: string, hostPubkey: string, guestPubkey: string, nonce: string,
): string {
  return bytesToHex(
    schnorrSign(authPayload(roomId, hostPubkey, guestPubkey, nonce), secretKey));
}

/** Guest side: verifies the host proved possession of the room key. */
export function verifyAuth(
  hostPubkey: string, roomId: string, guestPubkey: string, nonce: string, sig: string,
): boolean {
  try {
    return schnorrVerify(
      authPayload(roomId, hostPubkey, guestPubkey, nonce),
      hexToBytes(hostPubkey), hexToBytes(sig));
  } catch {
    return false;
  }
}
