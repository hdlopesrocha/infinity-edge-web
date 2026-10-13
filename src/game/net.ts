// Binary protocol + gzip framing (versioned, explicit compression flag).

import { gzip, ungzip } from 'pako';

export const PROTOCOL_VERSION = 1;
export const FLAG_GZIP = 0x01;
export const GZIP_THRESHOLD = 256;
export const HEADER_SIZE = 8;

export enum MsgType {
  Hello = 1,
  LevelRequest = 2,
  LevelData = 3,
  ModelRequest = 4,
  ModelData = 5,
  ScoresSync = 6,
  Ping = 7,
  Pong = 8,
  GhostData = 9,
  Error = 0xffff,
}

export interface DecodedMessage {
  version: number;
  type: number;
  compressed: boolean;
  payload: Uint8Array;
}

function hasDecompressionStream(): boolean {
  return typeof DecompressionStream !== 'undefined';
}

async function gunzip(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (hasDecompressionStream()) {
    try {
      const ds = new DecompressionStream('gzip');
      const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    } catch { /* fall through */ }
  }
  return ungzip(data) as Uint8Array<ArrayBuffer>;
}

export function encodeMessage(type: number, payload: Uint8Array, opts: { compress?: boolean } = {}): Uint8Array {
  let body = payload;
  let compressed = false;
  if (opts.compress !== false && payload.length >= GZIP_THRESHOLD) {
    try {
      const gz = gzip(payload);
      if (gz.length < payload.length) {
        body = gz;
        compressed = true;
      }
    } catch {
      body = payload;
    }
  }
  const out = new Uint8Array(HEADER_SIZE + body.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, compressed ? FLAG_GZIP : 0);
  view.setUint16(2, type, true);
  view.setUint32(4, body.length, true);
  out.set(body, HEADER_SIZE);
  return out;
}

export async function decodeMessage(data: ArrayBuffer | Uint8Array): Promise<DecodedMessage> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < HEADER_SIZE) throw new Error('net: truncated header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  if (version !== PROTOCOL_VERSION) throw new Error('net: bad version ' + version);
  const flags = view.getUint8(1);
  const type = view.getUint16(2, true);
  const len = view.getUint32(4, true);
  if (bytes.length < HEADER_SIZE + len) throw new Error('net: truncated payload');
  const framed = bytes.slice(HEADER_SIZE, HEADER_SIZE + len);
  const compressed = (flags & FLAG_GZIP) !== 0;
  let payload = framed;
  if (compressed) {
    try {
      payload = await gunzip(framed);
    } catch (e) {
      throw new Error('net: gzip decompress failed: ' + (e as Error).message);
    }
  }
  return { version, type, compressed, payload };
}

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();
