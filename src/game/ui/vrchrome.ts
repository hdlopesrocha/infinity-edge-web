// VR-mode chrome: the headset toggle painted next to the fullscreen button on
// every WebGL menu (menus, lobby, room, pause). Keeping it here — beside
// fullscreen.ts — guarantees the same look and behaviour on every screen.

import type { Rgb } from '../colors';
import { store } from '../store';
import { toggleVrMode } from '../vr';
import { cssColor, currentPlayerAccent, readableAccent } from './theme';

/** Region id used by every UI for the VR toggle button. */
export const VR_REGION = 'vr-toggle';

/** True while VR mode is on (read at paint time). */
export function isVrOn(): boolean {
  return store.vr;
}

/** Toggle VR mode; callers repaint once it resolves. */
export function clickVrToggle(): Promise<void> {
  return toggleVrMode();
}

const FONT = "'DejaVu Sans','Segoe UI',Verdana,sans-serif";

/**
 * Paint the 44 px "goggles" toggle at (x, y). `scale` is the caller's UI pixel
 * scale. The caller registers `VR_REGION` with the same rectangle.
 */
export function paintVrButton(
  ctx: CanvasRenderingContext2D, x: number, y: number, size: number, scale: number,
  hovered: boolean, accent: Rgb = currentPlayerAccent(),
): void {
  const on = store.vr;
  ctx.fillStyle = on
    ? cssColor(accent, 0.24)
    : hovered ? 'rgba(255,255,255,0.16)' : 'rgba(10,14,22,0.6)';
  ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = cssColor(accent, on ? 0.85 : hovered ? 0.55 : 0.24);
  ctx.lineWidth = Math.max(1, scale);
  ctx.strokeRect(x, y, size, size);

  // Goggles: two lenses joined by a bridge.
  const w = size * 0.62;
  const h = size * 0.34;
  const lx = x + (size - w) / 2;
  const ly = y + (size - h) / 2;
  const lensW = w * 0.42;
  ctx.strokeStyle = on ? cssColor(accent) : cssColor(readableAccent(accent), 0.9);
  ctx.lineWidth = Math.max(1.4, 2 * scale);
  ctx.strokeRect(lx, ly, lensW, h);
  ctx.strokeRect(lx + w - lensW, ly, lensW, h);
  ctx.beginPath();
  ctx.moveTo(lx + lensW, ly + h / 2);
  ctx.lineTo(lx + w - lensW, ly + h / 2);
  ctx.stroke();
}
