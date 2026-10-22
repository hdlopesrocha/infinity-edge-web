// Radial team-base layout: combatant bases sit on a circle around the arena
// centre, evenly spaced in the plane perpendicular to world UP (+Y), in the
// stable TEAMS config order so the layout is deterministic.

/**
 * Base orbit radius as a fraction of the arena half-size. 0.37 keeps the bases
 * comfortably inside the arena (well clear of the border) while still leaving
 * the centre open for the fight.
 */
export const BASE_RADIUS_FRACTION = 0.37;

/**
 * Position of combatant base `index` (0-based, in stable team order) out of
 * `count` bases in an arena of the given `size`.
 *
 * Angle = index / count * 2π; the point lies in the ground plane (y = 0), which
 * is perpendicular to world UP (+Y). Two bases land on opposite sides, three
 * are 120° apart and four are 90° apart.
 */
export function radialBasePosition(
  index: number,
  count: number,
  size: number,
): [number, number, number] {
  const n = Math.max(1, count);
  const angle = (index / n) * Math.PI * 2;
  const radius = BASE_RADIUS_FRACTION * (size / 2);
  return [Math.cos(angle) * radius, 0, Math.sin(angle) * radius];
}
