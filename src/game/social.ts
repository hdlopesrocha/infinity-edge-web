// Social data helpers: the per-game high scores (read from every user's Nostr
// score profile) and the local inbox of human-to-human DMs.
//
// Pure, so the Social screen and its tests do not need a live relay.

import { bytesToHex, hexToBytes } from './nostr/crypto';
import { decodeKeyEntity, npubEncode } from './nostr/bech32';
import type { DmMessage } from './nostr/dm';
import { isBetterRun } from './scores';
import type { ProfileScore, ScoreProfile } from './scores';
import type { ScoreType } from './team';

/** Display label for every game mode. */
const MODE_LABELS: Record<ScoreType, string> = {
  TT: 'TIME TRIAL',
  CTF: 'CAPTURE THE FLAG',
  KOTS: 'KING OF THE SYSTEM',
  SURV: 'SURVIVAL',
};
/** The order the modes are listed in. */
const MODE_ORDER: readonly ScoreType[] = ['TT', 'CTF', 'KOTS', 'SURV'];

/** The best run of one game mode, read from the Nostr score profiles. */
export interface GameHighScore {
  type: ScoreType;
  /** Human label ("TIME TRIAL", …). */
  label: string;
  /** Player name shipped in the profile. */
  name: string;
  /** Owner x-only public key (hex). */
  owner: string;
  /** Display-ready value ("12.34 s", "9 captures", …). */
  value: string;
}

/** Format a run's headline value for its mode. */
function formatRun(s: ProfileScore): string {
  if (s.type === 'TT') return `${(s.timeMs / 1000).toFixed(2)} s`;
  if (s.type === 'CTF') return `${s.points} capture${s.points === 1 ? '' : 's'}`;
  if (s.type === 'KOTS') {
    const total = Math.max(0, Math.floor(s.score / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')} on the hill`;
  }
  return `${s.score} kill${s.score === 1 ? '' : 's'}`;
}

/**
 * The single best run of every game mode across all published profiles (Time
 * Trial by fastest time, the others by highest score/captures).
 */
export function gameHighScores(
  profiles: readonly { pubkey: string; profile: ScoreProfile }[],
): GameHighScore[] {
  const best = new Map<ScoreType, { owner: string; run: ProfileScore }>();
  for (const { pubkey, profile } of profiles) {
    for (const run of profile.scores) {
      const cur = best.get(run.type);
      if (!cur || isBetterRun(run, cur.run)) best.set(run.type, { owner: pubkey, run });
    }
  }
  const out: GameHighScore[] = [];
  for (const type of MODE_ORDER) {
    const entry = best.get(type);
    if (!entry) continue;
    out.push({
      type,
      label: MODE_LABELS[type] ?? type,
      name: entry.run.name,
      owner: entry.owner,
      value: formatRun(entry.run),
    });
  }
  return out;
}

/** Hex x-only public key from an npub or 64-hex input; null when invalid. */
function toHex(input: string): string | null {
  const s = String(input ?? '').trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  const decoded = decodeKeyEntity(s);
  return decoded ? bytesToHex(decoded.bytes) : null;
}

/** A short npub/hex label: "npub1abcd…wxyz". */
export function shortKey(hexOrNpub: string): string {
  const s = String(hexOrNpub ?? '');
  const hex = toHex(s);
  if (hex) {
    try {
      const npub = npubEncode(hexToBytes(hex));
      return npub.slice(0, 10) + '…' + npub.slice(-4);
    } catch { /* fall through to a raw slice */ }
  }
  return s.length > 16 ? s.slice(0, 12) + '…' + s.slice(-4) : s;
}

/** Hex x-only public key of a recipient entered as npub or hex; null when invalid. */
export function recipientHex(input: string): string | null {
  const hex = toHex(input);
  return hex ? bytesToHex(hexToBytes(hex)) : null;
}

/** One message shown in the inbox. */
export interface InboxMessage {
  id: string;
  /** Sender x-only public key (hex). */
  from: string;
  text: string;
  created: number;
}

/** The messages in a DM log, newest first. */
export function inboxMessages(dms: readonly DmMessage[], limit = 50): InboxMessage[] {
  const out: InboxMessage[] = [];
  for (const dm of dms) {
    out.push({ id: dm.id, from: dm.from, text: dm.plaintext, created: dm.created });
  }
  return out.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id)).slice(0, Math.max(0, limit));
}
