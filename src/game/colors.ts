// Player/enemy colour preferences: parsing, the WebGL menu palette, and the
// live recolour of a match's teams. Colours are stored in options as #rrggbb;
// the renderer and simulation keep the engine's linear 0..1 triples.

import type { GameInstance } from './instance';
import type { Options } from './resources';

export type Rgb = [number, number, number];

/** The original human and alien team colours. */
export const DEFAULT_PLAYER_COLOR = '#40e0d0';
export const DEFAULT_ENEMY_COLOR = '#ff0000';

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
 * Recolour every combatant team for the player's view. The team flown by the
 * selected ship is the player colour; all other combatants are the enemy
 * colour. The neutral `ambient` team keeps its green so scenery stays distinct.
 *
 * This runs every frame because options apply live and NetGame learns the
 * player's own team only after its first snapshot.
 */
export function applyTeamColors(
  instance: Pick<GameInstance, 'teams' | 'selectedObject'> | null,
  options: Pick<Options, 'playerColor' | 'enemyColor'>,
): void {
  if (!instance) return;
  const player =
    instance.selectedObject?.team ??
    instance.teams.get('human') ??
    null;
  if (!player) return;
  const playerRgb = hexToRgb(options.playerColor, FALLBACK_PLAYER);
  const enemyRgb = hexToRgb(options.enemyColor, FALLBACK_ENEMY);
  for (const team of instance.teams.values()) {
    if (team.name === 'ambient') continue;
    const target = team === player ? playerRgb : enemyRgb;
    if (
      team.color[0] !== target[0] ||
      team.color[1] !== target[1] ||
      team.color[2] !== target[2]
    ) {
      team.color = [target[0], target[1], target[2]];
    }
  }
}
