// Symmetric signalling crypto for password-protected multiplayer rooms.
//
// A protected room never publishes its password. The Nostr room event carries
// only a *flag* (`pw`) and a random `salt`; both ends derive the same AES-GCM
// key from the password + salt with PBKDF2-SHA256 (WebCrypto, no dependencies)
// and use it to seal the sensitive part of every signalling message: the SDP
// (the DTLS fingerprint), the ICE candidates and the host certificate
// signature. Unprotected rooms keep plaintext signalling.
//
// The wire shape of a sealed message is unchanged: `SignalMessage.enc` holds a
// base64 `iv || ciphertext` blob and the sensitive fields (`sdp`,
// `candidates`, `name`, `sig`) are dropped from the clear. `kind`, `room`,
// `to`, `offerId` and `sid` stay readable so the relay and the receiver can
// route the message without the key.

import { bytesToHex, concatBytes, hexToBytes, randomBytes } from '../nostr/crypto';
import type { SignalMessage } from '../nostr/event';

/** PBKDF2 rounds: a password is low entropy, so make guessing cost something. */
export const PBKDF2_ITERATIONS = 150_000;
/** Salt size (bytes) carried in the room event. */
export const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BITS = 256;
/** `iv || tag` is at least this many bytes, so anything shorter is bogus. */
const MIN_SEALED_BYTES = IV_BYTES + 16;

/** The signalling fields that travel encrypted (the rest stays in the clear). */
export interface SignalSecret {
  sdp?: string;
  candidates?: SignalMessage['candidates'];
  name?: string;
  sig?: string;
}

/** WebCrypto BufferSource (the DOM typing rejects ArrayBufferLike views). */
function source(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Fresh random salt (hex) for a new protected room. */
export function newSalt(): string {
  return bytesToHex(randomBytes(SALT_BYTES));
}

/** Derives the room's signalling key from its password and published salt. */
export async function deriveKey(password: string, saltHex: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    'raw', source(new TextEncoder().encode(password)), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: source(hexToBytes(saltHex)), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: KEY_BITS }, false, ['encrypt', 'decrypt'],
  );
}

/** Encrypts any JSON value into a base64 `iv || ciphertext` blob. */
export async function encryptJson(key: CryptoKey, obj: unknown): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const plaintext = new TextEncoder().encode(JSON.stringify(obj));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: source(iv) }, key, source(plaintext)),
  );
  return toBase64(concatBytes(iv, cipher));
}

/** Decrypts a blob produced by {@link encryptJson}; null on any failure. */
export async function decryptJson<T>(key: CryptoKey, b64: string): Promise<T | null> {
  try {
    const raw = fromBase64(b64);
    if (raw.length < MIN_SEALED_BYTES) return null;
    const iv = raw.subarray(0, IV_BYTES);
    const cipher = raw.subarray(IV_BYTES);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: source(iv) }, key, source(cipher));
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    return null;
  }
}

/**
 * Seals the sensitive fields of a signalling message. Without a key (an
 * unprotected room) the message is returned unchanged, so the plaintext flow
 * is byte-for-byte what it was before password support.
 */
export async function sealSignal(
  key: CryptoKey | null,
  msg: Omit<SignalMessage, 'v' | 'room' | 'to'>,
): Promise<Omit<SignalMessage, 'v' | 'room' | 'to'>> {
  if (!key) return msg;
  const { sdp, candidates, name, sig, ...rest } = msg;
  const enc = await encryptJson(key, { sdp, candidates, name, sig } satisfies SignalSecret);
  return { ...rest, enc };
}

/**
 * Opens a received signalling message. Returns the message unchanged for an
 * unprotected room, the decrypted message for a protected one, and null when a
 * protected payload cannot be decrypted (wrong password / tampered ciphertext).
 */
export async function openSignal(key: CryptoKey | null, msg: SignalMessage): Promise<SignalMessage | null> {
  if (!msg.enc) return key ? null : msg;
  if (!key) return null;
  const secret = await decryptJson<SignalSecret>(key, msg.enc);
  if (!secret) return null;
  return { ...msg, ...secret };
}
