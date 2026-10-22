// NIP-04 encrypted direct messages.
//
// The shared secret is the secp256k1 ECDH x coordinate between the sender's
// secret key and the recipient's x-only public key (see crypto.ts). The AES
// key is `sha256(sharedX)` and the payload is AES-256-CBC, exactly the wire
// shape NIP-04 specifies:
//
//   content = base64(ciphertext) + '?iv=' + base64(iv)
//
// The IV is 16 random bytes. Decryption is fail-closed: any malformed or
// tampered payload, or a wrong key, yields null and never throws.

import { bytesToHex, ecdhSharedX, hexToBytes, randomBytes, sha256 } from './crypto';

const IV_BYTES = 16;

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

/** `sha256(ECDH shared X)`, imported as the AES-CBC key for one peer. */
async function sharedKey(secretKey: Uint8Array, theirPubkey: string): Promise<CryptoKey> {
  const shared = ecdhSharedX(secretKey, hexToBytes(theirPubkey));
  return crypto.subtle.importKey('raw', source(sha256(shared)), { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
}

/** Encrypts `plaintext` for `theirPubkey` (x-only hex) as a NIP-04 payload. */
export async function nip04Encrypt(
  secretKey: Uint8Array, theirPubkey: string, plaintext: string,
): Promise<string> {
  const key = await sharedKey(secretKey, theirPubkey);
  const iv = randomBytes(IV_BYTES);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-CBC', iv: source(iv) }, key, source(new TextEncoder().encode(plaintext))),
  );
  return `${toBase64(cipher)}?iv=${toBase64(iv)}`;
}

/** Decrypts a NIP-04 payload from `theirPubkey`; null on any failure. */
export async function nip04Decrypt(
  secretKey: Uint8Array, theirPubkey: string, payload: string,
): Promise<string | null> {
  try {
    if (typeof payload !== 'string') return null;
    const sep = payload.indexOf('?iv=');
    if (sep <= 0) return null;
    const cipherText = payload.slice(0, sep);
    const ivText = payload.slice(sep + '?iv='.length);
    if (!cipherText || !ivText) return null;
    const iv = fromBase64(ivText);
    if (iv.length !== IV_BYTES) return null;
    const cipher = fromBase64(cipherText);
    if (cipher.length === 0 || cipher.length % IV_BYTES !== 0) return null;
    const key = await sharedKey(secretKey, theirPubkey);
    const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: source(iv) }, key, source(cipher));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/** True when `hex` is a 32-byte x-only public key (used for DM addressing). */
export function isPubkeyHex(hex: string): boolean {
  return /^[0-9a-f]{64}$/.test(hex);
}

/** The raw 32-byte shared X, exposed for tests/diagnostics. */
export function sharedXHex(secretKey: Uint8Array, theirPubkey: string): string {
  return bytesToHex(ecdhSharedX(secretKey, hexToBytes(theirPubkey)));
}
