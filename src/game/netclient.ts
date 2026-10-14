// WebSocket asset/scene channel (client).
//
// The original game is offline and loads its content from the local store, so
// this channel is an *opt-in transport* for exactly the same converted assets:
// it is enabled only when a URL is configured (`?ws=` query parameter,
// `VITE_IE_WS` at build time, or `window.__IE_WS_URL` for embedding). With no
// URL configured every asset request is a plain HTTP fetch and behaviour is
// identical to the original.
//
// Protocol: docs/protocol.md — 8-byte binary header (version, flags, type,
// payload length, little-endian), payloads gzip-compressed above 256 bytes
// with the compression flag set explicitly, request/response correlated by an
// `id` echoed in the JSON payload.
//
// Everything here is asynchronous and never blocks the render loop; a failed
// or slow channel degrades to HTTP instead of stalling scene loading.

import { decodeMessage, decodeJson, encodeJson, MsgType } from './net';

export type ChannelState = 'disabled' | 'connecting' | 'open' | 'closed';

export interface ChannelStatus {
  state: ChannelState;
  url: string;
  attempts: number;
  sent: number;
  received: number;
  errors: number;
}

/** Resolve the channel URL from the environment (empty string = disabled). */
export function configuredUrl(): string {
  try {
    const q = new URLSearchParams(window.location.search).get('ws');
    if (q) return q;
    const env = (import.meta.env.VITE_IE_WS as string | undefined) ?? '';
    if (env) return env;
    const injected = (window as unknown as { __IE_WS_URL?: string }).__IE_WS_URL;
    if (injected) return injected;
  } catch { /* no window (tests) */ }
  return '';
}

interface Pending {
  resolve: (bytes: Uint8Array) => void;
  reject: (e: Error) => void;
  timer: number;
}

/** Read the request id from a BinaryData payload header. */
export function binaryPayloadId(payload: Uint8Array): number | undefined {
  if (payload.byteLength < 4) return undefined;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const metaLength = view.getUint32(0, true);
  if (payload.byteLength < 4 + metaLength) return undefined;
  try {
    const meta = JSON.parse(
      new TextDecoder().decode(payload.subarray(4, 4 + metaLength)),
    ) as { id?: unknown };
    return typeof meta.id === 'number' ? meta.id : undefined;
  } catch {
    return undefined;
  }
}

const REQUEST_TIMEOUT = 8000;
const MAX_MALFORMED = 3;

export class AssetChannel {
  readonly url: string;
  state: ChannelState = 'disabled';
  attempts = 0;
  sent = 0;
  received = 0;
  errors = 0;
  /** Called whenever the state changes (used by the dev overlay). */
  onStatus: ((s: ChannelStatus) => void) | null = null;

  private ws: WebSocket | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private malformed = 0;
  private retryTimer = 0;
  private retryDelay = 1000;
  private closedByUs = false;

  constructor(url: string) {
    this.url = url;
    this.state = url ? 'closed' : 'disabled';
  }

  get enabled(): boolean {
    return this.state !== 'disabled';
  }

  get connected(): boolean {
    return this.state === 'open' && !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  status(): ChannelStatus {
    return {
      state: this.state, url: this.url, attempts: this.attempts,
      sent: this.sent, received: this.received, errors: this.errors,
    };
  }

  /** Idempotent: opens the socket (or schedules a retry). */
  connect(): void {
    if (!this.enabled || this.connected || this.state === 'connecting') return;
    this.closedByUs = false;
    this.state = 'connecting';
    this.notify();
    try {
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => {
        this.attempts++;
        this.retryDelay = 1000;
        this.state = 'open';
        this.notify();
        void this.hello();
      };
      ws.onmessage = (ev) => void this.onMessage(ev.data);
      ws.onerror = () => {
        this.errors++;
        this.notify();
      };
      ws.onclose = () => {
        this.failAll(new Error('net: channel closed'));
        this.ws = null;
        if (this.closedByUs) {
          this.state = 'closed';
          this.notify();
          return;
        }
        this.state = 'closed';
        this.notify();
        this.scheduleRetry();
      };
    } catch (e) {
      this.errors++;
      this.state = 'closed';
      this.notify();
      this.scheduleRetry();
    }
  }

  close(): void {
    this.closedByUs = true;
    window.clearTimeout(this.retryTimer);
    this.failAll(new Error('net: channel closed'));
    this.ws?.close();
    this.ws = null;
    this.state = this.enabled ? 'closed' : 'disabled';
    this.notify();
  }

  private scheduleRetry(): void {
    if (this.closedByUs || !this.enabled) return;
    window.clearTimeout(this.retryTimer);
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, 15000);
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  private notify(): void {
    this.onStatus?.(this.status());
  }

  private async hello(): Promise<void> {
    try {
      const bytes = encodeJson(MsgType.Hello, {
        client: 'infinity-edge-web', version: 1, capabilities: ['gzip', 'binary'],
      });
      await this.raw(bytes);
    } catch { /* non fatal */ }
  }

  /** Send pre-encoded bytes (low level; used by tests and Hello). */
  raw(bytes: Uint8Array): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('net: not connected'));
    }
    ws.send(bytes);
    this.sent++;
    return Promise.resolve();
  }

  /** Request/response with correlation id and timeout. */
  request(type: number, payload: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT): Promise<Uint8Array> {
    if (!this.connected) return Promise.reject(new Error('net: not connected'));
    const id = this.nextId++;
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('net: request timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.raw(encodeJson(type, { ...payload, id })).catch((e: Error) => {
        window.clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  private async onMessage(data: ArrayBuffer | Uint8Array | string): Promise<void> {
    if (typeof data === 'string') {
      this.malformed++;
      this.errors++;
      this.notify();
      this.checkMalformed();
      return;
    }
    let msg;
    try {
      msg = await decodeMessage(data);
    } catch (e) {
      // Malformed / undecodable frame: count it, never throw into the caller.
      this.malformed++;
      this.errors++;
      this.notify();
      console.warn('[net]', (e as Error).message);
      this.checkMalformed();
      return;
    }
    this.received++;
    if (msg.type === MsgType.Ping) {
      void this.raw(encodeJson(MsgType.Pong, { t: Date.now() })).catch(() => undefined);
      return;
    }
    // Correlation ids live in the JSON envelope, except for BinaryData whose
    // payload is [u32 metaLength][json meta][bytes] (docs/protocol.md).
    let id: number | undefined;
    let serverMessage: string | undefined;
    if (msg.type === MsgType.BinaryData) {
      id = binaryPayloadId(msg.payload);
      if (id === undefined) {
        this.malformed++;
        this.errors++;
        this.notify();
        console.warn('[net] malformed binary frame (bad meta header)');
        this.checkMalformed();
        return;
      }
    } else if (msg.type !== MsgType.Pong) {
      try {
        const body = decodeJson<{ id?: number; message?: string }>(msg);
        id = typeof body.id === 'number' ? body.id : undefined;
        serverMessage = body.message;
      } catch (e) {
        this.errors++;
        this.notify();
        console.warn('[net]', (e as Error).message);
        return;
      }
    }
    if (id === undefined) {
      this.notify();
      return;
    }
    const slot = this.pending.get(id);
    if (!slot) {
      this.notify();
      return;
    }
    this.pending.delete(id);
    window.clearTimeout(slot.timer);
    if (msg.type === MsgType.Error) {
      this.errors++;
      this.notify();
      slot.reject(new Error('net: server error: ' + (serverMessage ?? 'unknown')));
      return;
    }
    this.notify();
    slot.resolve(msg.payload);
  }

  private checkMalformed(): void {
    if (this.malformed < MAX_MALFORMED) return;
    console.warn('[net] too many malformed messages, reconnecting');
    this.malformed = 0;
    this.ws?.close();
  }

  private failAll(e: Error): void {
    for (const slot of this.pending.values()) {
      window.clearTimeout(slot.timer);
      slot.reject(e);
    }
    this.pending.clear();
  }
}

let channel: AssetChannel | null = null;

/** The process-wide channel (disabled unless a URL is configured). */
export function assetChannel(): AssetChannel {
  if (!channel) channel = new AssetChannel(configuredUrl());
  return channel;
}

/** Open the channel if configured; safe to call repeatedly. */
export function initChannel(): AssetChannel {
  const c = assetChannel();
  if (c.enabled) c.connect();
  return c;
}
