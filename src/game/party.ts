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
    // A bass onset turns the player much further than the old mixed-energy
    // detector did: roughly 22-130 degrees, scaled by how hard the bass hit.
    state.hue = (state.hue + 0.06 + state.bass * 0.30) % 1;
    state.pulse = 1;
    state.bassPulse = state.bass;
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
  // The bass hit also lifts saturation and brightness briefly. Scaling by the
  // bass amplitude makes a deep drop flash harder than a quiet bass note, and
  // keeps the effect visible for neutral player colours where hue alone is
  // almost invisible.
  const flash = party.bassPulse;
  hsv[1] = Math.min(1, hsv[1] + flash * 0.22);
  hsv[2] = Math.min(1, hsv[2] + flash * 0.14);
  return hsvToRgb(hsv);
}

/** Rotate a fixed effect colour (bullets, asteroid hue) with the music. */
export function partyShiftColor(color: Rgb): Rgb {
  return party.active ? hueShiftRgb(color, party.shownHue) : ([...color] as Rgb);
}

/** Sky hue offset in degrees: deliberately small so the level stays readable. */
export function partySkyHue(): number {
  return party.active ? Math.sin(party.shownHue * Math.PI * 2) * 10 : 0;
}

/** Sky contrast multiplier: the one sky property allowed to move strongly. */
export function partySkyContrast(): number {
  return party.active ? 1 + party.energy * 0.35 + party.pulse * 0.08 : 1;
}
