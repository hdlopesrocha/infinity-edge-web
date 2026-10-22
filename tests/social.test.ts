// Social helpers: the per-game high scores and the DM inbox.
import { describe, expect, it } from 'vitest';
import { gameHighScores, inboxMessages, recipientHex, shortKey } from '../src/game/social';
import type { ScoreProfile } from '../src/game/scores';
import type { DmMessage } from '../src/game/nostr/dm';
import { bytesToHex, hexToBytes, randomBytes, schnorrPubkey, validSecretKey } from '../src/game/nostr/crypto';
import { npubEncode } from '../src/game/nostr/bech32';

function keyHex(): string {
  let sk = randomBytes(32);
  while (!validSecretKey(sk)) sk = randomBytes(32);
  return bytesToHex(schnorrPubkey(sk));
}

function profile(type: 'TT' | 'CTF' | 'KOTS' | 'SURV', name: string, run: Partial<ScoreProfile['scores'][number]>): ScoreProfile {
  return {
    v: 1,
    updated: 0,
    scores: [{
      type, save: 'lvl', name, points: 0, timeMs: 0, score: 0, control: true, at: 0, ...run,
    }],
  };
}

describe('social helpers', () => {
  it('keeps one best run per game mode across every profile', () => {
    const a = keyHex(), b = keyHex();
    const rows = gameHighScores([
      { pubkey: a, profile: profile('CTF', 'ace', { points: 3 }) },
      { pubkey: b, profile: profile('CTF', 'rookie', { points: 9 }) },
      { pubkey: a, profile: profile('SURV', 'ace', { score: 12 }) },
    ]);
    expect(rows.map((r) => r.type)).toEqual(['CTF', 'SURV']);
    const ctf = rows.find((r) => r.type === 'CTF');
    expect([ctf?.name, ctf?.value]).toEqual(['rookie', '9 captures']);
    expect(rows.find((r) => r.type === 'SURV')?.value).toBe('12 kills');
  });

  it('picks the fastest time trial, not the highest number', () => {
    const a = keyHex(), b = keyHex();
    const rows = gameHighScores([
      { pubkey: a, profile: profile('TT', 'slow', { timeMs: 45000 }) },
      { pubkey: b, profile: profile('TT', 'fast', { timeMs: 12000 }) },
    ]);
    expect(rows).toHaveLength(1);
    expect([rows[0].name, rows[0].value]).toEqual(['fast', '12.00 s']);
  });

  it('formats the King of the System hill time', () => {
    const rows = gameHighScores([
      { pubkey: keyHex(), profile: profile('KOTS', 'king', { score: 125000 }) },
    ]);
    expect(rows[0].value).toBe('2:05 on the hill');
  });

  it('shortens keys and decodes a typed recipient', () => {
    const hex = keyHex();
    const npub = npubEncode(hexToBytes(hex));
    expect(shortKey(npub)).toContain('…');
    expect(shortKey(npub)).toMatch(/^npub1/);
    expect(recipientHex(npub)).toBe(hex);
    expect(recipientHex(hex)).toBe(hex);
    expect(recipientHex('nope')).toBeNull();
  });

  it('lists DMs newest first', () => {
    const alice = keyHex(), bob = keyHex();
    const dms: DmMessage[] = [
      { id: '1', from: alice, plaintext: 'hi', created: 10 },
      { id: '3', from: bob, plaintext: 'yo', created: 30 },
    ];
    const inbox = inboxMessages(dms);
    expect(inbox.map((m) => m.text)).toEqual(['yo', 'hi']);
    expect(inbox[0].from).toBe(bob);
  });
});
