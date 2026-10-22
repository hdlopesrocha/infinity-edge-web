// Aimbot presets: the player's auto-aim tuning, pickable in the HANGAR.
//
// The assist only engages while the player is barely steering (the analog stick
// magnitude is at or below `aimbotThreshold`), so it helps fine aim instead of
// flying the ship. Three presets of increasing difficulty: the easiest (widest
// cone, longest range, most forgiving stick gate, strongest thrust assist) is
// the default. AI ships never read these — only the ship HILocal drives is
// retuned (see ai.ts).

/** One aimbot tuning: acquisition geometry + the thrust floor used while steering. */
export interface AimbotPreset {
  /** Stable id persisted in Options (`_aimbot`). */
  id: string;
  /** Menu label. */
  label: string;
  /**
   * Minimum dot(dir, toTarget) alignment needed to acquire a target. Smaller is
   * a wider cone, so the easiest preset has the *smallest* angle.
   */
  aimbotAngle: number;
  /** Maximum target distance, in world units. */
  aimbotDistance: number;
  /** Engage only when the analog stick magnitude is <= this. */
  aimbotThreshold: number;
  /** Minimum thrust factor while the aimbot steers (higher = stronger). */
  assist: number;
}

/** Easiest first, hardest last. */
export const AIMBOT_PRESETS: readonly AimbotPreset[] = [
  { id: 'rookie', label: 'Rookie', aimbotAngle: 0.7, aimbotDistance: 192, aimbotThreshold: 0.55, assist: 0.9 },
  { id: 'pilot', label: 'Pilot', aimbotAngle: 0.85, aimbotDistance: 144, aimbotThreshold: 0.35, assist: 0.7 },
  { id: 'ace', label: 'Ace', aimbotAngle: 0.95, aimbotDistance: 96, aimbotThreshold: 0.15, assist: 0.5 },
];

/**
 * Shop presets: strictly stronger than *every* free preset (wider aim cone,
 * longer range, a more forgiving stick gate and a stronger thrust assist), so
 * owning one is a real upgrade. They are locked until the matching SHOP item
 * is owned (see game/shop.ts); the HANGAR picker refuses to select a locked id.
 */
export const SHOP_AIMBOT_PRESETS: readonly AimbotPreset[] = [
  { id: 'sniper', label: 'Sniper', aimbotAngle: 0.6, aimbotDistance: 224, aimbotThreshold: 0.65, assist: 0.95 },
  { id: 'oracle', label: 'Oracle', aimbotAngle: 0.5, aimbotDistance: 256, aimbotThreshold: 0.75, assist: 1.0 },
  { id: 'deadeye', label: 'Deadeye', aimbotAngle: 0.4, aimbotDistance: 288, aimbotThreshold: 0.85, assist: 1.1 },
];

/** Every preset, free first, then the (locked) shop ones. */
export const ALL_AIMBOT_PRESETS: readonly AimbotPreset[] = [
  ...AIMBOT_PRESETS,
  ...SHOP_AIMBOT_PRESETS,
];

/** The easiest preset: the default for new players and unknown stored ids. */
export const DEFAULT_AIMBOT_ID = AIMBOT_PRESETS[0].id;

/** True when the id belongs to a (locked) shop preset. */
export function isShopAimbot(id: string | null | undefined): boolean {
  return !!id && SHOP_AIMBOT_PRESETS.some((p) => p.id === id);
}

/** Resolve an option / stored value to a preset, falling back to the default. */
export function resolveAimbot(id: string | null | undefined): AimbotPreset {
  return ALL_AIMBOT_PRESETS.find((p) => p.id === id) ?? AIMBOT_PRESETS[0];
}

/** True when the aimbot may engage: the player is barely steering. */
export function aimbotEngages(stickLen: number, threshold: number): boolean {
  return stickLen <= threshold;
}

/** The thrust factor the aimbot uses while steering (never below the preset floor). */
export function aimbotAssist(preset: AimbotPreset, analogAcel: number): number {
  return Math.max(preset.assist, analogAcel);
}

/** A ship whose auto-aim tuning can be set from a preset. */
export interface AimbotCarrier {
  aimbotAngle: number;
  aimbotDistance: number;
  aimbotThreshold: number;
}

/** Copy a preset's tuning onto a ship (callers check `isPlayer` first). */
export function applyAimbotPreset(ship: AimbotCarrier, preset: AimbotPreset): void {
  ship.aimbotAngle = preset.aimbotAngle;
  ship.aimbotDistance = preset.aimbotDistance;
  ship.aimbotThreshold = preset.aimbotThreshold;
}
