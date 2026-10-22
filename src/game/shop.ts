// SHOP: buy stronger aimbot presets with satoshis over Lightning.
//
// There is no in-game currency any more. A purchase:
//
//   1. asks the seller's lightning address (LNURL-pay) for a BOLT-11 invoice
//      covering the item's price in sats;
//   2. pays that invoice with the player's linked wallet (NIP-47, game/wallet);
//   3. unlocks the preset locally (persisted in the store) once the payment
//      succeeds.
//
// The seller is configured with `VITE_IE_SHOP_LUD16`; with no seller address
// the shop is read-only (items show their price but cannot be bought).

import { AIMBOT_PRESETS, SHOP_AIMBOT_PRESETS } from './aimbot';
import type { AimbotPreset } from './aimbot';
import { lnurlPayInvoice } from './ln/lnurl';
import { getWallet } from './wallet';
import { store, loadOwnedItems, saveOwnedItems } from './store';

// Re-exported ownership storage (the store owns the persisted list).
export { loadOwnedItems, saveOwnedItems };

// ------------------------------------------------------------------ items
export interface ShopItem {
  /** Item id; equals the aimbot preset id it unlocks. */
  id: string;
  label: string;
  /** Aimbot preset id (see game/aimbot.ts). */
  preset: string;
  /** Price, in satoshis. */
  priceSats: number;
  blurb: string;
}

/** Lightning address that receives shop payments ('' disables buying). */
export const SHOP_SELLER_LUD16 = String(
  (import.meta.env?.VITE_IE_SHOP_LUD16 as string | undefined) ?? '',
).trim();

/** Strictly stronger than every free preset; locked until purchased. */
export const SHOP_ITEMS: readonly ShopItem[] = [
  {
    id: 'sniper', label: 'Sniper', preset: 'sniper', priceSats: 300,
    blurb: 'Widens the aim cone and range beyond Ace.',
  },
  {
    id: 'oracle', label: 'Oracle', preset: 'oracle', priceSats: 750,
    blurb: 'Longer reach and a softer stick gate than Sniper.',
  },
  {
    id: 'deadeye', label: 'Deadeye', preset: 'deadeye', priceSats: 1500,
    blurb: 'The strongest assist in the game. Barely steer.',
  },
];

export function findShopItem(id: string): ShopItem | null {
  return SHOP_ITEMS.find((i) => i.id === id) ?? null;
}

// ------------------------------------------------------- aimbot availability
/** The free presets plus the shop presets whose item is owned. */
export function availableAimbotPresets(ownedIds: readonly string[]): AimbotPreset[] {
  return [
    ...AIMBOT_PRESETS,
    ...SHOP_AIMBOT_PRESETS.filter((p) => ownedIds.includes(p.id)),
  ];
}

/** True when a preset may be selected (free, or a shop preset that is owned). */
export function aimbotUnlocked(presetId: string | null | undefined, ownedIds: readonly string[]): boolean {
  if (!presetId) return false;
  if (AIMBOT_PRESETS.some((p) => p.id === presetId)) return true;
  return SHOP_AIMBOT_PRESETS.some((p) => p.id === presetId) && ownedIds.includes(presetId);
}

/** Resolve to a selectable preset, refusing a locked id (falls back to Rookie). */
export function resolveUnlockedAimbot(
  presetId: string | null | undefined,
  ownedIds: readonly string[],
): AimbotPreset {
  const available = availableAimbotPresets(ownedIds);
  return available.find((p) => p.id === presetId) ?? AIMBOT_PRESETS[0];
}

// ------------------------------------------------------------------ shop
export type PurchaseReason =
  | 'ok' | 'owned' | 'unknown' | 'funds' | 'wallet' | 'seller' | 'failed';

export interface PurchaseResult {
  ok: boolean;
  reason: PurchaseReason;
  /** Human-readable detail for the shop's status line. */
  message?: string;
}

export interface ShopDeps {
  /** Already-owned items (defaults to the persisted list). */
  initialOwned?: readonly string[];
  /** Notified whenever an item is unlocked (the UI mirrors ownership). */
  onOwnership?: () => void;
}

export class Shop {
  onOwnership: (() => void) | null = null;

  private owned: Set<string>;

  constructor(deps: ShopDeps = {}) {
    this.onOwnership = deps.onOwnership ?? null;
    this.owned = new Set();
    for (const id of deps.initialOwned ?? loadOwnedItems()) {
      if (findShopItem(id)) this.owned.add(id);
    }
  }

  isOwned(itemId: string): boolean {
    return this.owned.has(itemId);
  }

  ownedItems(): string[] {
    return [...this.owned];
  }

  /** Drop every locally-owned item. */
  clearOwnership(): void {
    this.owned.clear();
    saveOwnedItems([]);
    store.ownedItems = [];
    this.onOwnership?.();
  }

  /**
   * Buy an item: fetch the seller's invoice (LNURL-pay), pay it with the linked
   * Lightning wallet, then unlock the preset. Nothing is applied until the
   * payment succeeds.
   */
  async purchase(itemId: string): Promise<PurchaseResult> {
    const item = findShopItem(itemId);
    if (!item) return { ok: false, reason: 'unknown' };
    if (this.owned.has(itemId)) return { ok: false, reason: 'owned' };

    const wallet = getWallet();
    if (!wallet || !wallet.connected) {
      return { ok: false, reason: 'wallet', message: 'link a Lightning wallet first' };
    }
    if (!SHOP_SELLER_LUD16) {
      return { ok: false, reason: 'seller', message: 'the shop has no seller address configured' };
    }
    const balance = wallet.balanceSats;
    if (balance !== null && balance < item.priceSats) {
      return { ok: false, reason: 'funds', message: `need ${item.priceSats} sats` };
    }

    let invoice: string | null = null;
    try {
      invoice = await lnurlPayInvoice(SHOP_SELLER_LUD16, item.priceSats, `Infinity Edge: ${item.label}`);
    } catch {
      invoice = null;
    }
    if (!invoice) {
      return { ok: false, reason: 'failed', message: 'the seller did not return an invoice' };
    }

    try {
      await wallet.pay(invoice);
    } catch (e) {
      return { ok: false, reason: 'failed', message: (e as Error).message || 'payment failed' };
    }

    this.record(itemId);
    return { ok: true, reason: 'ok' };
  }

  /** Re-read the persisted ownership list. Returns the owned ids. */
  refreshOwnership(): string[] {
    for (const id of loadOwnedItems()) {
      if (findShopItem(id)) this.owned.add(id);
    }
    return this.ownedItems();
  }

  private record(itemId: string): boolean {
    if (this.owned.has(itemId)) return false;
    this.owned.add(itemId);
    const items = [...this.owned];
    saveOwnedItems(items);
    store.ownedItems = items;
    this.onOwnership?.();
    return true;
  }
}

// ------------------------------------------------------------ app singleton
let instance: Shop | null = null;

export function getShop(): Shop | null {
  return instance;
}

export function setShop(s: Shop | null): void {
  instance = s;
}

/** Wire the singleton shop to the UI. Idempotent. */
export function attachShop(onOwnership?: () => void): Shop {
  if (!instance) instance = new Shop({ onOwnership });
  if (onOwnership) instance.onOwnership = onOwnership;
  store.ownedItems = instance.ownedItems();
  return instance;
}
