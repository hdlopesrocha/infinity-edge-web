import { describe, expect, it } from 'vitest';
import { takeMatchResult } from '../src/game/matchresult';

describe('finished match handover', () => {
  it('takes the pending result once and attaches the level key', () => {
    const instance = { result: { won: true, reward: 'Gold', message: 'You win' } };
    expect(takeMatchResult(instance, 'game', 'ctf-easy')).toEqual({
      won: true, reward: 'Gold', message: 'You win', level: 'ctf-easy',
    });
    expect(instance.result).toBeNull();
    expect(takeMatchResult(instance, 'game', 'ctf-easy')).toBeNull();
  });

  it('does not consume a result for another route', () => {
    const instance = { result: { won: false, reward: 'Defeat', message: null } };
    expect(takeMatchResult(instance, 'victory', 'ctf-easy')).toBeNull();
    expect(instance.result).not.toBeNull();
  });

  it('ignores a missing instance and preserves defeat results', () => {
    expect(takeMatchResult(null, 'game', 'tt-easy')).toBeNull();
    const instance = { result: { won: false, reward: 'Defeat', message: 'Time up' } };
    expect(takeMatchResult(instance, 'game', 'tt-easy')).toEqual({
      won: false, reward: 'Defeat', message: 'Time up', level: 'tt-easy',
    });
  });
});
