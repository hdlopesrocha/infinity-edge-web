// Team / Score / GameScore (ToVisual + ToVisualIngame) / Reward / Conditions.

import type { GameInstance } from './instance';
import type { SpaceObject } from './objects';

export class Team {
  points = 0;
  timeMs = 0;
  name: string;
  color: [number, number, number];
  base: import('./objects').Base | null = null;
  flag: import('./objects').Flag | null = null;
  objects: SpaceObject[] = [];
  sounds: string[] = [];
  allies: Team[] = [];
  enemys: Team[] = [];

  constructor(name: string, color: [number, number, number]) {
    this.name = name;
    this.color = color;
    this.allies.push(this);
  }

  manage(gi: GameInstance, controlled: SpaceObject | null): void {
    if (controlled && this === controlled.team) {
      while (this.sounds.length > 0) {
        gi.setNotification(this.sounds.shift()!);
      }
    }
    this.sounds.length = 0;
  }
}

export interface ScoreEntry {
  name: string;
  points: number;
  timeMs: number;
  control: boolean;
}

export class GameScore {
  scores: ScoreEntry[] = [];

  constructor(scores: ScoreEntry[] = []) {
    this.scores = scores;
  }

  hashCode(type: 'CTF' | 'TT'): number {
    if (type === 'CTF') {
      let total = 0;
      for (const s of this.scores) total += s.control ? -s.points : s.points;
      return total;
    }
    let total = 0;
    for (const s of this.scores) total = Math.max(total, s.timeMs + 1);
    return total;
  }

  /** Briefing list (name + time, first control only). */
  toVisual(type: string): string {
    if (type === 'CTF') {
      let ret = '';
      for (const s of this.scores) if (s.control) ret = String(s.points) + ret;
      for (const s of this.scores) if (!s.control) ret = ret + ' : ' + s.points;
      return ret;
    }
    let ret = '';
    for (const s of this.scores) {
      if (s.control) {
        ret = s.name + ' - ' + fmtTime(s.timeMs);
        break;
      }
    }
    return ret;
  }

  /** In-game scoreboard (time only, first control only). */
  toVisualIngame(type: string): string {
    if (type === 'CTF') {
      let ret = '';
      for (const s of this.scores) if (s.control) ret = String(s.points) + ret;
      for (const s of this.scores) if (!s.control) ret = ret + ' : ' + s.points;
      return ret;
    }
    let ret = '';
    for (const s of this.scores) {
      if (s.control) {
        ret = fmtTime(s.timeMs);
        break;
      }
    }
    return ret;
  }
}

function fmtTime(timeMs: number): string {
  const ms = Math.floor(timeMs);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const mmm = ms % 1000;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return (h !== 0 ? p2(h) + ':' : '') + p2(m) + ':' + p2(sec) + '.' + String(mmm).padStart(3, '0');
}

export type RewardType = 'Gold' | 'Silver' | 'Bronze' | 'Victory' | 'Defeat' | 'None';

export abstract class Condition {
  abstract check(gi: GameInstance): boolean;
}

export class CondDestroyed extends Condition {
  constructor(private obj: SpaceObject | null) {
    super();
  }

  check(_gi: GameInstance): boolean {
    return !!this.obj && !this.obj.active;
  }
}

export class CondMoreTime extends Condition {
  constructor(private timeMs: number) {
    super();
  }

  check(gi: GameInstance): boolean {
    return !!gi.selectedObject && gi.selectedObject.team.timeMs >= this.timeMs;
  }
}

export class CondLessTime extends Condition {
  constructor(private timeMs: number) {
    super();
  }

  check(gi: GameInstance): boolean {
    return !!gi.selectedObject && gi.selectedObject.team.timeMs <= this.timeMs;
  }
}

export class CondMorePoints extends Condition {
  constructor(private team: Team) {
    super();
  }

  check(gi: GameInstance): boolean {
    let min = 99999;
    for (const t of gi.teams.values()) min = Math.min(min, t.points);
    return this.team.points > min;
  }
}

export class CondNoPath extends Condition {
  check(gi: GameInstance): boolean {
    return gi.map.path.length === 0;
  }
}

export class Reward {
  conditions: Condition[] = [];

  constructor(
    public reward: RewardType,
    public message: string | null,
  ) {}

  addCondition(c: Condition): void {
    this.conditions.push(c);
  }

  check(gi: GameInstance): boolean {
    if (this.conditions.length === 0) return false;
    for (const c of this.conditions) {
      if (!c.check(gi)) return false;
    }
    return true;
  }
}

export function parseTimeSpan(s: string): number {
  const parts = s.split(':').map(Number);
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  return parts[0] * 1000;
}

export function timeSpanToString(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const d = Math.floor(total / 86400000);
  const h = Math.floor((total % 86400000) / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const mmm = total % 1000;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return (d > 0 ? d + '.' : '') + p2(h) + ':' + p2(m) + ':' + p2(s) + (mmm ? '.' + String(mmm).padStart(3, '0') : '');
}

export function parseTimeSpanFull(s: string): number {
  let rest = s;
  let days = 0;
  const dot = rest.indexOf('.');
  const colon = rest.indexOf(':');
  if (dot >= 0 && (colon < 0 || dot < colon)) {
    days = parseInt(rest.slice(0, dot), 10) || 0;
    rest = rest.slice(dot + 1);
  }
  const parts = rest.split(':');
  let ms = 0;
  if (parts.length === 3) {
    const secParts = parts[2].split('.');
    ms = ((parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10)) * 60 + parseInt(secParts[0], 10)) * 1000;
    if (secParts[1]) ms += parseInt(secParts[1].padEnd(3, '0').slice(0, 3), 10);
  } else if (parts.length === 2) {
    ms = (parseInt(parts[0], 10) * 60 + parseFloat(parts[1])) * 1000;
  }
  return days * 86400000 + ms;
}
