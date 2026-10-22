// Per-level combatant roster.
//
// A level ships with its own AI ("bots") plus the player. This module exposes
// them as one editable list so the briefing can retag, rebrain, remove and add
// agents — the level's own bots and the added ones go through the same path in
// GameInstance.create.
//
// The rosters are kept per level key in a reactive map, so edits survive
// navigating away from the briefing and back.

import { reactive } from 'vue';
import { BOT_AIS } from './ai';
import type { LevelDef, LevelObjectJson } from './levels';

export type AgentRole = 'player' | 'bot';

export interface AgentConfig {
  /** Stable key: the level ship name, or a generated id for an added bot. */
  id: string;
  /** Display name (the level ship name, or `BOTn`). */
  name: string;
  role: AgentRole;
  /** Team id (team1..team4, or a level-specific team). */
  team: string;
  /** AI action id (see BOT_AIS); '' for a player. */
  ai: string;
  /** False = this agent is removed from the match. */
  enabled: boolean;
  /** True when the bot was added on the briefing instead of coming from the level. */
  added: boolean;
}

/** Default brain for a level ship that has no AI action of its own. */
export const DEFAULT_BOT_AI = 'AIGoRandomOffensive';

/** Every AI brain id a bot can be given (the menu cycle order). */
export const AGENT_AIS: readonly string[] = BOT_AIS.map((a) => a.id);

/** Build the roster a level starts with: its player(s) and every AI ship. */
export function defaultRoster(def: LevelDef): AgentConfig[] {
  const aiByShip = new Map<string, string>();
  const players = new Set<string>();
  for (const a of def.actions) {
    if (a.name === 'HILocal') players.add(a.from);
    else aiByShip.set(a.from, a.name);
  }
  const out: AgentConfig[] = [];
  const seen = new Set<string>();
  for (const o of def.objects) {
    if (!o.name || seen.has(o.name)) continue;
    if (o.type !== 'spaceShip' && o.type !== 'spaceShipRespawn') continue;
    seen.add(o.name);
    if (players.has(o.name)) {
      out.push({ id: o.name, name: o.name, role: 'player', team: o.team, ai: '', enabled: true, added: false });
    } else {
      out.push({
        id: o.name, name: o.name, role: 'bot', team: o.team,
        ai: aiByShip.get(o.name) ?? DEFAULT_BOT_AI, enabled: true, added: false,
      });
    }
  }
  return out;
}

/** Rosters per level key (reactive: the briefing repaints as they change). */
export const agentRosters = reactive<Record<string, AgentConfig[]>>({});

/** The roster for a level, seeded from the level on first use. */
export function rosterFor(levelKey: string, def: LevelDef): AgentConfig[] {
  const existing = agentRosters[levelKey];
  if (existing) return existing;
  const fresh = defaultRoster(def);
  agentRosters[levelKey] = fresh;
  return fresh;
}

/** Next free `BOTn` id/name in a roster. */
export function nextBotName(roster: readonly AgentConfig[]): string {
  const taken = new Set(roster.map((a) => a.id));
  let n = 1;
  while (taken.has('BOT' + n)) n++;
  return 'BOT' + n;
}

/** Cycle a value through a list (wrapping). */
export function cycle<T>(list: readonly T[], value: T): T {
  const i = list.indexOf(value);
  return list[(i + 1) % list.length];
}

/** True when a roster has any bot (level or added) that will field objects. */
export function hasEnabledBots(roster: readonly AgentConfig[]): boolean {
  return roster.some((a) => a.role === 'bot' && a.enabled);
}

/** What a roster turns a level into, before GameInstance builds anything. */
export interface AppliedRoster {
  /** Level objects, with enabled bots retagged and disabled ones dropped. */
  objects: LevelObjectJson[];
  /** Level bot configs by ship name (including disabled ones). */
  levelBots: Map<string, AgentConfig>;
  /** Enabled added bots to spawn (not part of the level). */
  added: AgentConfig[];
  /** Every team that fields objects (no `ambient`). */
  teams: string[];
}

/**
 * Resolve a roster against a level: drop removed bots, retag kept ones and
 * collect the added ones. Pure, so the briefing's edits can be unit-tested
 * without building a whole GameInstance.
 */
export function applyRoster(def: LevelDef, roster: readonly AgentConfig[]): AppliedRoster {
  const levelBots = new Map<string, AgentConfig>();
  const levelPlayers = new Map<string, AgentConfig>();
  const added: AgentConfig[] = [];
  for (const a of roster) {
    if (a.role === 'player') {
      levelPlayers.set(a.id, a);
      continue;
    }
    if (a.role !== 'bot') continue;
    if (a.added) {
      if (a.enabled) added.push(a);
    } else {
      levelBots.set(a.id, a);
    }
  }
  const objects = def.objects
    .map((o) => {
      const bot = o.name ? levelBots.get(o.name) : undefined;
      if (bot && !bot.enabled) return null;
      const player = o.name ? levelPlayers.get(o.name) : undefined;
      const team = bot ? bot.team : player ? player.team : o.team;
      return { ...o, team };
    })
    .filter((o): o is LevelObjectJson => o !== null);
  const teams = [...new Set([...objects.map((o) => o.team), ...added.map((b) => b.team)])]
    .filter((n) => n !== 'ambient');
  return { objects, levelBots, added, teams };
}
