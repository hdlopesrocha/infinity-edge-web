// bech32 (BIP-173) + NIP-19 entities: npub / nsec encoding of Nostr keys.
// Only what the multiplayer UI needs: display an npub, accept an nsec.

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const CHARSET_MAP = new Map<string, number>([...CHARSET].map((c, i) => [c, i]));

function polymod(values: number[]): number {
  let chk = 1;
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    return null;
  }
  return out;
}

export function bech32Encode(hrp: string, data: number[]): string {
  const values = [...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod([...hrpExpand(hrp), ...values]) ^ 1;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >> (5 * (5 - i))) & 31);
  return hrp + '1' + [...data, ...checksum].map((v) => CHARSET[v]).join('');
}

export function bech32Decode(str: string): { hrp: string; data: number[] } | null {
  const s = str.toLowerCase();
  if (s.length < 8 || s.length > 90) return null;
  const sep = s.lastIndexOf('1');
  if (sep < 1 || sep + 7 > s.length) return null;
  const hrp = s.slice(0, sep);
  const data: number[] = [];
  for (const c of s.slice(sep + 1)) {
    const v = CHARSET_MAP.get(c);
    if (v === undefined) return null;
    data.push(v);
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) return null;
  return { hrp, data: data.slice(0, -6) };
}

function encodeEntity(hrp: string, bytes: Uint8Array): string {
  const bits = convertBits([...bytes], 8, 5, true);
  if (!bits) throw new Error('bech32: encode failed');
  return bech32Encode(hrp, bits);
}

function decodeEntity(str: string, hrp: string): Uint8Array | null {
  try {
    const dec = bech32Decode(str);
    if (!dec || dec.hrp !== hrp) return null;
    const bytes = convertBits(dec.data, 5, 8, false);
    if (!bytes) return null;
    return new Uint8Array(bytes);
  } catch {
    return null;
  }
}

/** 32-byte x-only public key -> npub1... */
export function npubEncode(pubkey: Uint8Array): string {
  return encodeEntity('npub', pubkey);
}

/** 32-byte secret key -> nsec1... */
export function nsecEncode(seckey: Uint8Array): string {
  return encodeEntity('nsec', seckey);
}

/** Decoded NIP-19 entity: the raw 32 bytes behind npub/nsec. */
export function decodeKeyEntity(str: string): { type: 'npub' | 'nsec'; bytes: Uint8Array } | null {
  const s = str.trim();
  const npub = decodeEntity(s, 'npub');
  if (npub && npub.length === 32) return { type: 'npub', bytes: npub };
  const nsec = decodeEntity(s, 'nsec');
  if (nsec && nsec.length === 32) return { type: 'nsec', bytes: nsec };
  return null;
}

/** Short display form ("npub1abcd...wxyz"). */
export function shortNpub(pubkey: Uint8Array): string {
  const npub = npubEncode(pubkey);
  return npub.slice(0, 10) + '…' + npub.slice(-4);
}
