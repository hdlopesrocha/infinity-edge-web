// DOM HUD marker styling. The source PNGs are white/near-white art, so the
// DOM overlay paints each icon as a CSS mask filled with the marker's live
// team colour. That matches the GL/XR HUD (which tints its canvas copies) and
// keeps custom player/enemy colours working for both friend and enemy icons.

import type { HudPointer } from './store';
import { iconBorderDataUrl } from './iconborder';

type Marker = Pick<HudPointer, 'x' | 'y' | 'w' | 'h' | 'iconUrl' | 'over' | 'color'> & {
  enemy?: boolean;
};

export interface MarkerIcon {
  url: string;
  w: number;
  h: number;
}

/** The icon a marker draws: `_over.png` (48x48) for on-screen ships, the
 *  object's own icon otherwise. Null when the marker has no icon at all. */
export function markerIcon(
  m: Pick<Marker, 'over' | 'iconUrl' | 'w' | 'h'>,
  overUrl: string,
): MarkerIcon | null {
  if (m.over) return { url: overUrl, w: 48, h: 48 };
  if (!m.iconUrl) return null;
  return { url: m.iconUrl, w: m.w, h: m.h };
}

/** 0..1 RGB triple to CSS rgb(), rounded like the GL HUD does. */
export function markerColor(color: readonly [number, number, number]): string {
  return `rgb(${(color[0] * 255) | 0},${(color[1] * 255) | 0},${(color[2] * 255) | 0})`;
}

/** Complement of a team colour. Enemy markers use this as an inset border so
 *  they stay identifiable whatever player/enemy colours are selected. */
export function oppositeColor(
  color: readonly [number, number, number],
): [number, number, number] {
  return [1 - color[0], 1 - color[1], 1 - color[2]];
}

/** Quote an asset URL for CSS `url()`. Backslashes and quotes are escaped so
 *  data URLs or paths with spaces cannot break the declaration list. */
export function cssUrl(url: string): string {
  const escaped = url
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\a ')
    .replace(/\r/g, '\\d ')
    .replace(/\f/g, '\\c ');
  return `url("${escaped}")`;
}

/** Position, centring and team-coloured glow of a marker. */
export function markerStyle(m: Pick<Marker, 'x' | 'y' | 'color'>): string {
  return `left:${m.x}px;top:${m.y}px;transform:translate(-50%,-50%);filter:drop-shadow(0 0 3px ${markerColor(m.color)});`;
}

/** Icon box: alpha shape from the PNG (mask), fill from `m.color`. */
export function markerIconStyle(
  m: Pick<Marker, 'over' | 'iconUrl' | 'w' | 'h' | 'color'>,
  overUrl: string,
): string {
  const icon = markerIcon(m, overUrl);
  if (!icon) return '';
  const url = cssUrl(icon.url);
  return [
    `width:${icon.w}px`,
    `height:${icon.h}px`,
    'position:relative',
    `background-color:${markerColor(m.color)}`,
    `-webkit-mask-image:${url}`,
    `mask-image:${url}`,
    '-webkit-mask-repeat:no-repeat',
    'mask-repeat:no-repeat',
    '-webkit-mask-position:center',
    'mask-position:center',
    '-webkit-mask-size:100% 100%',
    'mask-size:100% 100%',
  ].join(';') + ';';
}

/**
 * Enemy identification border. The generated ring is the exact 1 px outer
 * contour of the PNG alpha (the same flood-fill the GL/XR HUD uses). Until
 * that image has decoded, an immediate CSS fallback XOR-composites the full
 * icon mask with a 2 px-inset copy; GameView repaints when the ring is ready.
 * Allies and goals get no overlay.
 */
export function markerBorderStyle(
  m: Pick<Marker, 'enemy' | 'over' | 'iconUrl' | 'w' | 'h' | 'color'>,
  overUrl: string,
): string {
  if (!m.enemy) return '';
  const icon = markerIcon(m, overUrl);
  if (!icon) return '';
  const ring = iconBorderDataUrl(icon.url, oppositeColor(m.color), icon.w, icon.h);
  if (ring) {
    return [
      'position:absolute',
      'inset:0',
      'pointer-events:none',
      `background-image:${cssUrl(ring)}`,
      'background-repeat:no-repeat',
      'background-position:center',
      'background-size:100% 100%',
    ].join(';') + ';';
  }
  const url = cssUrl(icon.url);
  const border = markerColor(oppositeColor(m.color));
  return [
    'position:absolute',
    'inset:0',
    'pointer-events:none',
    `background-color:${border}`,
    `-webkit-mask-image:${url},${url}`,
    `mask-image:${url},${url}`,
    '-webkit-mask-repeat:no-repeat,no-repeat',
    'mask-repeat:no-repeat,no-repeat',
    '-webkit-mask-position:center,center',
    'mask-position:center,center',
    '-webkit-mask-size:100% 100%,calc(100% - 2px) calc(100% - 2px)',
    'mask-size:100% 100%,calc(100% - 2px) calc(100% - 2px)',
    '-webkit-mask-composite:xor',
    'mask-composite:exclude',
  ].join(';') + ';';
}
