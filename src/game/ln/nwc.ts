// NIP-47 Nostr Wallet Connect.
//
// Reads the satoshi balance of the Lightning wallet linked to a Nostr key and
// pays invoices, over NIP-04 encrypted Nostr events:
//
//   kind 23194  request   (client -> wallet, `p` tag = wallet pubkey)
//   kind 23195  response  (wallet -> client, `e` tag = request id, `p` = ours)
//
// The wallet is configured by a `nostr+walletconnect://<walletPubkey>?relay=…&
// secret=…` URI (Alby, Zeus, Phoenix, …). The `secret` is a throwaway key used
// only for the encrypted channel with the wallet service.

import { RelayPool } from '../nostr/relay';
import { finalizeEvent, verifyEvent } from '../nostr/event';
import type { NostrEvent } from '../nostr/event';
import { nip04Decrypt, nip04Encrypt } from '../nostr/nip04';
import { bytesToHex, hexToBytes, schnorrPubkey, validSecretKey } from '../nostr/crypto';

export const NWC_REQUEST_KIND = 23194;
export const NWC_RESPONSE_KIND = 23195;
const REQUEST_TIMEOUT_MS = 20000;
const CONNECT_TIMEOUT_MS = 8000;

export interface NwcConnection {
  /** Wallet service x-only public key (hex). */
  walletPubkey: string;
  /** Relay the wallet listens on. */
  relay: string;
  /** Secret key shared with the wallet (from the URI). */
  secret: Uint8Array;
  /** Optional lightning address carried by the URI. */
  lud16: string;
}

/** Parse a `nostr+walletconnect://…` URI; null when malformed. */
export function parseNwcUri(uri: string): NwcConnection | null {
  const m = /^nostr\+walletconnect:\/\/([0-9a-f]{64})\?(.+)$/i.exec(String(uri ?? '').trim());
  if (!m) return null;
  const params = new URLSearchParams(m[2]);
  const relay = params.get('relay') ?? '';
  const secretHex = params.get('secret') ?? '';
  if (!relay || !/^[0-9a-f]{64}$/i.test(secretHex)) return null;
  const secret = hexToBytes(secretHex);
  if (!validSecretKey(secret)) return null;
  return {
    walletPubkey: m[1].toLowerCase(),
    relay,
    secret,
    lud16: params.get('lud16') ?? params.get('lightning') ?? '',
  };
}

/** One wallet connection over one relay. */
export class NwcClient {
  private pool: RelayPool | null = null;
  private sub: (() => void) | null = null;
  private pending = new Map<string, {
    resolve: (r: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly pubkeyHex: string;

  constructor(private conn: NwcConnection) {
    this.pubkeyHex = bytesToHex(schnorrPubkey(conn.secret));
  }

  /** Open the relay and subscribe to wallet responses (idempotent). */
  async connect(timeoutMs = CONNECT_TIMEOUT_MS): Promise<boolean> {
    if (this.pool) return true;
    const pool = new RelayPool([this.conn.relay]);
    this.pool = pool;
    pool.connect();
    const ok = await pool.waitOpen(timeoutMs);
    if (!ok) {
      this.close();
      return false;
    }
    this.sub = pool.subscribe(
      'nwc',
      [{ kinds: [NWC_RESPONSE_KIND], '#p': [this.pubkeyHex] }],
      (evt) => void this.onResponse(evt),
    );
    return true;
  }

  close(): void {
    this.sub?.();
    this.sub = null;
    this.pool?.close();
    this.pool = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('wallet disconnected'));
    }
    this.pending.clear();
  }

  private async onResponse(evt: NostrEvent): Promise<void> {
    if (!verifyEvent(evt) || evt.pubkey !== this.conn.walletPubkey) return;
    let reqId = '';
    for (const tag of evt.tags) if (tag[0] === 'e' && tag[1]) reqId = tag[1];
    const entry = this.pending.get(reqId);
    if (!entry) return;
    this.pending.delete(reqId);
    clearTimeout(entry.timer);
    const plain = await nip04Decrypt(this.conn.secret, this.conn.walletPubkey, evt.content);
    if (!plain) {
      entry.reject(new Error('wallet response could not be decrypted'));
      return;
    }
    let body: { result_type?: string; error?: { code?: string; message?: string } | null; result?: unknown };
    try {
      body = JSON.parse(plain) as typeof body;
    } catch {
      entry.reject(new Error('malformed wallet response'));
      return;
    }
    if (body.error) {
      entry.reject(new Error(body.error.message ?? body.error.code ?? 'wallet error'));
      return;
    }
    entry.resolve(body.result);
  }

  private async request<T>(method: string, params: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (!(await this.connect())) throw new Error('wallet relay unreachable');
    const content = await nip04Encrypt(
      this.conn.secret, this.conn.walletPubkey, JSON.stringify({ method, params }),
    );
    const evt = finalizeEvent({
      kind: NWC_REQUEST_KIND,
      tags: [['p', this.conn.walletPubkey]],
      content,
    }, this.conn.secret);
    const reply = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(evt.id);
        reject(new Error('wallet did not answer'));
      }, timeoutMs);
      this.pending.set(evt.id, { resolve: resolve as (r: unknown) => void, reject, timer });
    });
    await this.pool!.publish(evt);
    return reply;
  }

  /** Balance in satoshis (null when unavailable). */
  async getBalanceSats(): Promise<number | null> {
    try {
      const res = await this.request<{ balance?: number }>('get_balance', {});
      return typeof res?.balance === 'number' ? Math.floor(res.balance / 1000) : null;
    } catch {
      return null;
    }
  }

  /** Pay a BOLT-11 invoice. Throws with the wallet's message on failure. */
  async payInvoice(invoice: string): Promise<string> {
    const res = await this.request<{ preimage?: string }>('pay_invoice', { invoice });
    return res?.preimage ?? '';
  }

  /** Ask the wallet to create an invoice. Null when unsupported. */
  async makeInvoice(amountSats: number, description: string): Promise<string | null> {
    try {
      const res = await this.request<{ invoice?: string }>('make_invoice', {
        amount: Math.round(amountSats * 1000),
        description,
      });
      return res?.invoice ?? null;
    } catch {
      return null;
    }
  }
}
