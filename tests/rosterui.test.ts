// Shared roster UI helpers (used by the briefing and the multiplayer room).
import { describe, expect, it } from 'vitest';
import { optionLabel, optionListHeight, teamOptions } from '../src/game/ui/rosterui';

describe('roster ui', () => {
  it('labels team ids for the dropdowns', () => {
    const opts = teamOptions(['team1', 'team2', 'team3', 'team4']);
    expect(opts.map((o) => o.label)).toEqual(['Team 1', 'Team 2', 'Team 3', 'Team 4']);
    expect(opts.map((o) => o.value)).toEqual(['team1', 'team2', 'team3', 'team4']);
  });

  it('falls back to the raw value for an unknown option', () => {
    const opts = teamOptions(['team1']);
    expect(optionLabel(opts, 'team1')).toBe('Team 1');
    expect(optionLabel(opts, 'falcon')).toBe('falcon');
  });

  it('sizes the option list', () => {
    expect(optionListHeight(4, 26, 4)).toBe(4 * 26 + 8);
  });
});
