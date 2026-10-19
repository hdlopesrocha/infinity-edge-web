// Shared geometry and chrome for the WebGL menus.
//
// Every menu-like screen (MenuUi, the multiplayer lobby and the waiting room)
// reserves the right eighth of the 1280x720 design for actions and keeps the
// remaining seven eighths for content. This module owns that split, the action
// column painter (fullscreen, primary, context actions, back) and the panel
// box, so the three UIs cannot drift apart.

import { FS_REGION, paintFullscreenButton } from './fullscreen';

/** Menu font stack shared by the WebGL screens. */
export const UI_FONT = "'DejaVu Sans','Segoe UI',Verdana,sans-serif";

export const MENU_W = 1280;
export const MENU_H = 720;

/** Actions column: exactly one eighth of the design width. */
export const ACTIONS_W = MENU_W / 8;           // 160
export const CONTENT_W = MENU_W - ACTIONS_W;   // 1120
/** Centre of the content area (the title and status lines use it). */
export const CONTENT_CX = CONTENT_W / 2;       // 560

export const CONTENT_MARGIN = 40;
export const PANEL_GAP = 24;
/** Two equal content panels side by side in the left seven eighths. */
export const PANEL_W = (CONTENT_W - CONTENT_MARGIN * 2 - PANEL_GAP) / 2;   // 508
export const PANEL_Y = 104;
export const PANEL_H = 512;
/** One wide panel (briefing, results, ...). */
export const SINGLE_W = 720;

export interface UiRegion {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function leftPanelX(index: 0 | 1): number {
  return CONTENT_MARGIN + index * (PANEL_W + PANEL_GAP);
}

export function singlePanelX(width = SINGLE_W): number {
  return Math.round((CONTENT_W - width) / 2);
}

/** The translucent panel used by every menu screen (device pixels). */
export function paintPanelBox(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, s: number,
): void {
  ctx.fillStyle = 'rgba(8,12,20,0.64)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = Math.max(1, s);
  ctx.strokeRect(x, y, w, h);
}

export interface ActionSpec {
  id: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
}

export interface ActionColumnSpec {
  /** Main action at the top of the column (save / start / create / play). */
  primary?: ActionSpec;
  /** Secondary actions under the primary (refresh, close room, ...). */
  actions?: ActionSpec[];
  /** Action pinned to the bottom of the column (back / close / leave). */
  back?: ActionSpec;
  hover?: string | null;
  /** false = splash screens: draw only the fullscreen toggle. */
  chrome?: boolean;
}

/**
 * Paint the right action column and return its hit regions (design pixels,
 * already scaled through X/Y/U). The caller pushes them into its region list;
 * the ids keep the existing activate/pointer handlers working.
 */
export function paintActionColumn(
  ctx: CanvasRenderingContext2D, s: number,
  X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  spec: ActionColumnSpec,
): UiRegion[] {
  const regions: UiRegion[] = [];
  const x0 = CONTENT_W;
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  if (spec.chrome !== false) {
    // Column strip + hairline: a clear separation from the content area.
    ctx.fillStyle = 'rgba(6,10,16,0.55)';
    ctx.fillRect(X(x0), Y(0), U(ACTIONS_W), U(MENU_H));
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(X(x0), Y(0), Math.max(1, s), U(MENU_H));
    ctx.font = `700 ${U(11)}px ${UI_FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillText('ACTIONS', X(x0 + 12), Y(74));
  }

  // Fullscreen toggle, top right of the column (present on every screen).
  const fsSize = U(44);
  const fsX = X(MENU_W - 60);
  const fsY = Y(12);
  paintFullscreenButton(ctx, fsX, fsY, fsSize, s, spec.hover === FS_REGION);
  regions.push({ id: FS_REGION, x: fsX, y: fsY, w: fsSize, h: fsSize });

  if (spec.chrome !== false) {
    const bx = X(x0 + 10);
    const bw = U(ACTIONS_W - 20);
    let y = 88;

    const button = (a: ActionSpec, h: number, primary: boolean): void => {
      const disabled = a.disabled === true;
      const hovered = !disabled && spec.hover === a.id;
      ctx.fillStyle = disabled
        ? 'rgba(10,14,22,0.35)'
        : primary
          ? (hovered ? 'rgba(127,232,216,0.24)' : 'rgba(127,232,216,0.13)')
          : a.danger
            ? (hovered ? 'rgba(130,36,28,0.5)' : 'rgba(70,18,18,0.38)')
            : (hovered ? 'rgba(255,255,255,0.16)' : 'rgba(10,14,22,0.72)');
      ctx.fillRect(bx, Y(y), bw, U(h));
      ctx.strokeStyle = disabled
        ? 'rgba(255,255,255,0.10)'
        : primary
          ? 'rgba(127,232,216,0.75)'
          : a.danger
            ? 'rgba(255,122,82,0.5)'
            : 'rgba(255,255,255,0.16)';
      ctx.lineWidth = Math.max(1, s);
      ctx.strokeRect(bx, Y(y), bw, U(h));
      ctx.font = `700 ${U(primary ? 14 : 13)}px ${UI_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = disabled ? 'rgba(255,255,255,0.3)' : primary ? '#7fe8d8' : '#ffffff';
      const words = a.label.split(' ');
      if (ctx.measureText(a.label).width > bw - U(14) && words.length > 1) {
        const mid = Math.ceil(words.length / 2);
        ctx.fillText(words.slice(0, mid).join(' '), bx + bw / 2, Y(y + h / 2) - U(7));
        ctx.fillText(words.slice(mid).join(' '), bx + bw / 2, Y(y + h / 2) + U(8));
      } else {
        ctx.fillText(a.label, bx + bw / 2, Y(y + h / 2) + U(1));
      }
      ctx.textAlign = 'left';
      if (!disabled) regions.push({ id: a.id, x: bx, y: Y(y), w: bw, h: U(h) });
      y += h + 10;
    };

    if (spec.primary) button(spec.primary, 48, true);
    for (const a of spec.actions ?? []) button(a, 44, false);

    if (spec.back) {
      const h = 48;
      const by = MENU_H - 54;
      const hovered = spec.hover === spec.back.id;
      ctx.fillStyle = hovered ? 'rgba(255,255,255,0.16)' : 'rgba(10,14,22,0.72)';
      ctx.fillRect(bx, Y(by), bw, U(h));
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.lineWidth = Math.max(1, s);
      ctx.strokeRect(bx, Y(by), bw, U(h));
      ctx.font = `700 ${U(13)}px ${UI_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = spec.back.danger ? '#ffb0a0' : '#ffffff';
      const label = spec.back.label;
      if (ctx.measureText(label).width > bw - U(14)) {
        const words = label.split(' ');
        const mid = Math.ceil(words.length / 2);
        ctx.fillText(words.slice(0, mid).join(' '), bx + bw / 2, Y(by + h / 2) - U(7));
        ctx.fillText(words.slice(mid).join(' '), bx + bw / 2, Y(by + h / 2) + U(8));
      } else {
        ctx.fillText(label, bx + bw / 2, Y(by + h / 2) + U(1));
      }
      ctx.textAlign = 'left';
      regions.push({ id: spec.back.id, x: bx, y: Y(by), w: bw, h: U(h) });
    }
  }

  ctx.restore();
  return regions;
}
