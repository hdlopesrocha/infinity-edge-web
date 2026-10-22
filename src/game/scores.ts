// High scores in the player's Nostr profile.
//
// The local board (store.addScore) stays the fast path for the briefing list.
// Every achieved score is ALSO merged into a replaceable per-user event (NIP-78
// addressable: kind 30078, `d = ie3d-scores`) so each player's best runs live in
// their Nostr profile and anyone can read them for the public board.
//
// The content is a small, versioned JSON document; the helpers here are pure so
// the store, the match result path and the tests never need a live relay.

import type { ScoreEntry, ScoreType } from './team';
import type { NostrEvent } from './nostr/event';

export const SCORES_KIND = 30078;
export const SCORES_D = 'ie3d-scores';
export const SCORES_VERSION = 1;

/** One run recorded in a player's profile. */
export interface ProfileScore {
  /** Board family: TT / CTF / KOTS / SURV. */
  type: ScoreType;
  /** Save slot / level key the run belongs to. */
  save: string;
  /** Player name at the time of the run. */
  name: string;
  /** CTF captures (and the generic points slot). */
  points: number;
  /** Time-trial time in ms (lower is better). */
  timeMs: number;
  /** King-of-the-System / Survival score (higher is better). */
  score: number;
  /** True for the local player's own entry. */
  control: boolean;
  /** Unix seconds the run was recorded. */
  at: number;
}

export interface ScoreProfile {
  v: number;
  updated: number;
  scores: ProfileScore[];
}

/** Identity of a run for best-merge purposes (board + save + player name). */
export function profileKey(s: ProfileScore): string {
  return `${s.type}:${s.save}:${s.name}`;
}

/** True when `a` is the better run of the two on the same board. */
export function isBetterRun(a: ProfileScore, b: ProfileScore): boolean {
  if (a.type === 'TT') return a.timeMs < b.timeMs;
  const av = a.type === 'CTF' ? a.points : a.score;
  const bv = b.type === 'CTF' ? b.points : b.score;
  return av > bv;
}

/** Merge incoming runs over the existing ones, keeping the best per key. */
export function mergeProfileScores(
  existing: readonly ProfileScore[], incoming: readonly ProfileScore[],
): ProfileScore[] {
  const byKey = new Map<string, ProfileScore>();
  for (const s of existing) byKey.set(profileKey(s), s);
  for (const s of incoming) {
    const key = profileKey(s);
    const cur = byKey.get(key);
    if (!cur || isBetterRun(s, cur)) byKey.set(key, s);
  }
  return [...byKey.values()].sort(
    (a, b) => a.type.localeCompare(b.type) || a.save.localeCompare(b.save) || a.name.localeCompare(b.name),
  );
}

/** Parse a profile event's content; null when malformed or a foreign version. */
export function parseScoreProfile(content: string): ScoreProfile | null {
  let raw: Partial<ScoreProfile>;
  try {
    raw = JSON.parse(String(content ?? '')) as Partial<ScoreProfile>;
  } catch {
    return null;
  }
  if (!raw || raw.v !== SCORES_VERSION || !Array.isArray(raw.scores)) return null;
  const scores: ProfileScore[] = [];
  for (const entry of raw.scores) {
    const s = entry as Partial<ProfileScore>;
    if (typeof s?.type !== 'string' || typeof s?.save !== 'string' || typeof s?.name !== 'string') continue;
    scores.push({
      type: s.type as ScoreType,
      save: s.save,
      name: s.name,
      points: Number(s.points) || 0,
      timeMs: Number(s.timeMs) || 0,
      score: Number(s.score) || 0,
      control: s.control === true,
      at: Number(s.at) || 0,
    });
  }
  return { v: SCORES_VERSION, updated: Number(raw.updated) || 0, scores };
}

/** The profile runs produced by one finished GameScore on a given board. */
export function runsFromGameScore(
  gs: { scores: readonly ScoreEntry[] }, type: ScoreType, save: string, at: number,
): ProfileScore[] {
  return gs.scores.map((s) => ({
    type, save, name: s.name, points: s.points, timeMs: s.timeMs,
    score: s.score ?? 0, control: s.control, at,
  }));
}

/** The transport the score helpers need (satisfied by the mp manager). */
export interface ProfileTransport {
  pubkey: string;
  publishNostr(kind: number, tags: string[][], content: string): Promise<boolean>;
  fetchNostr(filters: unknown[], waitMs?: number): Promise<NostrEvent[]>;
}

/** Merge `runs` into `existing`, publish the profile and return what was sent. */
export async function publishScoreProfile(
  t: ProfileTransport,
  runs: readonly ProfileScore[],
  existing: readonly ProfileScore[] = [],
  now = Math.floor(Date.now() / 1000),
): Promise<ScoreProfile> {
  const profile: ScoreProfile = {
    v: SCORES_VERSION,
    updated: now,
    scores: mergeProfileScores(existing, runs),
  };
  await t.publishNostr(SCORES_KIND, [['d', SCORES_D]], JSON.stringify(profile));
  return profile;
}

/** Read every user's published score profile (newest event per author). */
export async function fetchScoreProfiles(
  t: ProfileTransport, waitMs = 4000,
): Promise<{ pubkey: string; profile: ScoreProfile }[]> {
  const events = await t.fetchNostr(
    [{ kinds: [SCORES_KIND], '#d': [SCORES_D], limit: 500 }], waitMs,
  );
  const newest = new Map<string, NostrEvent>();
  for (const evt of events) {
    if (evt.kind !== SCORES_KIND) continue;
    const prev = newest.get(evt.pubkey);
    if (!prev || evt.created_at > prev.created_at) newest.set(evt.pubkey, evt);
  }
  const out: { pubkey: string; profile: ScoreProfile }[] = [];
  for (const [pubkey, evt] of newest) {
    const profile = parseScoreProfile(evt.content);
    if (profile) out.push({ pubkey, profile });
  }
  return out;
}
