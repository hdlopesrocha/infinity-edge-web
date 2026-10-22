// The player's Lightning wallet (NIP-47), keyed to their Nostr account.
//
// There is no in-game currency any more: the balance shown is what the wallet
// linked to the player's npub actually holds. The connection URI persists in
// localStorage, so the link survives reloads.

import { NwcClient, parseNwcUri } from './ln/nwc';

const URI_KEY = 'ie.nwc.uri';

function loadUri(): string {
  try { return localStorage.getItem(URI_KEY) ?? ''; } catch { return ''; }
}
function saveUri(uri: string): void {
  try {
    if (uri) localStorage.setItem(URI_KEY, uri);
    else localStorage.removeItem(URI_KEY);
  } catch { /* private mode */ }
}

/** Lightning glyph shown next to satoshi amounts. */
export const SATS_SYMBOL = '⚡';

/** "⚡ 1,234" (or "⚡ —" when no balance is known). */
export function satsLabel(sats: number | null): string {
  if (sats === null || !Number.isFinite(sats)) return SATS_SYMBOL + ' —';
  return SATS_SYMBOL + ' ' + Math.max(0, Math.round(sats)).toLocaleString('en-US');
}

export class Wallet {
  private conn = null as ReturnType<typeof parseNwcUri>;
  private client: NwcClient | null = null;
  private sats: number | null = null;
  private status = '';
  /** Called whenever the balance or connection state changes. */
  onChange: (() => void) | null = null;

  constructor() {
    const uri = loadUri();
    if (uri) this.connect(uri, false);
  }

  get connected(): boolean {
    return !!this.client;
  }

  get balanceSats(): number | null {
    return this.sats;
  }

  get statusText(): string {
    return this.status;
  }

  get lud16(): string {
    return this.conn?.lud16 ?? '';
  }

  /** Link a NL wallet from its `nostr+walletconnect://` URI. */
  connect(uri: string, persist = true): boolean {
    const conn = parseNwcUri(uri);
    if (!conn) {
      this.status = 'that does not look like a nostr+walletconnect:// URI';
      this.onChange?.();
      return false;
    }
    this.disconnect(false);
    this.conn = conn;
    this.client = new NwcClient(conn);
    this.status = '';
    if (persist) saveUri(uri);
    void this.refresh();
    this.onChange?.();
    return true;
  }

  disconnect(clearStored = true): void {
    this.client?.close();
    this.client = null;
    this.conn = null;
    this.sats = null;
    this.status = '';
    if (clearStored) saveUri('');
    this.onChange?.();
  }

  /** Re-read the wallet balance (sats). */
  async refresh(): Promise<number | null> {
    if (!this.client) {
      this.sats = null;
      this.onChange?.();
      return null;
    }
    const sats = await this.client.getBalanceSats();
    this.sats = sats;
    if (sats === null) this.status = 'wallet did not answer';
    this.onChange?.();
    return sats;
  }

  /** Pay a BOLT-11 invoice, then refresh the balance. */
  async pay(invoice: string): Promise<boolean> {
    if (!this.client) throw new Error('no wallet connected');
    try {
      await this.client.payInvoice(invoice);
      this.status = '';
    } catch (e) {
      this.status = (e as Error).message;
      this.onChange?.();
      throw e;
    }
    await this.refresh();
    return true;
  }

  /** Ask the wallet to create an invoice (for receiving a payment). */
  async makeInvoice(amountSats: number, description: string): Promise<string | null> {
    return this.client ? this.client.makeInvoice(amountSats, description) : null;
  }
}

let wallet: Wallet | null = null;

export function getWallet(): Wallet | null {
  return wallet;
}

/** Create (or return) the app's single wallet, wiring `onChange`. */
export function attachWallet(onChange?: () => void): Wallet {
  if (!wallet) wallet = new Wallet();
  if (onChange) wallet.onChange = onChange;
  return wallet;
}
