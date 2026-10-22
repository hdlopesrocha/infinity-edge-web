import { describe, expect, it } from 'vitest';
import {
  applyTeamColors, avoidCloseHues, COLOR_PALETTE, DEFAULT_ENEMY_COLOR, DEFAULT_PLAYER_COLOR,
  hexToRgb, hsvToRgb, normalizeHexColor, rgbToHex, rgbToHsv, teamColor, TEAM_DEFAULT_COLORS,
} from '../src/game/colors';
import { defaultOptions } from '../src/game/resources';
import { Team } from '../src/game/team';
import type { GameInstance } from '../src/game/instance';

function team(name: string, color: [number, number, number]): Team {
  return new Team(name, color);
}

function instanceWith(
  ships: Team[],
  selected: Team | null,
): Pick<GameInstance, 'teams' | 'selectedObject'> {
  return {
    teams: new Map(ships.map((t) => [t.name, t])),
    selectedObject: selected ? { team: selected } : null,
  } as unknown as Pick<GameInstance, 'teams' | 'selectedObject'>;
}

describe('colour options', () => {
  it('keeps the original team colours as defaults', () => {
    expect(defaultOptions().playerColor).toBe(DEFAULT_PLAYER_COLOR);
    expect(defaultOptions().enemyColor).toBe(DEFAULT_ENEMY_COLOR);
    expect(COLOR_PALETTE).toContain(DEFAULT_PLAYER_COLOR);
    expect(COLOR_PALETTE).toContain(DEFAULT_ENEMY_COLOR);
  });

  it('resolves a team colour for the roster/room lists', () => {
    const o = defaultOptions();
    // The four team colours are the defaults; the player's team follows it too.
    expect(teamColor('team1', o)).toEqual(hexToRgb(o.teamColors.team1));
    expect(teamColor('team3', o)).toEqual(hexToRgb(TEAM_DEFAULT_COLORS[2]));
    // An explicit per-team colour wins.
    const custom = { ...o, teamColors: { team3: '#00ff00' } };
    expect(teamColor('team3', custom)).toEqual(hexToRgb('#00ff00'));
    // With no team colour stored, the team defaults are used.
    const bare = { ...o, teamColors: {} };
    expect(teamColor('team4', bare)).toEqual(hexToRgb(TEAM_DEFAULT_COLORS[3]));
  });

  it('parses hex colours and rejects malformed values', () => {
    expect(normalizeHexColor('#40E0D0')).toBe('#40e0d0');
    expect(normalizeHexColor('40e0d0')).toBe('#40e0d0');
    expect(normalizeHexColor('not-a-colour', '#123456')).toBe('#123456');
    const rgb = hexToRgb('#ff8000');
    expect(rgb[0]).toBe(1);
    expect(rgb[1]).toBeCloseTo(128 / 255, 6);
    expect(rgb[2]).toBe(0);
    expect(rgbToHex(rgb)).toBe('#ff8000');
  });

  it('recolours the player team and every enemy while leaving ambient alone', () => {
    const human = team('team1', [64 / 255, 224 / 255, 208 / 255]);
    const alien = team('team2', [1, 0, 0]);
    const falcon = team('falcon', [1, 0.78, 0.24]);
    const ambient = team('ambient', [50 / 255, 205 / 255, 50 / 255]);
    const gi = instanceWith([human, alien, falcon, ambient], human);
    applyTeamColors(gi, { playerColor: '#00ff00', enemyColor: '#0000ff' });
    expect(human.color).toEqual([0, 1, 0]);
    expect(alien.color).toEqual([0, 0, 1]);
    expect(falcon.color).toEqual([0, 0, 1]);
    expect(ambient.color).toEqual([50 / 255, 205 / 255, 50 / 255]);
  });

  it('follows the selected ship when the player flies on another team', () => {
    const human = team('team1', [64 / 255, 224 / 255, 208 / 255]);
    const alien = team('team2', [1, 0, 0]);
    const gi = instanceWith([human, alien], alien);
    applyTeamColors(gi, { playerColor: '#ffcc00', enemyColor: '#cc00ff' });
    expect(alien.color).toEqual([1, 0.8, 0]);
    expect(human.color).toEqual([0.8, 0, 1]);
  });

  it('uses team1 before a NetGame snapshot reveals the own ship', () => {
    const human = team('team1', [64 / 255, 224 / 255, 208 / 255]);
    const alien = team('team2', [1, 0, 0]);
    const gi = instanceWith([human, alien], null);
    applyTeamColors(gi, { playerColor: '#00ffff', enemyColor: '#ff00ff' });
    expect(human.color).toEqual([0, 1, 1]);
    expect(alien.color).toEqual([1, 0, 1]);
  });

  it('applies a per-team colour override (and falls back for the rest)', () => {
    const human = team('team1', [64 / 255, 224 / 255, 208 / 255]);
    const alien = team('team2', [1, 0, 0]);
    const falcon = team('falcon', [1, 0.78, 0.24]);
    const gi = instanceWith([human, alien, falcon], human);
    applyTeamColors(gi, {
      playerColor: '#00ff00', enemyColor: '#0000ff',
      teamColors: { team2: '#ff00ff' },
    });
    expect(alien.color).toEqual(hexToRgb('#ff00ff')); // explicit team 2
    expect(falcon.color).toEqual([0, 0, 1]);          // fallback enemy colour
    expect(human.color).toEqual([0, 1, 0]);           // player colour
  });

  it('lets an explicit team1 colour override the player colour', () => {
    const human = team('team1', [0, 0, 0]);
    const gi = instanceWith([human], human);
    applyTeamColors(gi, {
      playerColor: '#00ff00', enemyColor: '#0000ff',
      teamColors: { team1: '#ff00ff' },
    });
    expect(human.color).toEqual(hexToRgb('#ff00ff'));
  });

  it('keeps a party hue clear of the enemy colour', () => {
    const nearRed = hsvToRgb([0.02, 1, 1]);
    const out = avoidCloseHues(nearRed, [hexToRgb('#ff0000')]);
    expect(rgbToHsv(out)[0]).toBeGreaterThanOrEqual(0.08);
  });

  it('leaves a party hue that is already far from every team colour', () => {
    const blue = hsvToRgb([0.6, 1, 1]);
    expect(avoidCloseHues(blue, [hexToRgb('#ff0000')])).toEqual(blue);
  });

  it('ignores neutral (low-saturation) team colours', () => {
    const red = hexToRgb('#ff0000');
    expect(avoidCloseHues(red, [hexToRgb('#808080')])).toEqual(red);
  });
});
