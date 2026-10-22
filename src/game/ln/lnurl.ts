// Minimal LNURL-pay (LUD-16 lightning address) invoice request.
//
// Used by the shop: the creator is paid in sats via their `user@domain`
// lightning address. Fetches the pay endpoint and returns a BOLT-11 invoice.

/** Fetch a BOLT-11 invoice for `amountSats` from a `user@domain` address. */
export async function lnurlPayInvoice(
  lud16: string, amountSats: number, comment = '',
): Promise<string | null> {
  const [user, domain] = String(lud16 ?? '').split('@');
  if (!user || !domain) return null;
  const msats = Math.max(1000, Math.round(amountSats * 1000));
  try {
    const meta = await fetch(
      `https://${domain}/.well-known/lnurlp/${encodeURIComponent(user)}`,
    ).then((r) => r.json()) as { callback?: string; commentAllowed?: number };
    if (!meta?.callback) return null;
    const url = new URL(meta.callback);
    url.searchParams.set('amount', String(msats));
    if (comment && (meta.commentAllowed ?? 0) >= comment.length) {
      url.searchParams.set('comment', comment);
    }
    const res = await fetch(url.toString()).then((r) => r.json()) as { pr?: string };
    return typeof res?.pr === 'string' ? res.pr : null;
  } catch {
    return null;
  }
}

/** True when a string looks like a lightning address. */
export function isLightningAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? '').trim());
}
