// Player/enemy colour preferences: parsing, the WebGL menu palette, and the
// live recolour of a match's teams. Colours are stored in options as #rrggbb;
// the renderer and simulation keep the engine's linear 0..1 triples.

import type { GameInstance } from './instance';
import type { Options } from './resources';

export type Rgb = [number, number, number];
/** Hue 0..1, saturation 0..1, value 0..1. */
export type Hsv = [number, number, number];

/** The original player and enemy team colours. */
export const DEFAULT_PLAYER_COLOR = '#40e0d0';
export const DEFAULT_ENEMY_COLOR = '#ff0000';

/**
 * Default colours of the four combatant teams, in `teamN` order (matches the
 * game's `TEAMS` config). Team 1 is the player's own team; the rest are the
 * other teams. These are the values the settings screen offers.
 */
export const TEAM_DEFAULT_COLORS: readonly string[] = [
  DEFAULT_PLAYER_COLOR, DEFAULT_ENEMY_COLOR, '#4dd9ff', '#ff8ce6',
];

/** Default colour of a `teamN` id (falls back to the enemy colour). */
export function teamDefaultColor(name: string): string {
  const m = /^team(\d+)$/.exec(name);
  const i = m ? Number(m[1]) - 1 : -1;
  return TEAM_DEFAULT_COLORS[i] ?? DEFAULT_ENEMY_COLOR;
}

const FALLBACK_PLAYER: Rgb = [64 / 255, 224 / 255, 208 / 255];
const FALLBACK_ENEMY: Rgb = [1, 0, 0];

/**
 * Swatches offered by the WebGL options colour picker. 6x6: neutrals, the
 * original team colours, saturated primaries and lighter/darker variants.
 */
export const COLOR_PALETTE: readonly string[] = [
  '#ffffff', '#d9d9d9', '#a6a6a6', '#737373', '#404040', '#000000',
  '#ff0000', '#ff8000', '#ffd000', '#bfff00', '#40ff40', '#40e0d0',
  '#00ffff', '#008cff', '#0000ff', '#8000ff', '#ff00ff', '#ff0080',
  '#ff6666', '#ffb366', '#ffff66', '#b3ff66', '#66ffb3', '#66ffff',
  '#66b3ff', '#6666ff', '#b366ff', '#ff66ff', '#ff66b3', '#c0c0c0',
  '#800000', '#804000', '#808000', '#408000', '#008040', '#004080',
];

/** Normalise a user/XML colour to #rrggbb; invalid values return the fallback. */
export function normalizeHexColor(
  value: unknown,
  fallback = DEFAULT_PLAYER_COLOR,
): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value ?? '').trim());
  if (match) return '#' + match[1].toLowerCase();
  return fallback;
}

/** Convert #rrggbb to a 0..1 RGB triple. Invalid values use `fallback`. */
export function hexToRgb(value: string, fallback: Rgb = [1, 1, 1]): Rgb {
  const hex = normalizeHexColor(value, '');
  if (!hex) return [...fallback];
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

/** Convert a 0..1 RGB triple to #rrggbb (for pickers and saved options). */
export function rgbToHex(color: Rgb): string {
  const channel = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
  return '#' + channel(color[0]) + channel(color[1]) + channel(color[2]);
}

/**
 * The UI colour of a combatant team, matching what a match renders: an explicit
 * per-team colour (`options.teamColors[name]`) wins, otherwise the player's
 * team uses `playerColor` and every other team the `enemyColor`. Used by the
 * roster/room lists to tint a player's name and team picker.
 */
export function teamColor(
  name: string,
  options: Pick<Options, 'playerColor' | 'enemyColor'> & { teamColors?: Record<string, string> },
): Rgb {
  const hex = options.teamColors?.[name];
  if (hex) return hexToRgb(hex, FALLBACK_ENEMY);
  if (name === 'team1') return hexToRgb(options.playerColor, FALLBACK_PLAYER);
  return hexToRgb(teamDefaultColor(name), FALLBACK_ENEMY);
}

/** Convert a 0..1 RGB triple to hue/saturation/value (all 0..1). */
export function rgbToHsv(color: Rgb): Hsv {
  const [r, g, b] = color;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-8) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max > 0 ? d / max : 0, max];
}

/** Convert hue/saturation/value (all 0..1) back to a 0..1 RGB triple. */
export function hsvToRgb(hsv: Hsv): Rgb {
  const h = ((hsv[0] % 1) + 1) % 1;
  const s = Math.max(0, Math.min(1, hsv[1]));
  const v = Math.max(0, Math.min(1, hsv[2]));
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

/** Rotate a colour's hue by `turns` (1 = a full colour wheel). */
export function hueShiftRgb(color: Rgb, turns: number): Rgb {
  const hsv = rgbToHsv(color);
  hsv[0] = ((hsv[0] + turns) % 1 + 1) % 1;
  return hsvToRgb(hsv);
}

/**
 * Keep a colour's hue clear of a set of "team" colours by at least
 * `minSeparation` turns. Party mode rotates the player hue on every beat; if
 * the rotation lands on a hue close to an enemy team the two become
 * indistinguishable, so the hue is pushed out to the nearest edge of the
 * forbidden arc. Neutral/low-saturation avoid colours have no meaningful hue
 * and are skipped.
 */
export function avoidCloseHues(color: Rgb, avoid: readonly Rgb[], minSeparation = 0.09): Rgb {
  const hsv = rgbToHsv(color);
  if (hsv[1] < 0.15) return [...color] as Rgb;
  const forbidden: number[] = [];
  for (const a of avoid) {
    const ah = rgbToHsv(a);
    if (ah[1] < 0.25) continue;
    forbidden.push(ah[0]);
  }
  if (forbidden.length === 0) return [...color] as Rgb;
  let h = hsv[0];
  for (let iter = 0; iter < 6; iter++) {
    let changed = false;
    for (const f of forbidden) {
      let diff = h - f;
      diff -= Math.round(diff);            // wrap to [-0.5, 0.5]
      if (Math.abs(diff) < minSeparation) {
        h = f + (diff >= 0 ? 1 : -1) * minSeparation;
        changed = true;
      }
    }
    if (!changed) break;
  }
  hsv[0] = ((h % 1) + 1) % 1;
  return hsvToRgb(hsv);
}

/**
 * Recolour every combatant team for the player's view. A team with an explicit
 * per-team colour (`options.teamColors[name]`) uses it; otherwise the player's
 * team uses `playerColor` and every other combatant the `enemyColor`. The
 * neutral `ambient` team keeps its green so scenery stays distinct.
 *
 * This runs every frame because options apply live and NetGame learns the
 * player's own team only after its first snapshot.
 */
export function applyTeamColors(
  instance: Pick<GameInstance, 'teams' | 'selectedObject'> | null,
  options: Pick<Options, 'playerColor' | 'enemyColor'> & {
    partyMode?: boolean;
    teamColors?: Record<string, string>;
  },
  /** Party mode rotates the player hue every beat without touching enemies. */
  playerOverride?: Rgb | null,
): void {
  if (!instance) return;
  const player =
    instance.selectedObject?.team ??
    instance.teams.get('team1') ??
    null;
  if (!player) return;
  const enemyRgb = hexToRgb(options.enemyColor, FALLBACK_ENEMY);
  const explicit = (name: string): Rgb | null => {
    const hex = options.teamColors?.[name];
    return hex ? hexToRgb(hex, FALLBACK_ENEMY) : null;
  };
  let playerRgb = playerOverride
    ? ([...playerOverride] as Rgb)
    : hexToRgb(options.playerColor, FALLBACK_PLAYER);
  const party = !!options.partyMode && !!playerOverride;
  if (!party && explicit(player.name)) playerRgb = explicit(player.name)!;
  // Party mode: the rotating player hue must not land on a team colour, or
  // friend and foe read the same. Push it clear of every other team.
  if (party) {
    const avoid: Rgb[] = [enemyRgb];
    for (const team of instance.teams.values()) {
      if (team.name === 'ambient' || team === player) continue;
      avoid.push(explicit(team.name) ?? [team.color[0], team.color[1], team.color[2]]);
    }
    playerRgb = avoidCloseHues(playerRgb, avoid);
  }
  for (const team of instance.teams.values()) {
    if (team.name === 'ambient') continue;
    // The live party colour owns the player's own team; otherwise an explicit
    // per-team colour wins, then the player/enemy fallback.
    const target = team === player
      ? playerRgb
      : (explicit(team.name) ?? enemyRgb);
    if (
      team.color[0] !== target[0] ||
      team.color[1] !== target[1] ||
      team.color[2] !== target[2]
    ) {
      team.color = [target[0], target[1], target[2]];
    }
  }
}
