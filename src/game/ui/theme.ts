// Shared WebGL-menu accent derived from the player's chosen colour.
//
// The old chrome hard-coded the original teal everywhere, so choosing a
// different player colour only changed the ships and the focus frame. Every
// button, input, action and HUD timer now reads this live value instead.

import { DEFAULT_PLAYER_COLOR, hexToRgb, hsvToRgb, rgbToHsv } from '../colors';
import type { Rgb } from '../colors';
import { partyPlayerColor } from '../party';
import { store } from '../store';

const FALLBACK: Rgb = [64 / 255, 224 / 255, 208 / 255];

/** The player colour currently selected in Options, including the live party
 *  hue/flash when Party Mode is active. */
export function currentPlayerAccent(): Rgb {
  return partyPlayerColor(store.options);
}

/** True when the live accent has moved enough to be worth repainting. */
export function accentMoved(a: Rgb, b: Rgb, epsilon = 0.02): boolean {
  return Math.abs(a[0] - b[0]) > epsilon
    || Math.abs(a[1] - b[1]) > epsilon
    || Math.abs(a[2] - b[2]) > epsilon;
}

/** CSS rgb()/rgba() with rounded channels, matching the HUD painter. */
export function cssColor(color: readonly [number, number, number], alpha = 1): string {
  const r = (color[0] * 255) | 0;
  const g = (color[1] * 255) | 0;
  const b = (color[2] * 255) | 0;
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

/** Accent variant for text and 1 px lines on the dark chrome. Very dark
 *  player colours are lifted in value only (hue/saturation stay selected), so
 *  black/navy still produces legible controls instead of invisible labels. */
export function readableAccent(color: Rgb): Rgb {
  const hsv = rgbToHsv(color);
  if (hsv[2] < 0.62) hsv[2] = 0.62;
  return hsvToRgb(hsv);
}

/** Text-safe current accent. */
export function currentAccentText(): Rgb {
  return readableAccent(currentPlayerAccent());
}

/** Fallback swatch used by boot screens before the options load. */
export function defaultAccent(): Rgb {
  return hexToRgb(DEFAULT_PLAYER_COLOR, FALLBACK);
}
