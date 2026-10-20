// Shared geometry and chrome for the WebGL menus.
//
// Every menu-like screen (MenuUi, the multiplayer lobby and the waiting room)
// reserves the left eighth of the 1280x720 design for actions and keeps the
// remaining seven eighths for content. This module owns that split, the action
// column painter (fullscreen, primary, context actions, back) and the panel
// box, so the three UIs cannot drift apart.

import { FS_REGION, paintFullscreenButton } from './fullscreen';

/** Menu font stack shared by the WebGL screens. */
export const UI_FONT = "'DejaVu Sans','Segoe UI',Verdana,sans-serif";

export const MENU_W = 1280;
export const MENU_H = 720;

/** Actions column: exactly one eighth of the design width, on the left. */
export const ACTIONS_W = MENU_W / 8;           // 160
/** Content starts right of the action column. */
export const CONTENT_X = ACTIONS_W;            // 160
export const CONTENT_W = MENU_W - ACTIONS_W;   // 1120
/** Centre of the content area (the title and status lines use it). */
export const CONTENT_CX = CONTENT_X + CONTENT_W / 2;   // 720

export const CONTENT_MARGIN = 40;
export const PANEL_GAP = 24;
/** Two equal content panels side by side in the content area. */
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
  return CONTENT_X + CONTENT_MARGIN + index * (PANEL_W + PANEL_GAP);
}

export function singlePanelX(width = SINGLE_W): number {
  return CONTENT_X + Math.round((CONTENT_W - width) / 2);
}

/**
 * The painted menu content that must stay sharp in the focus veil. The action
 * column and the title still draw over the veil, but the two content panels
 * are the visual "island": everything beyond them - including the space
 * around the column - is blurred and tinted by the post-process.
 * Coordinates are design pixels; use contentFocusRect() for a canvas.
 */
export const FOCUS_X = CONTENT_X + CONTENT_MARGIN;      // 200
export const FOCUS_Y = PANEL_Y;                         // 104
export const FOCUS_W = PANEL_W * 2 + PANEL_GAP;         // 1040
export const FOCUS_H = PANEL_H;                         // 512

/**
 * Map the menu content rectangle into a canvas of `w` x `h` pixels. Menus are
 * authored at 1280x720 and letterboxed, so the focus must follow the same
 * scale/offset as the painter.
 */
export function contentFocusRect(
  w: number, h: number,
): { x: number; y: number; w: number; h: number } {
  const s = Math.min(w / MENU_W, h / MENU_H);
  const ox = (w - MENU_W * s) / 2;
  const oy = (h - MENU_H * s) / 2;
  return {
    x: ox + FOCUS_X * s,
    y: oy + FOCUS_Y * s,
    w: FOCUS_W * s,
    h: FOCUS_H * s,
  };
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
  // Left edge of the design; the content area starts after the column.
  const x0 = 0;
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  if (spec.chrome !== false) {
    // Column strip + hairline: a clear separation from the content area.
    ctx.fillStyle = 'rgba(6,10,16,0.55)';
    ctx.fillRect(X(x0), Y(0), U(ACTIONS_W), U(MENU_H));
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(X(ACTIONS_W - 1), Y(0), Math.max(1, s), U(MENU_H));
    // Compact header: label on the left, fullscreen toggle on the right.
    ctx.font = `700 ${U(11)}px ${UI_FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillText('ACTIONS', X(x0 + 12), Y(30));
  }

  // Fullscreen toggle, top right of the column (present on every screen).
  const fsSize = U(44);
  const fsX = X(ACTIONS_W - 60);
  const fsY = Y(6);
  paintFullscreenButton(ctx, fsX, fsY, fsSize, s, spec.hover === FS_REGION);
  regions.push({ id: FS_REGION, x: fsX, y: fsY, w: fsSize, h: fsSize });

  if (spec.chrome !== false) {
    // Square tiles: each action is exactly the column's width and height
    // (160 x 160), edge to edge, so the whole column is a big click target.
    const bx = X(x0);
    const bw = U(ACTIONS_W);
    const bh = ACTIONS_W;
    let y = 56;

    const tile = (a: ActionSpec, primary: boolean): void => {
      const disabled = a.disabled === true;
      const hovered = !disabled && spec.hover === a.id;
      ctx.fillStyle = disabled
        ? 'rgba(10,14,22,0.35)'
        : primary
          ? (hovered ? 'rgba(127,232,216,0.26)' : 'rgba(127,232,216,0.14)')
          : a.danger
            ? (hovered ? 'rgba(130,36,28,0.55)' : 'rgba(70,18,18,0.4)')
            : (hovered ? 'rgba(255,255,255,0.16)' : 'rgba(10,14,22,0.72)');
      ctx.fillRect(bx, Y(y), bw, U(bh));
      ctx.strokeStyle = disabled
        ? 'rgba(255,255,255,0.10)'
        : primary
          ? 'rgba(127,232,216,0.75)'
          : a.danger
            ? 'rgba(255,122,82,0.5)'
            : 'rgba(255,255,255,0.16)';
      ctx.lineWidth = Math.max(1, s);
      ctx.strokeRect(bx, Y(y), bw, U(bh));
      const size = primary ? 18 : 16;
      ctx.font = `700 ${U(size)}px ${UI_FONT}`;
      const label = a.label;
      ctx.textAlign = 'center';
      ctx.fillStyle = disabled ? 'rgba(255,255,255,0.3)' : primary ? '#7fe8d8' : '#ffffff';
      ctx.fillText(label, bx + bw / 2, Y(y + bh / 2) + U(1));
      ctx.textAlign = 'left';
      if (!disabled) regions.push({ id: a.id, x: bx, y: Y(y), w: bw, h: U(bh) });
      y += bh;
    };

    if (spec.primary) tile(spec.primary, true);
    for (const a of spec.actions ?? []) tile(a, false);

    if (spec.back) {
      const by = MENU_H - bh;
      const a = spec.back;
      const hovered = spec.hover === a.id;
      ctx.fillStyle = hovered ? 'rgba(255,255,255,0.16)' : 'rgba(10,14,22,0.72)';
      ctx.fillRect(bx, Y(by), bw, U(bh));
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.lineWidth = Math.max(1, s);
      ctx.strokeRect(bx, Y(by), bw, U(bh));
      ctx.font = `700 ${U(16)}px ${UI_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = a.danger ? '#ffb0a0' : '#ffffff';
      ctx.fillText(a.label, bx + bw / 2, Y(by + bh / 2) + U(1));
      ctx.textAlign = 'left';
      regions.push({ id: a.id, x: bx, y: Y(by), w: bw, h: U(bh) });
    }
  }

  ctx.restore();
  return regions;
}
