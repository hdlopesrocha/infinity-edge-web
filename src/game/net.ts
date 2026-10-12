// WebSocket binary protocol with application-level gzip framing.
//
// NOTE on fidelity: the original XNA game has NO network/multiplayer code
// (verified: zero Socket/WebSocket/Network hits; the multiplayer button is
// commented out in MainMenu.cs). This module therefore preserves that
// behavior — the game runs fully offline — while providing the documented
// binary+gzip transport the web build uses for optional scene/asset data
// transfer (e.g. fetching converted level blobs from a companion server).
//
// Wire format (all integers little-endian):
//   byte 0:     version (currently 1)
//   byte 1:     flags bit0 = 1 means payload is gzip-compressed
//   bytes 2-3:  message type (uint16)
//   bytes 4-7:  payload length in bytes (uint32, length of the FRAMED payload,
//               i.e. after compression when the gzip flag is set)
//   bytes 8..:  payload (raw or gzip bytes)
//
// Tiny payloads (< GZIP_THRESHOLD) are never compressed: the gzip header
// overhead would exceed the benefit. Decompression uses pako (portable) with
// a DecompressionStream('gzip') fast path where available.

import { ungzip, gzip } from 'pako';

export const PROTOCOL_VERSION = 1;
export const FLAG_GZIP = 0x01;
export const GZIP_THRESHOLD = 256;
export const HEADER_SIZE = 8;

/** Message types. Plain (non-const) enum so it exists at runtime under
 * isolatedModules/esbuild single-file transpilation. */
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
  payload: Uint8Array; // always decompressed
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
    } catch {
      /* fall through to pako */
    }
  }
  return ungzip(data) as Uint8Array<ArrayBuffer>;
}

/** Encode a message; compresses with gzip when beneficial and allowed. */
export function encodeMessage(
  type: number,
  payload: Uint8Array,
  opts: { compress?: boolean } = {},
): Uint8Array {
  let body = payload;
  let compressed = false;
  if (opts.compress !== false && payload.length >= GZIP_THRESHOLD) {
    try {
      const gz = gzip(payload);
      // Only keep compression when it actually shrinks the payload.
      if (gz.length + HEADER_SIZE < payload.length + HEADER_SIZE) {
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

/** Decode one framed message; throws on malformed input. */
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

export function encodeJson(type: number, value: unknown, compress = true): Uint8Array {
  return encodeMessage(type, textEncoder.encode(JSON.stringify(value)), { compress });
}

export async function decodeJson<T>(msg: DecodedMessage): Promise<T> {
  return JSON.parse(textDecoder.decode(msg.payload)) as T;
}

// ---------------------------------------------------------------------------
// Connection wrapper: async, non-blocking, auto-reconnect with backoff.
// Not required for gameplay (offline-first); used opportunistically.
// ---------------------------------------------------------------------------

export type MsgHandler = (msg: DecodedMessage) => void;

export class GameSocket {
  private ws: WebSocket | null = null;
  private url: string;
  private handler: MsgHandler;
  private retries = 0;
  private closed = false;
  private maxRetries: number;

  constructor(url: string, handler: MsgHandler, maxRetries = 3) {
    this.url = url;
    this.handler = handler;
    this.maxRetries = maxRetries;
  }

  connect(): void {
    if (this.closed || typeof WebSocket === 'undefined') return;
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      return;
    }
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      this.retries = 0;
      this.send(MsgType.Hello, textEncoder.encode('infinity-edge-web/1'));
    };
    this.ws.onmessage = (ev) => {
      const data = ev.data as ArrayBuffer;
      decodeMessage(data).then(this.handler).catch(() => {
        /* malformed message: ignore, keep rendering */
      });
    };
    this.ws.onclose = () => {
      this.ws = null;
      if (!this.closed && this.retries < this.maxRetries) {
        this.retries++;
        const backoff = Math.min(5000, 500 * 2 ** this.retries);
        window.setTimeout(() => this.connect(), backoff);
      }
    };
    this.ws.onerror = () => {
      try {
        this.ws?.close();
      } catch {
        /* ignore */
      }
    };
  }

  send(type: number, payload: Uint8Array, compress = true): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(encodeMessage(type, payload, { compress }));
    } catch {
      /* ignore send errors */
    }
  }

  close(): void {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  get connected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}
