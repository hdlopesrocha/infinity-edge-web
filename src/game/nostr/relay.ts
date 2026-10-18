// Minimal multi-relay Nostr client (NIP-01 over WebSocket JSON).
//
// One socket per relay, automatic reconnect with backoff, subscriptions are
// re-sent on every (re)connect, events are deduplicated by id across relays,
// and publishes resolve on the first OK (or fail after a timeout). No
// dependencies: the platform WebSocket is enough (browser + Node 20+).

import type { NostrEvent } from './event';

export type RelayState = 'connecting' | 'open' | 'closed';

export interface RelayStatus {
  url: string;
  state: RelayState;
  /** Last NOTICE/CLOSED message, for the UI's status line. */
  message: string;
}

interface Subscription {
  id: string;
  filters: unknown[];
  onEvent: (evt: NostrEvent, relay: string) => void;
  onEose?: (relay: string) => void;
  seen: Set<string>;
}

const RECONNECT_MIN = 2000;
const RECONNECT_MAX = 30000;
const PUBLISH_TIMEOUT = 6000;

export class RelayPool {
  private subs = new Map<string, Subscription>();
  private urls: string[];
  private sockets = new Map<string, WebSocket>();
  private states = new Map<string, RelayStatus>();
  private retries = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingPublishes = new Map<string, { resolve: (r: { ok: boolean; relay: string; message: string }) => void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  /** Called whenever a relay state changes (UI dots, status lines). */
  onStatus: (() => void) | null = null;

  constructor(urls: string[]) {
    this.urls = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
    for (const url of this.urls) this.states.set(url, { url, state: 'connecting', message: '' });
  }

  get relayUrls(): string[] {
    return this.urls;
  }

  status(): RelayStatus[] {
    return this.urls.map((u) => this.states.get(u)!);
  }

  get openCount(): number {
    let n = 0;
    for (const s of this.states.values()) if (s.state === 'open') n++;
    return n;
  }

  /** Open every relay (idempotent). */
  connect(): void {
    this.closed = false;
    for (const url of this.urls) this.openSocket(url);
  }

  /** Wait until at least one relay is open (or the timeout elapses). */
  waitOpen(timeoutMs = 8000): Promise<boolean> {
    if (this.openCount > 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = (): void => {
        if (this.closed || this.openCount > 0) {
          resolve(this.openCount > 0);
          return;
        }
        if (Date.now() - t0 > timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const ws of this.sockets.values()) {
      try { ws.close(); } catch { /* already closed */ }
    }
    this.sockets.clear();
    for (const [url, st] of this.states) this.setState(url, 'closed', st.message);
    for (const p of this.pendingPublishes.values()) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, relay: '', message: 'pool closed' });
    }
    this.pendingPublishes.clear();
  }

  /**
   * Subscribe with one or more filters. Returns an unsubscribe function. The
   * subscription id is reused across relays and reconnects.
   */
  subscribe(
    id: string,
    filters: unknown[],
    onEvent: (evt: NostrEvent, relay: string) => void,
    onEose?: (relay: string) => void,
  ): () => void {
    const sub: Subscription = { id, filters, onEvent, onEose, seen: new Set() };
    this.subs.set(id, sub);
    for (const ws of this.sockets.values()) {
      if (ws.readyState === 1) this.send(ws, ['REQ', id, ...filters]);
    }
    return () => {
      if (this.subs.get(id) !== sub) return;
      this.subs.delete(id);
      for (const ws of this.sockets.values()) {
        if (ws.readyState === 1) this.send(ws, ['CLOSE', id]);
      }
    };
  }

  /** Publish to every open relay; resolves on the first OK for the event id. */
  publish(evt: NostrEvent): Promise<{ ok: boolean; relay: string; message: string }> {
    const payload = JSON.stringify(['EVENT', evt]);
    let sent = 0;
    for (const ws of this.sockets.values()) {
      if (ws.readyState === 1) {
        this.send(ws, JSON.parse(payload) as unknown[]);
        sent++;
      }
    }
    if (sent === 0) return Promise.resolve({ ok: false, relay: '', message: 'no relay connected' });
    if (this.pendingPublishes.has(evt.id)) {
      return Promise.resolve({ ok: false, relay: '', message: 'already publishing' });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPublishes.delete(evt.id);
        // Optimistic: the relays did receive it, only the OK was slow.
        resolve({ ok: true, relay: '', message: 'no OK received' });
      }, PUBLISH_TIMEOUT);
      this.pendingPublishes.set(evt.id, { resolve, timer });
    });
  }

  // ------------------------------------------------------------- internals
  private setState(url: string, state: RelayState, message: string): void {
    const st = this.states.get(url);
    if (!st) return;
    const changed = st.state !== state || st.message !== message;
    st.state = state;
    st.message = message;
    if (changed) this.onStatus?.();
  }

  private send(ws: WebSocket, msg: unknown[]): void {
    try { ws.send(JSON.stringify(msg)); } catch { /* racing a close */ }
  }

  private openSocket(url: string): void {
    if (this.closed) return;
    const existing = this.sockets.get(url);
    if (existing && (existing.readyState === 0 || existing.readyState === 1)) return;
    this.setState(url, 'connecting', '');
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.scheduleReconnect(url, (e as Error).message || 'bad url');
      return;
    }
    this.sockets.set(url, ws);
    ws.onopen = () => {
      this.retries.set(url, 0);
      this.setState(url, 'open', '');
      // Every active subscription must be re-sent on this relay.
      for (const sub of this.subs.values()) this.send(ws, ['REQ', sub.id, ...sub.filters]);
    };
    ws.onmessage = (ev) => {
      let msg: unknown;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
      if (!Array.isArray(msg) || typeof msg[0] !== 'string') return;
      if (msg[0] === 'EVENT') {
        const subId = String(msg[1]);
        const sub = this.subs.get(subId);
        if (!sub) return;
        const evt = msg[2] as NostrEvent | undefined;
        if (!evt || typeof evt.id !== 'string' || sub.seen.has(evt.id)) return;
        sub.seen.add(evt.id);
        // Keep the per-subscription id set from growing without bound.
        if (sub.seen.size > 2000) {
          const first = sub.seen.values().next();
          if (!first.done) sub.seen.delete(first.value);
        }
        try { sub.onEvent(evt, url); } catch { /* handler errors never kill the socket */ }
        return;
      }
      if (msg[0] === 'EOSE') {
        this.subs.get(String(msg[1]))?.onEose?.(url);
        return;
      }
      if (msg[0] === 'OK') {
        const id = String(msg[1]);
        const pending = this.pendingPublishes.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingPublishes.delete(id);
          pending.resolve({ ok: msg[2] === true, relay: url, message: String(msg[3] ?? '') });
        }
        return;
      }
      if (msg[0] === 'NOTICE' || msg[0] === 'CLOSED') {
        this.setState(url, this.states.get(url)?.state ?? 'connecting', String(msg[1] ?? '').slice(0, 120));
      }
    };
    ws.onclose = () => {
      this.sockets.delete(url);
      this.setState(url, 'closed', this.states.get(url)?.message ?? '');
      this.scheduleReconnect(url, 'closed');
    };
    ws.onerror = () => {
      // onclose follows; only a note for the status line.
      const st = this.states.get(url);
      if (st) this.setState(url, st.state, 'connection error');
    };
  }

  private scheduleReconnect(url: string, reason: string): void {
    if (this.closed) return;
    const n = (this.retries.get(url) ?? 0) + 1;
    this.retries.set(url, n);
    const delay = Math.min(RECONNECT_MAX, RECONNECT_MIN * 2 ** Math.min(4, n - 1));
    this.setState(url, 'closed', reason);
    if (this.timers.has(url)) return;
    const t = setTimeout(() => {
      this.timers.delete(url);
      this.openSocket(url);
    }, delay);
    this.timers.set(url, t);
  }
}
