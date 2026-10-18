// Minimal, dependency-free crypto for Nostr (NIP-01 events, NIP-19 keys).
//
// - SHA-256 (synchronous: signing a run of events should not need awaits)
// - secp256k1 over BigInt (Jacobian point math, double-and-add)
// - BIP-340 Schnorr signatures: sign/verify, exactly what relays validate
//
// Tested against the official BIP-340 vectors (tests/nostr.test.ts) and
// cross-checked against nostr-tools fixtures.

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(out);
  else for (let i = 0; i < n; i++) out[i] = (Math.random() * 256) | 0;
  return out;
}

// ------------------------------------------------------------------- bytes
const HEX = '0123456789abcdef';

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  const s = hex.length % 2 ? '0' + hex : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

export function bigIntToBytes(v: bigint, len = 32): Uint8Array {
  const out = new Uint8Array(len);
  let x = v;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let ofs = 0;
  for (const p of parts) {
    out.set(p, ofs);
    ofs += p.length;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ------------------------------------------------------------------ sha256
const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(v: number, n: number): number {
  return ((v >>> n) | (v << (32 - n))) >>> 0;
}

/** SHA-256 of the given bytes (big-endian digest, 32 bytes). */
export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const len = data.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  const bits = len * 8;
  dv.setUint32(padded.length - 8, Math.floor(bits / 0x100000000), false);
  dv.setUint32(padded.length - 4, bits >>> 0, false);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) >>> 0;
      const s1 = (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (hh + S1 + ch + SHA_K[i] + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) new DataView(out.buffer).setUint32(i * 4, h[i], false);
  return out;
}

// ----------------------------------------------------------------- secp256k1
export const FIELD_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
export const CURVE_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

/** Jacobian point; z = 0 marks the point at infinity. */
interface JPoint {
  x: bigint;
  y: bigint;
  z: bigint;
}

const INFINITY: JPoint = { x: 0n, y: 1n, z: 0n };
const GENERATOR: JPoint = { x: GX, y: GY, z: 1n };

function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

function modInv(a: bigint, m: bigint): bigint {
  // Extended Euclid; a and m must be coprime (m prime here).
  let [old_r, r] = [mod(a, m), m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return mod(old_s, m);
}

function jDouble(p: JPoint): JPoint {
  if (p.z === 0n || p.y === 0n) return INFINITY;
  const a = mod(p.x * p.x, FIELD_P);
  const b = mod(p.y * p.y, FIELD_P);
  const c = mod(b * b, FIELD_P);
  let d = mod((p.x + b) * (p.x + b) - a - c, FIELD_P);
  d = mod(2n * d, FIELD_P);
  const e = mod(3n * a, FIELD_P);
  const f = mod(e * e, FIELD_P);
  const x3 = mod(f - 2n * d, FIELD_P);
  const y3 = mod(e * (d - x3) - 8n * c, FIELD_P);
  const z3 = mod(2n * p.y * p.z, FIELD_P);
  return { x: x3, y: y3, z: z3 };
}

function jAdd(p: JPoint, q: JPoint): JPoint {
  if (p.z === 0n) return q;
  if (q.z === 0n) return p;
  const z1z1 = mod(p.z * p.z, FIELD_P);
  const z2z2 = mod(q.z * q.z, FIELD_P);
  const u1 = mod(p.x * z2z2, FIELD_P);
  const u2 = mod(q.x * z1z1, FIELD_P);
  const s1 = mod(p.y * q.z * z2z2, FIELD_P);
  const s2 = mod(q.y * p.z * z1z1, FIELD_P);
  if (u1 === u2) {
    if (s1 !== s2) return INFINITY;
    return jDouble(p);
  }
  const h = mod(u2 - u1, FIELD_P);
  const i = mod((2n * h) * (2n * h), FIELD_P);
  const j = mod(h * i, FIELD_P);
  const r = mod(2n * (s2 - s1), FIELD_P);
  const v = mod(u1 * i, FIELD_P);
  const x3 = mod(r * r - j - 2n * v, FIELD_P);
  const y3 = mod(r * (v - x3) - 2n * s1 * j, FIELD_P);
  const z3 = mod(((p.z + q.z) * (p.z + q.z) - z1z1 - z2z2) * h, FIELD_P);
  return { x: x3, y: y3, z: z3 };
}

function jMul(p: JPoint, k: bigint): JPoint {
  let result = INFINITY;
  let addend = p;
  let n = mod(k, CURVE_N);
  while (n > 0n) {
    if (n & 1n) result = jAdd(result, addend);
    addend = jDouble(addend);
    n >>= 1n;
  }
  return result;
}

function toAffine(p: JPoint): { x: bigint; y: bigint } | null {
  if (p.z === 0n) return null;
  const zi = modInv(p.z, FIELD_P);
  const zi2 = mod(zi * zi, FIELD_P);
  return { x: mod(p.x * zi2, FIELD_P), y: mod(p.y * zi2 * zi, FIELD_P) };
}

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b, m);
    b = mod(b * b, m);
    e >>= 1n;
  }
  return result;
}

/** Lift an x coordinate to the even-y point with that x, or null. */
function liftX(x: bigint): JPoint | null {
  if (x < 0n || x >= FIELD_P) return null;
  const c = mod(x * x * x + 7n, FIELD_P);
  // p % 4 == 3, so the square root is c^((p+1)/4).
  const y = modPow(c, (FIELD_P + 1n) / 4n, FIELD_P);
  if (mod(y * y, FIELD_P) !== c) return null;
  return { x, y: y % 2n === 0n ? y : FIELD_P - y, z: 1n };
}

/** x-only public key (32 bytes) for a secret key. */
export function schnorrPubkey(seckey: Uint8Array): Uint8Array {
  const d = bytesToBigInt(seckey);
  const p = jMul(GENERATOR, d);
  const aff = toAffine(p);
  if (!aff) throw new Error('invalid secret key');
  return bigIntToBytes(aff.x, 32);
}

export function validSecretKey(seckey: Uint8Array): boolean {
  if (seckey.length !== 32) return false;
  const d = bytesToBigInt(seckey);
  return d > 0n && d < CURVE_N;
}

// ------------------------------------------------------------------ BIP-340
function taggedHash(tag: string, ...msgs: Uint8Array[]): Uint8Array {
  const tagHash = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(tagHash, tagHash, ...msgs));
}

/** BIP-340 Schnorr signature (64 bytes) over a message of any size (2023-04). */
export function schnorrSign(msg: Uint8Array, seckey: Uint8Array, aux?: Uint8Array): Uint8Array {
  if (!validSecretKey(seckey)) throw new Error('schnorr: invalid secret key');
  const d0 = bytesToBigInt(seckey);
  const P = toAffine(jMul(GENERATOR, d0))!;
  const d = P.y % 2n === 0n ? d0 : CURVE_N - d0;
  const auxRand = aux && aux.length === 32 ? aux : randomBytes(32);
  const t = (() => {
    const dh = bigIntToBytes(d, 32);
    const auxHash = taggedHash('BIP0340/aux', auxRand);
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = dh[i] ^ auxHash[i];
    return out;
  })();
  const px = bigIntToBytes(P.x, 32);
  const k0 = mod(bytesToBigInt(taggedHash('BIP0340/nonce', t, px, msg)), CURVE_N);
  if (k0 === 0n) throw new Error('schnorr: nonce is zero');
  const R = toAffine(jMul(GENERATOR, k0))!;
  const k = R.y % 2n === 0n ? k0 : CURVE_N - k0;
  const rx = bigIntToBytes(R.x, 32);
  const e = mod(bytesToBigInt(taggedHash('BIP0340/challenge', rx, px, msg)), CURVE_N);
  const s = mod(k + e * d, CURVE_N);
  return concatBytes(rx, bigIntToBytes(s, 32));
}

/** BIP-340 verification (x-only public key, 64-byte signature). */
export function schnorrVerify(msg: Uint8Array, pubkey: Uint8Array, sig: Uint8Array): boolean {
  if (pubkey.length !== 32 || sig.length !== 64) return false;
  const P = liftX(bytesToBigInt(pubkey));
  if (!P) return false;
  const r = bytesToBigInt(sig.subarray(0, 32));
  const s = bytesToBigInt(sig.subarray(32, 64));
  if (r >= FIELD_P || s >= CURVE_N) return false;
  const e = mod(bytesToBigInt(taggedHash('BIP0340/challenge', sig.subarray(0, 32), pubkey, msg)), CURVE_N);
  // R = s*G - e*P
  const sG = jMul(GENERATOR, s);
  const eP = jMul(P, e);
  const negEP: JPoint = { x: eP.x, y: mod(-eP.y, FIELD_P), z: eP.z };
  const R = jAdd(sG, negEP);
  const aff = toAffine(R);
  if (!aff) return false;
  if (aff.y % 2n !== 0n) return false;
  return aff.x === r;
}
