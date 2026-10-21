// Fullscreen chrome shared by every WebGL view (boot screens, menus, lobby,
// room) and by the in-match DOM button. Keeping one implementation guarantees
// the same icon and behaviour from the boot sequence onwards.

import type { Rgb } from '../colors';
import { cssColor, currentPlayerAccent, readableAccent } from './theme';

export function isFullscreen(): boolean {
  return typeof document !== 'undefined' && !!document.fullscreenElement;
}

/**
 * Toggle fullscreen. Never rejects: iOS Safari and some embedded browsers do
 * not implement the API, and a refusal must not break the screen.
 */
export async function toggleFullscreen(): Promise<void> {
  if (typeof document === 'undefined') return;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { /* not permitted / not supported */ }
}

/** Region id used by every UI for the button. */
export const FS_REGION = 'fs';

/**
 * Paint the 44 px bracketed-corners button at (x, y). `scale` is the caller's
 * UI pixel scale, so the stroke and arms match the surrounding chrome.
 * The caller registers `FS_REGION` with the same rectangle.
 */
export function paintFullscreenButton(
  ctx: CanvasRenderingContext2D, x: number, y: number, size: number, scale: number, hovered: boolean,
  accent: Rgb = currentPlayerAccent(),
): void {
  ctx.fillStyle = hovered ? 'rgba(255,255,255,0.16)' : 'rgba(10,14,22,0.6)';
  ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = cssColor(accent, hovered ? 0.55 : 0.24);
  ctx.lineWidth = Math.max(1, scale);
  ctx.strokeRect(x, y, size, size);

  const full = isFullscreen();
  ctx.strokeStyle = hovered ? cssColor(accent) : cssColor(readableAccent(accent), 0.9);
  ctx.lineWidth = Math.max(1.4, 2 * scale);
  const p = size * 0.25;
  const arm = size * 0.136;
  const cx = x + size / 2;
  const cy = y + size / 2;
  ctx.beginPath();
  if (full) {
    // Inward corners for "exit fullscreen".
    ctx.moveTo(cx - p, cy - p + arm); ctx.lineTo(cx - p, cy - p); ctx.lineTo(cx - p + arm, cy - p);
    ctx.moveTo(cx + p - arm, cy - p); ctx.lineTo(cx + p, cy - p); ctx.lineTo(cx + p, cy - p + arm);
    ctx.moveTo(cx - p, cy + p - arm); ctx.lineTo(cx - p, cy + p); ctx.lineTo(cx - p + arm, cy + p);
    ctx.moveTo(cx + p - arm, cy + p); ctx.lineTo(cx + p, cy + p); ctx.lineTo(cx + p, cy + p - arm);
  } else {
    // Outward arms for "enter fullscreen".
    const corner = (dx: number, dy: number): void => {
      ctx.moveTo(cx + dx * p, cy + dy * (p - arm));
      ctx.lineTo(cx + dx * p, cy + dy * p);
      ctx.lineTo(cx + dx * (p - arm), cy + dy * p);
    };
    corner(-1, -1);
    corner(1, -1);
    corner(-1, 1);
    corner(1, 1);
  }
  ctx.stroke();
}
