// Party mode: turn the music's rhythm into a hue offset. The AudioManager
// analyses the WebAudio music graph; this module detects bass onsets and
// smooths the hue so the player, asteroids, bullets, ship tint, sky and player
// smoke all move together without a visual snap on every beat. The player hull
// additionally flashes brighter/more saturated on each bass hit, so the bass
// line reads clearly even when the hue step alone is subtle.

import { audio } from './audio';
import type { MusicLevels } from './audio';
import { hexToRgb, hsvToRgb, hueShiftRgb, rgbToHsv } from './colors';
import type { Rgb } from './colors';
import type { Options } from './resources';

export interface PartyState {
  /** True while the party option is on (whether or not music is audible). */
  active: boolean;
  /** Target hue rotation in turns, advanced on every bass onset. */
  hue: number;
  /** Smoothed hue the renderer actually uses. */
  shownHue: number;
  /** Beat envelope for the sky, 1 on a bass onset and decaying afterwards. */
  pulse: number;
  /** Current music energy, 0..1. */
  energy: number;
  /** Running overall-energy average (diagnostics / future detectors). */
  average: number;
  /** Current bass-band energy, 0..1. */
  bass: number;
  /** Bass energy change since the previous frame. */
  bassRise: number;
  /** Running bass average (diagnostics / level display). */
  bassAverage: number;
  /** Bass envelope: the onset amplitude, decaying afterwards. */
  bassPulse: number;
  lastBeat: number;
  clock: number;
}

export const party: PartyState = {
  active: false,
  hue: 0,
  shownHue: 0,
  pulse: 0,
  energy: 0,
  average: 0,
  bass: 0,
  bassRise: 0,
  bassAverage: 0,
  bassPulse: 0,
  lastBeat: -Infinity,
  clock: 0,
};

const FALLBACK_PLAYER: Rgb = [64 / 255, 224 / 255, 208 / 255];

// ---- Bass response tuning -------------------------------------------------
// Every value here is deliberately larger than the first pass of the effect so
// the low end reads clearly: the player hull turns further per kick and flashes
// harder, and the sky both sways through more hue and brightens with the bass.
// The player hue is still advanced through the smoothed `shownHue`, so none of
// this snaps — a kick looks like a sweep, not a cut.

/** Hue step added to the player hue target on a bass onset, in turns. */
export const PARTY_BEAT_HUE_BASE = 0.09;
/** Extra hue step per unit of bass amplitude+envelope, in turns (0.46 ≈ 166°). */
export const PARTY_BEAT_HUE_BASS = 0.46;
/** Saturation added to the player colour at a full-strength bass hit. */
export const PARTY_HIT_SATURATION = 0.40;
/** Value (brightness) added to the player colour at a full-strength bass hit. */
export const PARTY_HIT_VALUE = 0.26;
/** Allowed hue swing of the sky from the smoothed beat hue, in degrees. */
export const PARTY_SKY_HUE_DEG = 26;
/** Extra sky hue swing from the bass onset envelope, in degrees. */
export const PARTY_SKY_HUE_KICK_DEG = 12;
/** Sky brightness gain from overall music energy. */
export const PARTY_SKY_VALUE_ENERGY = 0.30;
/** Sky brightness gain from the bass band/envelope. */
export const PARTY_SKY_VALUE_BASS = 0.55;
/** Sky contrast gain from overall music energy. */
export const PARTY_SKY_CONTRAST_ENERGY = 0.45;
/** Sky contrast gain from the beat pulse on each bass hit. */
export const PARTY_SKY_CONTRAST_PULSE = 0.20;
/** Sky contrast gain from the bass band/envelope. */
export const PARTY_SKY_CONTRAST_BASS = 0.15;

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

export function resetParty(state: PartyState = party): void {
  state.active = false;
  state.hue = 0;
  state.shownHue = 0;
  state.pulse = 0;
  state.energy = 0;
  state.average = 0;
  state.bass = 0;
  state.bassRise = 0;
  state.bassAverage = 0;
  state.bassPulse = 0;
  state.lastBeat = -Infinity;
  state.clock = 0;
}

/**
 * Advance the beat tracker for one frame. Pure so the detector can be tested
 * with synthetic energy envelopes instead of an AudioContext.
 */
export function applyMusicFrame(state: PartyState, levels: MusicLevels, dtMs: number): void {
  const dt = Math.max(0, Math.min(100, Number.isFinite(dtMs) ? dtMs : 16.7));
  state.active = true;
  state.clock += dt;
  state.energy = clamp01(levels.energy);
  const bass = clamp01(levels.bass);
  // The hue follows the *rise* in bass energy, not the absolute amount: a
  // track with a constantly loud low end still changes colour on each new bass
  // note, while a hi-hat or lead-synth transient has no bass rise at all.
  state.bassRise = bass - state.bass;
  state.bass = bass;
  state.average += (state.energy - state.average) * (1 - Math.exp(-dt / 180));
  state.bassAverage += (state.bass - state.bassAverage) * (1 - Math.exp(-dt / 160));
  const beat =
    state.bass > 0.06 &&
    state.bassRise > 0.05 &&
    state.clock - state.lastBeat > 140;
  if (beat) {
    state.lastBeat = state.clock;
    // The onset envelope rides the raw bass amplitude, so a deep kick turns the
    // player further than a quiet note. Both the amplitude and the envelope feed
    // the step, and `shownHue` below smooths it into a sweep instead of a snap.
    state.bassPulse = clamp01(state.bass);
    const hit = clamp01(state.bass * 0.5 + state.bassPulse * 0.5);
    state.hue = (state.hue + PARTY_BEAT_HUE_BASE + hit * PARTY_BEAT_HUE_BASS) % 1;
    state.pulse = 1;
  } else {
    state.pulse *= Math.exp(-dt / 160);
    state.bassPulse *= Math.exp(-dt / 110);
  }
  // The visual hue follows the beat target quickly but not instantly; this is
  // what makes a kick drum look like a sweep instead of a hard cut.
  let delta = state.hue - state.shownHue;
  if (delta > 0.5) delta -= 1;
  else if (delta < -0.5) delta += 1;
  const k = 1 - Math.exp(-dt / 90);
  state.shownHue = ((state.shownHue + delta * k) % 1 + 1) % 1;
}

/** Called once per rendered frame from the page and XR loops. */
export function updateParty(options: Pick<Options, 'partyMode'>, dtMs: number): void {
  if (!options.partyMode) {
    resetParty();
    return;
  }
  applyMusicFrame(party, audio.musicLevels(), dtMs);
}

/** The player colour with the current party hue applied. Enemy colours bypass it. */
export function partyPlayerColor(
  options: Pick<Options, 'partyMode' | 'playerColor'>,
): Rgb {
  const base = hexToRgb(options.playerColor, FALLBACK_PLAYER);
  if (!options.partyMode || !party.active) return base;
  const hsv = rgbToHsv(base);
  hsv[0] = ((hsv[0] + party.shownHue) % 1 + 1) % 1;
  // The bass hit also lifts saturation and brightness briefly. The flash is
  // scaled by both the bass amplitude and the decaying onset envelope, so a
  // deep drop flashes much harder than a quiet note, while the scaling keeps it
  // visible for neutral player colours where the hue rotation alone is subtle.
  const flash = clamp01(party.bassPulse * (0.7 + 0.5 * clamp01(party.bass)));
  hsv[1] = Math.min(1, hsv[1] + flash * PARTY_HIT_SATURATION);
  hsv[2] = Math.min(1, hsv[2] + flash * PARTY_HIT_VALUE);
  return hsvToRgb(hsv);
}

/** Rotate a fixed effect colour (bullets, asteroid hue) with the music. */
export function partyShiftColor(color: Rgb): Rgb {
  return party.active ? hueShiftRgb(color, party.shownHue) : ([...color] as Rgb);
}

/**
 * Sky hue offset in degrees. A pure rotation of the level's own sky hue: it
 * never references a team colour, so the dome can never be tinted toward the
 * player or an enemy. Two layers move together: a wide sway from the smoothed
 * beat hue and an extra kick from the bass onset envelope.
 */
export function partySkyHue(): number {
  if (!party.active) return 0;
  const sway = Math.sin(party.shownHue * Math.PI * 2) * PARTY_SKY_HUE_DEG;
  const kick = Math.sin(clamp01(party.bassPulse) * Math.PI * 0.5) * PARTY_SKY_HUE_KICK_DEG;
  return sway + kick;
}

/** The stronger of the current bass band and the decaying onset envelope. */
function bassLevel(): number {
  return clamp01(Math.max(party.bass, party.bassPulse));
}

/**
 * Apply the party response to a level's sky HSB. Only the hue is rotated, and
 * only by the level's own hue offset (never a team colour); brightness and
 * contrast carry the energy/bass so the dome brightens on the low end. Returns
 * a fresh triple, leaving the instance's stored skyHsb untouched.
 */
export function partySkyHsb(hsb: readonly [number, number, number]): [number, number, number] {
  if (!party.active) return [hsb[0], hsb[1], hsb[2]];
  const brightness =
    1 + party.energy * PARTY_SKY_VALUE_ENERGY + bassLevel() * PARTY_SKY_VALUE_BASS;
  return [
    hsb[0] + partySkyHue(),
    hsb[1],
    Math.min(1.6, hsb[2] * brightness),
  ];
}

/** Sky contrast multiplier: energy and every bass hit push it up. */
export function partySkyContrast(): number {
  if (!party.active) return 1;
  return 1 +
    party.energy * PARTY_SKY_CONTRAST_ENERGY +
    party.pulse * PARTY_SKY_CONTRAST_PULSE +
    bassLevel() * PARTY_SKY_CONTRAST_BASS;
}
