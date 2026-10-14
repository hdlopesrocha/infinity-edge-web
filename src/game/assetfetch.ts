// Asset fetch front-end: WebSocket channel when available, HTTP otherwise.
//
// Both paths deliver the same bytes, so the loader does not care which one is
// used. Requests are keyed by the asset path relative to the site base
// (`assets/models/Fighter3.json`), which is what the dev asset server exposes.

import { assetChannel } from './netclient';
import { MsgType } from './net';
import { textDecoder } from './net';

function siteBase(): string {
  return (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');
}

/** `.../assets/levels/x.json` -> `assets/levels/x.json` (or null if outside). */
export function assetPath(url: string): string | null {
  const abs = new URL(url, window.location.href);
  const base = siteBase();
  let path = abs.pathname;
  if (base && path.startsWith(base + '/')) path = path.slice(base.length + 1);
  else if (base && path === base) path = '';
  else path = path.replace(/^\/+/, '');
  return path.startsWith('assets/') ? path : null;
}

async function overChannel(path: string, kind: 'json' | 'bytes'): Promise<Uint8Array | null> {
  const ch = assetChannel();
  if (!ch.connected) return null;
  const type = kind === 'bytes' ? MsgType.BinaryRequest
    : path.startsWith('assets/levels/') ? MsgType.LevelRequest
      : MsgType.ModelRequest;
  try {
    return await ch.request(type, { file: path });
  } catch (e) {
    // Timeout, server error, malformed response: degrade to HTTP. Missing
    // assets are normal (model0/color0 variants are optional), so they are
    // reported at debug level rather than as warnings.
    const msg = (e as Error).message;
    if (msg.includes('not found')) console.debug('[net] not on channel, using HTTP:', path);
    else console.warn('[net] channel request failed, using HTTP:', path, msg);
    return null;
  }
}

/**
 * JSON responses arrive as `{id, file, data:<asset>}` (docs/protocol.md); this
 * validates the envelope and returns the asset, or null when it does not look
 * like a channel response (caller then falls back to HTTP).
 */
function unwrapJson(payload: Uint8Array): unknown | null {
  let env: { file?: string; data?: unknown };
  try {
    env = JSON.parse(textDecoder.decode(payload)) as { file?: string; data?: unknown };
  } catch {
    return null;
  }
  return env && typeof env === 'object' && 'data' in env ? env.data : null;
}

/** Binary payload: [u32 metaLength][json {id,file,byteLength}][bytes]. */
function unwrapBinary(payload: Uint8Array): Uint8Array | null {
  if (payload.byteLength < 4) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const metaLength = view.getUint32(0, true);
  const start = 4 + metaLength;
  if (payload.byteLength < start) return null;
  try {
    const meta = JSON.parse(textDecoder.decode(payload.subarray(4, start))) as { byteLength?: number };
    const bytes = payload.subarray(start);
    if (typeof meta.byteLength === 'number' && meta.byteLength !== bytes.byteLength) return null;
    return bytes;
  } catch {
    return null;
  }
}

export async function fetchAssetBytes(url: string): Promise<ArrayBuffer> {
  const path = assetPath(url);
  if (path) {
    const viaWs = await overChannel(path, 'bytes');
    if (viaWs) {
      const bytes = unwrapBinary(viaWs);
      if (bytes && bytes.byteLength) {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      }
      console.warn('[net] malformed binary from channel, using HTTP:', path);
    }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error('asset not found: ' + (path ?? url));
  return res.arrayBuffer();
}

export async function fetchAssetJson<T>(url: string): Promise<T> {
  const path = assetPath(url);
  if (path) {
    const viaWs = await overChannel(path, 'json');
    const data = viaWs ? unwrapJson(viaWs) : null;
    if (data != null) return data as T;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error('asset not found: ' + (path ?? url));
  return (await res.json()) as T;
}
