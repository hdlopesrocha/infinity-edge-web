// Nostr score-profile helpers: merge/parse/rank (pure, no relay).
import { describe, expect, it } from 'vitest';
import {
  SCORES_VERSION, isBetterRun, mergeProfileScores, parseScoreProfile, profileKey, runsFromGameScore,
} from '../src/game/scores';
import type { ProfileScore } from '../src/game/scores';

function run(type: ProfileScore['type'], save: string, name: string, over: Partial<ProfileScore>): ProfileScore {
  return { type, save, name, points: 0, timeMs: 0, score: 0, control: true, at: 0, ...over };
}

describe('score profiles', () => {
  it('keys a run by board, save slot and player', () => {
    expect(profileKey(run('CTF', 'lvl1', 'ace', {}))).toBe('CTF:lvl1:ace');
  });

  it('prefers the better run per key (points up, time down)', () => {
    expect(isBetterRun(run('CTF', 'l', 'a', { points: 5 }), run('CTF', 'l', 'a', { points: 3 }))).toBe(true);
    expect(isBetterRun(run('TT', 'l', 'a', { timeMs: 1000 }), run('TT', 'l', 'a', { timeMs: 2000 }))).toBe(true);
  });

  it('merges bests and drops the worse duplicate', () => {
    const merged = mergeProfileScores(
      [run('CTF', 'l', 'a', { points: 3 })],
      [run('CTF', 'l', 'a', { points: 7 }), run('SURV', 'l', 'a', { score: 4 })],
    );
    expect(merged).toHaveLength(2);
    expect(merged.find((s) => s.type === 'CTF')?.points).toBe(7);
    expect(merged.find((s) => s.type === 'SURV')?.score).toBe(4);
  });

  it('round-trips through the profile document and rejects junk', () => {
    const scores = [run('KOTS', 'l', 'a', { score: 12 })];
    const parsed = parseScoreProfile(JSON.stringify({ v: SCORES_VERSION, updated: 1, scores }));
    expect(parsed?.scores[0].score).toBe(12);
    expect(parseScoreProfile('not json')).toBeNull();
    expect(parseScoreProfile(JSON.stringify({ v: 99, scores: [] }))).toBeNull();
    expect(parseScoreProfile(JSON.stringify({ v: 1 }))).toBeNull();
  });

  it('builds runs from a finished game score', () => {
    const runs = runsFromGameScore(
      { scores: [{ name: 'ace', points: 4, timeMs: 10, control: true }] },
      'CTF', 'lvl', 42,
    );
    expect(runs).toEqual([{ type: 'CTF', save: 'lvl', name: 'ace', points: 4, timeMs: 10, score: 0, control: true, at: 42 }]);
  });
});
