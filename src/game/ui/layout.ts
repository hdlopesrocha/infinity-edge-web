// Shared geometry and chrome for the WebGL menus.
//
// Every menu-like screen (MenuUi, the multiplayer lobby and the waiting room)
// reserves the right eighth of the 1280x720 design for actions and keeps the
// remaining seven eighths for content. This module owns that split, the action
// column painter (fullscreen, primary, context actions, back) and the panel
// box, so the three UIs cannot drift apart.

import { FS_REGION, paintFullscreenButton } from './fullscreen';
import { VR_REGION, paintVrButton } from './vrchrome';
import type { Rgb } from '../colors';
import { cssColor, currentPlayerAccent, readableAccent } from './theme';

/** Menu font stack shared by the WebGL screens. */
export const UI_FONT = "'DejaVu Sans','Segoe UI',Verdana,sans-serif";

export const MENU_W = 1280;
export const MENU_H = 720;

/** Actions column: exactly one eighth of the design width, on the right. */
export const ACTIONS_W = MENU_W / 8;           // 160
/** Content fills the rest, from the left edge up to the action column. */
export const CONTENT_X = 0;
export const CONTENT_W = MENU_W - ACTIONS_W;   // 1120
/** Centre of the content area (path, headings and status lines use it). */
export const CONTENT_CX = CONTENT_X + CONTENT_W / 2;   // 560

/**
 * Width of the content area for a screen. Menus reserve the action column;
 * the in-game HUD is a game scene with no actions, so it uses the full width.
 */
export function contentWidth(showActions: boolean): number {
  return showActions ? CONTENT_W : MENU_W;
}

/** The path sits in this compact navbar inside the content rectangle. */
export const NAVBAR_H = 48;
export const CONTENT_MARGIN = 0;
export const PANEL_GAP = 16;
/** Two equal content panels side by side in the content area. */
export const PANEL_W = (CONTENT_W - CONTENT_MARGIN * 2 - PANEL_GAP) / 2;   // 552
export const PANEL_Y = 56;
export const PANEL_H = MENU_H - PANEL_Y;                                    // 664
/** One wide panel (briefing, results, ...) fills the whole content width. */
export const SINGLE_W = CONTENT_W - CONTENT_MARGIN * 2;                     // 1120

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
 * The painted menu plane that must stay sharp in the focus veil. The rectangle
 * encloses every design element - the navbar path, both content panels and the
 * right action column (fullscreen, primary actions and back) - so nothing
 * inside the 1280x720 design is blurred or dimmed. Coordinates are design
 * pixels; use contentFocusRect() for a canvas.
 */
export const FOCUS_X = 0;
export const FOCUS_Y = 0;
export const FOCUS_W = MENU_W;
export const FOCUS_H = MENU_H;

/**
 * Map the full menu plane into a canvas of `w` x `h` pixels. Menus are
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

/**
 * One content rectangle shared by the menus, settings, pause screen, lobby
 * and room: everything left of the action column, from the navbar to the
 * bottom edge. Screens draw their own columns on top, without nested panel
 * boxes, so the chrome cannot drift between routes.
 */
export function paintContentShell(
  ctx: CanvasRenderingContext2D, s: number,
  X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  width = CONTENT_W,
): void {
  paintPanelBox(ctx, X(0), Y(0), U(width), U(MENU_H), s);
}

export interface NavbarCrumb {
  label: string;
  current: boolean;
}

/**
 * The shared clickable path/navbar. It occupies the top NAVBAR_H pixels of
 * the content rectangle and leaves the rest for the screen content. Returns
 * the hit regions for non-current crumbs (ids: crumb:0, crumb:1, …).
 */
export function paintNavbar(
  ctx: CanvasRenderingContext2D, s: number,
  X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  crumbs: readonly NavbarCrumb[], hover: string | null, accent: Rgb,
  width = CONTENT_W,
  /** Right-aligned readout (e.g. the player's sat balance) in the navbar. */
  rightText: string | null = null,
): UiRegion[] {
  const regions: UiRegion[] = [];
  const accentText = readableAccent(accent);
  // Right-aligned readout first: the crumbs shrink so they never overlap it.
  let rightW = 0;
  if (rightText) {
    ctx.save();
    ctx.font = `700 ${U(13)}px ${UI_FONT}`;
    rightW = ctx.measureText(rightText).width;
    ctx.restore();
  }
  if (crumbs.length === 0) {
    if (rightText) {
      ctx.save();
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      ctx.font = `700 ${U(13)}px ${UI_FONT}`;
      ctx.fillStyle = cssColor(accentText);
      ctx.fillText(rightText, X(width - 24), Y(NAVBAR_H / 2));
      ctx.restore();
    }
    return regions;
  }
  const sep = '  ›  ';
  const maxW = Math.max(U(40), U(width - 48) - (rightText ? rightW + U(20) : 0));
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  let fontPx = 14;
  ctx.font = `600 ${U(fontPx)}px ${UI_FONT}`;
  let widths = crumbs.map((c) => ctx.measureText(c.label).width);
  let sepW = ctx.measureText(sep).width;
  let total = widths.reduce((a, b) => a + b, 0) + sepW * (crumbs.length - 1);
  if (total > maxW) {
    fontPx = Math.max(10, fontPx * (maxW / total));
    ctx.font = `600 ${U(fontPx)}px ${UI_FONT}`;
    widths = crumbs.map((c) => ctx.measureText(c.label).width);
    sepW = ctx.measureText(sep).width;
    total = widths.reduce((a, b) => a + b, 0) + sepW * (crumbs.length - 1);
  }
  // Navbar band inside the content rectangle (left-aligned, like a navbar).
  ctx.fillStyle = 'rgba(4, 8, 14, 0.42)';
  ctx.fillRect(X(0), Y(0), U(width), U(NAVBAR_H));
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fillRect(X(0), Y(NAVBAR_H), U(width), Math.max(1, s));
  let x = X(24);
  const y = Y(NAVBAR_H / 2);
  for (let i = 0; i < crumbs.length; i++) {
    const c = crumbs[i];
    const w = widths[i];
    const id = 'crumb:' + i;
    if (c.current) {
      ctx.fillStyle = cssColor(accentText);
    } else {
      ctx.fillStyle = hover === id ? cssColor(accentText) : cssColor(accentText, 0.72);
    }
    ctx.fillText(c.label, x, y);
    if (c.current) {
      ctx.fillStyle = cssColor(accent, 0.9);
      ctx.fillRect(x, y + U(11), w, Math.max(1, U(1.5)));
    } else {
      regions.push({ id, x: x - U(4), y: y - U(11), w: w + U(8), h: U(22) });
    }
    x += w;
    if (i < crumbs.length - 1) {
      ctx.fillStyle = 'rgba(255,255,255,0.32)';
      ctx.fillText(sep, x, y);
      x += sepW;
    }
  }
  if (rightText) {
    ctx.textAlign = 'right';
    ctx.font = `700 ${U(13)}px ${UI_FONT}`;
    ctx.fillStyle = cssColor(accentText);
    ctx.fillText(rightText, X(width - 24), y);
    ctx.textAlign = 'left';
  }
  ctx.restore();
  return regions;
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
  /** Player-colour accent; defaults to the live Options value. */
  accent?: Rgb;
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
  const accent = spec.accent ?? currentPlayerAccent();
  const accentText = readableAccent(accent);
  // Right edge of the design; the content area ends where the column starts.
  const x0 = MENU_W - ACTIONS_W;
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  if (spec.chrome !== false) {
    // Column strip + hairline: a clear separation from the content area.
    ctx.fillStyle = 'rgba(6,10,16,0.55)';
    ctx.fillRect(X(x0), Y(0), U(ACTIONS_W), U(MENU_H));
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(X(x0), Y(0), Math.max(1, s), U(MENU_H));
    // Compact header: label on its own line above the two toggles.
    ctx.font = `700 ${U(11)}px ${UI_FONT}`;
    ctx.fillStyle = cssColor(accentText, 0.55);
    ctx.fillText('ACTIONS', X(x0 + 12), Y(14));
  }

  // Fullscreen + VR toggles, top right of the column (present on every screen).
  const fsSize = U(44);
  const btnY = Y(22);
  const fsX = X(x0 + ACTIONS_W - 60);
  paintFullscreenButton(ctx, fsX, btnY, fsSize, s, spec.hover === FS_REGION, accent);
  regions.push({ id: FS_REGION, x: fsX, y: btnY, w: fsSize, h: fsSize });
  const vrX = X(x0 + ACTIONS_W - 60 - 44 - 8);
  paintVrButton(ctx, vrX, btnY, fsSize, s, spec.hover === VR_REGION, accent);
  regions.push({ id: VR_REGION, x: vrX, y: btnY, w: fsSize, h: fsSize });

  if (spec.chrome !== false) {
    // Square tiles: each action is exactly the column's width and height
    // (160 x 160), edge to edge, so the whole column is a big click target.
    const bx = X(x0);
    const bw = U(ACTIONS_W);
    const bh = ACTIONS_W;
    let y = 74;

    const tile = (a: ActionSpec, primary: boolean): void => {
      const disabled = a.disabled === true;
      const hovered = !disabled && spec.hover === a.id;
      ctx.fillStyle = disabled
        ? 'rgba(10,14,22,0.35)'
        : primary
          ? cssColor(accent, hovered ? 0.26 : 0.14)
          : a.danger
            ? (hovered ? 'rgba(130,36,28,0.55)' : 'rgba(70,18,18,0.4)')
            : (hovered ? cssColor(accent, 0.16) : 'rgba(10,14,22,0.72)');
      ctx.fillRect(bx, Y(y), bw, U(bh));
      ctx.strokeStyle = disabled
        ? 'rgba(255,255,255,0.10)'
        : primary
          ? cssColor(accent, 0.75)
          : a.danger
            ? 'rgba(255,122,82,0.5)'
            : cssColor(accent, hovered ? 0.45 : 0.24);
      ctx.lineWidth = Math.max(1, s);
      ctx.strokeRect(bx, Y(y), bw, U(bh));
      const size = primary ? 18 : 16;
      ctx.font = `700 ${U(size)}px ${UI_FONT}`;
      const label = a.label;
      ctx.textAlign = 'center';
      ctx.fillStyle = disabled
        ? 'rgba(255,255,255,0.3)'
        : a.danger ? '#ffb0a0' : cssColor(accentText);
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
      ctx.fillStyle = hovered ? cssColor(accent, 0.18) : 'rgba(10,14,22,0.72)';
      ctx.fillRect(bx, Y(by), bw, U(bh));
      ctx.strokeStyle = a.danger ? 'rgba(255,122,82,0.5)' : cssColor(accent, 0.28);
      ctx.lineWidth = Math.max(1, s);
      ctx.strokeRect(bx, Y(by), bw, U(bh));
      ctx.font = `700 ${U(16)}px ${UI_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = a.danger ? '#ffb0a0' : cssColor(accentText);
      ctx.fillText(a.label, bx + bw / 2, Y(by + bh / 2) + U(1));
      ctx.textAlign = 'left';
      regions.push({ id: a.id, x: bx, y: Y(by), w: bw, h: U(bh) });
    }
  }

  ctx.restore();
  return regions;
}
