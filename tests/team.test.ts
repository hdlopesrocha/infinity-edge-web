// CTF outcome conditions and the team display names.
import { describe, expect, it } from 'vitest';
import {
  CondDrawPoints, CondMorePoints, teamDisplayName, Team,
} from '../src/game/team';
import type { GameInstance } from '../src/game/instance';
import type { SpaceObject } from '../src/game/objects';

/** A team that fields one object (so it counts as a combatant). */
function combatant(name: string, points: number): Team {
  const t = new Team(name, [1, 1, 1]);
  t.points = points;
  t.objects.push({} as SpaceObject);
  return t;
}

function instanceWith(teams: Team[], selected: Team | null = null): GameInstance {
  return {
    teams: new Map(teams.map((t) => [t.name, t])),
    selectedObject: selected ? { team: selected } : null,
  } as unknown as GameInstance;
}

describe('CTF points conditions', () => {
  it('wins only with strictly more points than every other combatant', () => {
    const a = combatant('team1', 3);
    const b = combatant('team2', 2);
    const gi = instanceWith([a, b]);
    expect(new CondMorePoints('team1').check(gi)).toBe(true);
    expect(new CondMorePoints('team2').check(gi)).toBe(false);
  });

  it('is a draw when the lead is shared, not a defeat', () => {
    const a = combatant('team1', 3);
    const b = combatant('team2', 3);
    const gi = instanceWith([a, b]);
    expect(new CondMorePoints('team1').check(gi)).toBe(false);
    expect(new CondDrawPoints('team1').check(gi)).toBe(true);
    expect(new CondDrawPoints('team2').check(gi)).toBe(true);
  });

  it('is a draw at 0-0', () => {
    const a = combatant('team1', 0);
    const b = combatant('team2', 0);
    const gi = instanceWith([a, b]);
    expect(new CondMorePoints('team1').check(gi)).toBe(false);
    expect(new CondDrawPoints('team1').check(gi)).toBe(true);
  });

  it('is a loss when another combatant is ahead (no draw)', () => {
    const a = combatant('team1', 2);
    const b = combatant('team2', 4);
    const gi = instanceWith([a, b]);
    expect(new CondMorePoints('team1').check(gi)).toBe(false);
    expect(new CondDrawPoints('team1').check(gi)).toBe(false);
  });

  it('ignores the neutral ambient team and teams with no objects', () => {
    const a = combatant('team1', 0);
    const b = combatant('team2', 0);
    const ambient = new Team('ambient', [0, 1, 0]);
    ambient.objects.push({} as SpaceObject);
    const empty = new Team('team4', [1, 1, 1]);   // no objects
    const gi = instanceWith([a, b, ambient, empty]);
    // 0-0 between the two real teams is a draw: ambient and the empty team
    // must not turn it into a win for either side.
    expect(new CondMorePoints('team1').check(gi)).toBe(false);
    expect(new CondDrawPoints('team1').check(gi)).toBe(true);
  });

  it('supports up to four mutually hostile teams', () => {
    const a = combatant('team1', 5);
    const b = combatant('team2', 4);
    const c = combatant('team3', 4);
    const d = combatant('team4', 1);
    const gi = instanceWith([a, b, c, d]);
    expect(new CondMorePoints('team1').check(gi)).toBe(true);
    // b and c are tied behind the leader: neither wins nor draws the top.
    expect(new CondDrawPoints('team2').check(gi)).toBe(false);
    expect(new CondMorePoints('team2').check(gi)).toBe(false);
  });

  it("follows the player's own team, not a hard-coded team1", () => {
    const a = combatant('team1', 1);
    const b = combatant('team2', 2);
    // The player is on team2, but the level's goal names `team1` (the friendly
    // side by convention): the condition must judge the player's own team.
    const gi = instanceWith([a, b], b);
    expect(new CondMorePoints('team1').check(gi)).toBe(true);
    expect(new CondDrawPoints('team1').check(gi)).toBe(false);
    // And a player losing on team2 gets no victory.
    const lost = instanceWith([combatant('team1', 3), combatant('team2', 1)], combatant('team2', 1));
    expect(new CondMorePoints('team1').check(lost)).toBe(false);
  });
  it('raises each queued line for its own team', () => {
    const a = combatant('team1', 0);
    const b = combatant('team2', 0);
    a.sounds.push('ourTeamHasTheFlag');
    b.sounds.push('ourFlagWasStolen');
    const seen: [string, string][] = [];
    const gi = {
      teamVoice: (t: Team, f: string) => seen.push([t.name, f]),
    } as unknown as GameInstance;
    a.manage(gi);
    b.manage(gi);
    expect(seen).toEqual([['team1', 'ourTeamHasTheFlag'], ['team2', 'ourFlagWasStolen']]);
    expect(a.sounds).toHaveLength(0);
    expect(b.sounds).toHaveLength(0);
  });
});

describe('team display names', () => {
  it('labels the four teams as Team 1..4', () => {
    expect(teamDisplayName('team1')).toBe('Team 1');
    expect(teamDisplayName('team4')).toBe('Team 4');
  });

  it('capitalises the free-for-all competitor names', () => {
    expect(teamDisplayName('falcon')).toBe('Falcon');
    expect(teamDisplayName('ambient')).toBe('Ambient');
  });
});
