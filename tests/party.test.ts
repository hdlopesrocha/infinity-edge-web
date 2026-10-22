// Party mode: beat tracking from synthetic music levels and the colour rules
// that keep the enemy teams out of the music-reactive palette.
import { describe, expect, it } from 'vitest';
import { applyTeamColors, hexToRgb, rgbToHsv } from '../src/game/colors';
import type { GameInstance } from '../src/game/instance';
import {
  applyMusicFrame, party, partyPlayerColor, partyShiftColor,
  partySkyContrast, partySkyHsb, partySkyHue, resetParty,
  PARTY_BEAT_HUE_BASE, PARTY_BEAT_HUE_BASS,
  PARTY_SKY_HUE_DEG, PARTY_SKY_HUE_KICK_DEG,
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
    // The hue step is larger than the previous 0.06 + bass * 0.30 response.
    expect(party.hue).toBeGreaterThan(0.06 + 0.8 * 0.30);
    // The sky now sways further than the old +/-10 degrees and still stays in
    // the wider band the level art can survive.
    const bound = PARTY_SKY_HUE_DEG + PARTY_SKY_HUE_KICK_DEG;
    expect(Math.abs(partySkyHue())).toBeGreaterThan(10);
    expect(partySkyHue()).toBeGreaterThanOrEqual(-bound);
    expect(partySkyHue()).toBeLessThanOrEqual(bound);
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

  it('steps the player hue further than the old detector on a bass onset', () => {
    resetParty();
    applyMusicFrame(party, bands(0.9, 0.1, 0.1), 100);
    // Old response at bass 0.9 was 0.06 + 0.9 * 0.30 = 0.33 turns.
    expect(party.hue).toBeGreaterThan(0.06 + 0.9 * 0.30);
    expect(party.hue).toBeCloseTo(PARTY_BEAT_HUE_BASE + 0.9 * PARTY_BEAT_HUE_BASS, 6);
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
    const human = new Team('team1', [1, 0, 0]);
    const alien = new Team('team2', [1, 0, 0]);
    const gi = instanceWith([human, alien], human);
    const options = { partyMode: true, playerColor: '#ff0000', enemyColor: '#00ff00' };
    applyTeamColors(gi, options, partyPlayerColor(options));
    expect(human.color).not.toEqual([1, 0, 0]);
    expect(alien.color).toEqual(hexToRgb('#00ff00'));
  });

  it('flashes the player brighter and more saturated on a bass hit', () => {
    resetParty();
    party.active = true;
    const options = { partyMode: true, playerColor: '#40a060', enemyColor: '#00ff00' };
    const base = rgbToHsv(partyPlayerColor(options));
    party.bassPulse = 0.8;
    party.bass = 0.8;
    const hit = rgbToHsv(partyPlayerColor(options));
    expect(hit[1]).toBeGreaterThan(base[1]);
    expect(hit[2]).toBeGreaterThan(base[2]);
    // Both the saturation and the brightness flash are larger than the old
    // 0.22 / 0.14 lifts at this bass level.
    expect(hit[1] - base[1]).toBeGreaterThan(0.22);
    expect(hit[2] - base[2]).toBeGreaterThan(0.14);
  });

  it('flashes a neutral player colour visibly on a bass hit', () => {
    resetParty();
    party.active = true;
    party.bassPulse = 0.9;
    party.bass = 0.9;
    const options = { partyMode: true, playerColor: '#808080', enemyColor: '#00ff00' };
    const base = rgbToHsv(hexToRgb('#808080'));
    const hit = rgbToHsv(partyPlayerColor(options));
    // Hue rotation is invisible on grey, so the saturation/value flash has to
    // carry the beat by itself.
    expect(hit[1]).toBeGreaterThan(base[1]);
    expect(hit[2]).toBeGreaterThan(base[2]);
  });

  it('uses the configured player colour when party mode is off', () => {
    resetParty();
    const options = { partyMode: false, playerColor: '#00ff00', enemyColor: '#ff0000' };
    expect(partyPlayerColor(options)).toEqual(hexToRgb('#00ff00'));
  });
});

describe('party sky', () => {
  it('drives the sky hue and brightness from the bass line', () => {
    resetParty();
    party.active = true;
    // Neutral beat: no strong hue sway, no brightness lift.
    expect(partySkyHue()).toBeCloseTo(0, 6);
    expect(partySkyContrast()).toBe(1);
    expect(partySkyHsb([0, 1, 1])).toEqual([0, 1, 1]);
    party.bassPulse = 1;
    party.bass = 1;
    party.pulse = 1;
    const kicked = partySkyHsb([0, 1, 1]);
    expect(Math.abs(partySkyHue())).toBeGreaterThan(10);
    expect(kicked[0]).toBeCloseTo(partySkyHue(), 6);
    // Only hue/value move: the sky saturation is untouched, and the extra
    // brightness comes from the bass, never from a team colour.
    expect(kicked[1]).toBe(1);
    expect(kicked[2]).toBeGreaterThan(1);
    expect(partySkyContrast()).toBeGreaterThan(1);
  });

  it('leaves the sky untouched when party mode is off', () => {
    resetParty();
    const hsb = partySkyHsb([168.2, 0.99, 1]);
    expect(hsb).toEqual([168.2, 0.99, 1]);
    expect(partySkyHue()).toBe(0);
    expect(partySkyContrast()).toBe(1);
  });
});
