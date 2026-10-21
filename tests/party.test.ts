// Party mode: beat tracking from synthetic music levels and the colour rules
// that keep the enemy teams out of the music-reactive palette.
import { describe, expect, it } from 'vitest';
import { applyTeamColors, hexToRgb, rgbToHsv } from '../src/game/colors';
import type { GameInstance } from '../src/game/instance';
import {
  applyMusicFrame, party, partyPlayerColor, partyShiftColor,
  partySkyContrast, partySkyHue, resetParty,
} from '../src/game/party';
import { Team } from '../src/game/team';

function levels(energy: number) {
  return { energy, bass: energy, mid: energy * 0.4, high: energy * 0.2 };
}

function bands(bass: number, mid: number, high: number) {
  return { energy: bass * 0.65 + mid * 0.25 + high * 0.1, bass, mid, high };
}

function instanceWith(ships: Team[], selected: Team): Pick<GameInstance, 'teams' | 'selectedObject'> {
  return {
    teams: new Map(ships.map((t) => [t.name, t])),
    selectedObject: { team: selected },
  } as unknown as Pick<GameInstance, 'teams' | 'selectedObject'>;
}

describe('party beat tracker', () => {
  it('advances the hue on a beat and smooths the visible colour', () => {
    resetParty();
    applyMusicFrame(party, levels(0.8), 100);
    expect(party.active).toBe(true);
    expect(party.pulse).toBe(1);
    expect(party.hue).toBeGreaterThan(0);
    expect(party.shownHue).toBeGreaterThan(0);
    expect(party.shownHue).toBeLessThan(party.hue);
    expect(partySkyHue()).toBeGreaterThanOrEqual(-10);
    expect(partySkyHue()).toBeLessThanOrEqual(10);
    expect(partySkyContrast()).toBeGreaterThan(1);
  });

  it('does not retrigger during the minimum beat interval', () => {
    resetParty();
    applyMusicFrame(party, levels(0.8), 100);
    const first = party.hue;
    applyMusicFrame(party, levels(0.8), 100);
    expect(party.hue).toBe(first);
    // A louder transient after the refractory window does trigger again.
    applyMusicFrame(party, levels(0.2), 100);
    applyMusicFrame(party, levels(0.9), 100);
    expect(party.hue).not.toBe(first);
  });

  it('turns the hue on bass transients, not on mid/high transients', () => {
    resetParty();
    applyMusicFrame(party, bands(0.01, 0.9, 0.8), 100);
    expect(party.hue).toBe(0);
    expect(party.bassPulse).toBe(0);
    applyMusicFrame(party, bands(0.8, 0.15, 0.1), 100);
    expect(party.hue).toBeGreaterThan(0);
    expect(party.bassPulse).toBeCloseTo(0.8, 5);
  });

  it('turns further on harder bass hits', () => {
    resetParty();
    applyMusicFrame(party, bands(0.2, 0.1, 0.1), 100);
    const soft = party.hue;
    resetParty();
    applyMusicFrame(party, bands(0.95, 0.1, 0.1), 100);
    const hard = party.hue;
    expect(hard).toBeGreaterThan(soft);
  });

  it('decays the bass pulse without a new bass hit', () => {
    resetParty();
    applyMusicFrame(party, bands(0.8, 0.1, 0.1), 100);
    const hit = party.bassPulse;
    applyMusicFrame(party, bands(0.05, 0.8, 0.8), 100);
    expect(party.bassPulse).toBeLessThan(hit);
  });

  it('resets to a neutral state when party mode is off', () => {
    resetParty();
    party.active = true;
    party.shownHue = 0.4;
    party.bassPulse = 0.6;
    resetParty();
    expect(party.active).toBe(false);
    expect(party.shownHue).toBe(0);
    expect(party.bassPulse).toBe(0);
    expect(partyShiftColor([1, 0, 0])).toEqual([1, 0, 0]);
  });
});

describe('party colours', () => {
  it('shifts the player hue but leaves enemy teams untouched', () => {
    resetParty();
    party.active = true;
    party.shownHue = 0.5;
    const human = new Team('human', [1, 0, 0]);
    const alien = new Team('alien', [1, 0, 0]);
    const gi = instanceWith([human, alien], human);
    const options = { partyMode: true, playerColor: '#ff0000', enemyColor: '#00ff00' };
    applyTeamColors(gi, options, partyPlayerColor(options));
    expect(human.color).not.toEqual([1, 0, 0]);
    expect(alien.color).toEqual(hexToRgb('#00ff00'));
  });

  it('flashes the player brighter and more saturated on a bass hit', () => {
    resetParty();
    party.active = true;
    const options = { partyMode: true, playerColor: '#40e0d0', enemyColor: '#00ff00' };
    const base = rgbToHsv(partyPlayerColor(options));
    party.bassPulse = 0.8;
    const hit = rgbToHsv(partyPlayerColor(options));
    expect(hit[1]).toBeGreaterThan(base[1]);
    expect(hit[2]).toBeGreaterThan(base[2]);
  });

  it('uses the configured player colour when party mode is off', () => {
    resetParty();
    const options = { partyMode: false, playerColor: '#00ff00', enemyColor: '#ff0000' };
    expect(partyPlayerColor(options)).toEqual(hexToRgb('#00ff00'));
  });
});
