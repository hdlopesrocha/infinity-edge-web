// WebGL menu UI: every menu screen is painted into the WebGL frame (the same
// ScreenUi overlay the multiplayer lobby uses), so the menus need no DOM at
// all. The original menu art is used: 128/256 px icons, the `_menubtn` button
// plate and the medal textures; the boot/start wordmarks are text in the
// original Airstrike face (src/game/fonts.ts).
//
// The screens (src/game/ui/screens.ts) describe their content declaratively;
// this module lays it out, paints it, and routes pointer/keyboard input back
// as `onSelect` / `onChange` callbacks.

import { nextUiVersion } from '../../engine/overlay';
import { COLOR_PALETTE, DEFAULT_PLAYER_COLOR, normalizeHexColor } from '../colors';
import type { Rgb } from '../colors';
import { satsLabel } from '../wallet';
import { store } from '../store';
import { optionLabel, optionListHeight, paintChip, paintOptionList } from './rosterui';
import { FS_REGION } from './fullscreen';
import { VR_REGION } from './vrchrome';
import { cssColor, accentMoved, currentPlayerAccent, readableAccent } from './theme';
import { wordmarkFont } from '../fonts';
import {
  UI_FONT as FONT, CONTENT_CX, CONTENT_MARGIN, CONTENT_W, CONTENT_X, MENU_W,
  PANEL_GAP, PANEL_Y, PANEL_H, contentWidth, paintActionColumn, paintContentShell,
  paintNavbar, contentFocusRect,
} from './layout';
import type { ActionSpec } from './layout';
import type { ScreenUi } from '../../engine/overlay';

const DW = 1280;
const DH = 720;
/** Height reserved for the settings-style tab bar above the panels (design px). */
const TAB_H = 44;
const TEX_BASE = (import.meta.env.BASE_URL + 'assets/textures/').replace(/([^:])\/\//g, '$1/');

export interface MenuIconItem {
  id: string;
  label: string;
  /** Texture file name under assets/textures (e.g. '_singlePlayer.png'). */
  icon?: string;
}

export type PanelLine =
  | {
      text: string;
      color?: string;
      size?: number;
      align?: 'left' | 'center' | 'right';
      gapBefore?: number;
      wrap?: boolean;
      bold?: boolean;
    }
  | { left: string; right: string; color?: string; gapBefore?: number };

export type MenuRow =
  | {
      kind: 'slider';
      id: string;
      label: string;
      value: number;
      min: number;
      max: number;
      step: number;
      display: (v: number) => string;
    }
  | { kind: 'check'; id: string; label: string; value: boolean }
  | { kind: 'text'; id: string; label: string; value: string; maxLength: number }
  | { kind: 'color'; id: string; label: string; value: string }
  | {
      /** A labelled dropdown: `label` on the left, a value chip on the right. */
      kind: 'select';
      id: string;
      label: string;
      value: string;
      options: readonly { value: string; label: string }[];
    }
  | { kind: 'button'; id: string; label: string; value?: string; disabled?: boolean }
  | {
      /**
       * One compact agent row: the bot's name plus inline AI and TEAM
       * dropdowns and a remove control. Regions: `agent:<id>:ai|team|remove`.
       */
      kind: 'agent';
      id: string;
      name: string;
      ai: string;
      aiOptions: readonly { value: string; label: string }[];
      team: string;
      teamOptions: readonly { value: string; label: string }[];
      removable: boolean;
    }
  | { kind: 'info'; text: string; small?: boolean };

export interface MenuPanel {
  heading?: string;
  icons?: MenuIconItem[];
  buttons?: MenuIconItem[];
  rows?: MenuRow[];
  table?: { title?: string; rows: string[] };
  lines?: PanelLine[];
  watermark?: string;
  footer?: string;
}

/** One tab in the tab bar painted above the content panels. */
export interface MenuTab {
  id: string;
  label: string;
  active: boolean;
}

export interface MenuScreen {
  /** Path crumb used when the host does not supply a trail (unknown route / boot chrome). */
  title: string;
  /** Optional tab bar above the panels (Options: Settings / Controls). */
  tabs?: MenuTab[];
  left?: MenuPanel;
  right?: MenuPanel;
  /** Boot/start wordmark text, painted in the original Airstrike face. */
  wordmark?: string;
  /** Loading bar (boot screens). */
  loading?: { done: number; total: number } | null;
  /** Primary corner button (save/start/menu); null = none. */
  primary?: { id: string; label: string };
  /** Secondary actions in the right column (pause options, refresh, …). */
  actions?: ActionSpec[];
  /** Corner back label (exit at the root, else back). */
  backLabel?: string;
  /** No panels at all (unknown route: only the chrome). */
  empty?: boolean;
  /** Splash screens (boot/engine/start) draw no corner buttons at all. */
  hideChrome?: boolean;
  /**
   * Whether the generic UI plane reserves the right action column. Menus keep
   * it on; the in-game HUD switches it off programmatically.
   */
  showActions?: boolean;
}

export interface MenuCallbacks {
  onSelect: (id: string, value?: string) => void;
  onChange: (id: string, value: number | boolean | string) => void;
  onBack: () => void;
  onPrimary: () => void;
  onCrumb: (index: number) => void;
}

interface Region {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Column {
  panel: MenuPanel;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Computed row pitch; rows spread out when the panel is tall. */
  rowH?: number;
}

const imageCache = new Map<string, HTMLImageElement>();
const imagePending = new Set<string>();

export class MenuUi implements ScreenUi {
  version = nextUiVersion();
  /** Last paint exception (diagnostics: the renderer swallows paint errors). */
  lastError: string | null = null;
  private screen: MenuScreen;
  private cb: MenuCallbacks;
  private ctx: CanvasRenderingContext2D | null = null;
  private logical = { w: DW, h: DH };
  private regions: Region[] = [];
  private hover: string | null = null;
  private pressed: string | null = null;
  private dragging: string | null = null;
  private focus: string | null = null;
  private colorPicker: { id: string; label: string; value: string } | null = null;
  /** Open dropdown for an agent AI/TEAM chip (generic list select). */
  private dropdown: {
    id: string;
    options: readonly { value: string; label: string }[];
    value: string;
    anchor: Region;
  } | null = null;
  private caretOn = true;
  private scroll = 0;
  private contentBottom = 0;
  private crumbs: { label: string; current: boolean }[] = [];
  private onImageLoad: () => void;
  /** Live accent, refreshed at the start of each paint from Options. */
  private accent: Rgb = currentPlayerAccent();
  private accentText: Rgb = readableAccent(this.accent);
  private paintedAccent: Rgb | null = null;
  private lastAccentCheck = 0;
  /** Generic UI plane switch: menus on, the game HUD off. */
  private showActions = true;

  constructor(screen: MenuScreen, cb: MenuCallbacks, onImageLoad: () => void) {
    this.screen = screen;
    this.cb = cb;
    this.onImageLoad = onImageLoad;
    this.showActions = screen.showActions !== false;
  }

  setScreen(screen: MenuScreen): void {
    // Screens are rebuilt whenever a live option changes. Keep editing state
    // that still belongs to a row on the new screen: dropping it would stop a
    // slider drag after one step and blur a text field after one character.
    const focus = this.focus;
    const dragging = this.dragging;
    const picker = this.colorPicker;
    this.screen = screen;
    this.showActions = screen.showActions !== false;
    this.scroll = 0;
    this.hover = null;
    this.pressed = null;
    this.dragging = dragging && this.rowById(dragging) ? dragging : null;
    this.focus = focus && this.rowById(focus) ? focus : null;
    if (picker && !this.rowById(picker.id)) this.colorPicker = null;
    if (this.dropdown) {
      const botId = this.dropdown.id.replace(/^agent:/, '').split(':')[0];
      if (!this.rowById(botId)) this.dropdown = null;
    }
    this.bump();
  }

  /** Toggle the shared action column without rebuilding the screen. */
  setActions(on: boolean): void {
    if (this.showActions !== on) {
      this.showActions = on;
      this.bump();
    }
  }

  setCrumbs(crumbs: { label: string; current: boolean }[]): void {
    this.crumbs = crumbs;
    this.bump();
  }

  setCaret(on: boolean): void {
    if (this.caretOn !== on) {
      this.caretOn = on;
      this.bump();
    }
  }

  /** Re-render on external state changes (options values, loading, …). */
  bump(): void {
    this.version = nextUiVersion();
  }

  /** Frame-loop hook: follow a party-mode hue without repainting a static
   *  menu every frame. */
  syncAccent(now: number): void {
    if (now - this.lastAccentCheck < 120) return;
    this.lastAccentCheck = now;
    const painted = this.paintedAccent;
    if (painted && !accentMoved(currentPlayerAccent(), painted)) return;
    this.bump();
  }

  /** Full menu plane kept sharp by the renderer's focus veil. Boot
   *  wordmarks have no panels, so they have no UI island (and no frame). */
  focusRect(w: number, h: number): { x: number; y: number; w: number; h: number } | null {
    if (this.screen.empty || this.screen.wordmark) return null;
    return contentFocusRect(w, h);
  }

  // -------------------------------------------------------------- textures
  private image(name: string): HTMLImageElement | null {
    const url = TEX_BASE + name;
    let img = imageCache.get(url);
    if (img) return img.complete && img.naturalWidth > 0 ? img : null;
    if (imagePending.has(url)) return null;
    imagePending.add(url);
    if (imageCache.size > 64) {
      const first = imageCache.keys().next();
      if (!first.done) imageCache.delete(first.value);
    }
    img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      imagePending.delete(url);
      this.onImageLoad();
    };
    img.onerror = () => imagePending.delete(url);
    img.src = url;
    imageCache.set(url, img);
    return null;
  }

  // -------------------------------------------------------------- painting
  paint(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    try {
      this.paintInner(ctx, w, h);
      this.lastError = null;
    } catch (e) {
      this.lastError = String((e as Error)?.message ?? e);
      throw e;
    }
  }

  private paintInner(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    this.ctx = ctx;
    this.logical = { w, h };
    this.accent = currentPlayerAccent();
    this.accentText = readableAccent(this.accent);
    this.paintedAccent = [this.accent[0], this.accent[1], this.accent[2]];
    const s = Math.min(w / DW, h / DH);
    const ox = (w - DW * s) / 2;
    const oy = (h - DH * s) / 2;
    const X = (x: number): number => ox + x * s;
    const Y = (y: number): number => oy + y * s;
    const U = (u: number): number => u * s;
    const contentW = contentWidth(this.showActions);
    this.regions = [];
    this.contentBottom = 0;
    ctx.clearRect(0, 0, w, h);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    // Same dim as the multiplayer lobby: the 3D menu background stays visible.
    ctx.fillStyle = 'rgba(4, 8, 14, 0.42)';
    ctx.fillRect(0, 0, w, h);

    if (this.screen.wordmark) this.paintWordmark(ctx, s, X, Y, U);
    if (!this.screen.wordmark && !this.screen.empty) {
      // One maximised content rectangle fills everything left of the action
      // column, from the top edge to the bottom. The path navbar lives inside
      // it at the top; screens never draw nested panel boxes, so the chrome is
      // identical to the lobby and room.
      paintContentShell(ctx, s, X, Y, U, contentW);
      this.paintPath(ctx, s, X, Y, U, contentW);
    }

    if (!this.screen.empty && !this.screen.wordmark) {
      // The generic plane can hide the action column (game/HUD mode). The
      // content then expands into the freed eighth instead of leaving a hole.
      const hasTabs = !!(this.screen.tabs && this.screen.tabs.length > 0);
      if (hasTabs) this.paintTabs(ctx, s, X, Y, U);
      const panelY = PANEL_Y + (hasTabs ? TAB_H : 0);
      const panelH = PANEL_H - (hasTabs ? TAB_H : 0);
      const panelW = (contentW - CONTENT_MARGIN * 2 - PANEL_GAP) / 2;
      const singleW = contentW - CONTENT_MARGIN * 2;
      const leftX = (index: 0 | 1): number =>
        CONTENT_X + CONTENT_MARGIN + index * (panelW + PANEL_GAP);
      const singleX = (width: number): number =>
        CONTENT_X + Math.round((contentW - width) / 2);
      const both = !!(this.screen.left && this.screen.right);
      const columns: Column[] = [];
      if (both) {
        columns.push({ panel: this.screen.left!, x: leftX(0), y: panelY, w: panelW, h: panelH });
        columns.push({ panel: this.screen.right!, x: leftX(1), y: panelY, w: panelW, h: panelH });
      } else {
        const only = this.screen.left ?? this.screen.right;
        if (only) columns.push({ panel: only, x: singleX(singleW), y: panelY, w: singleW, h: panelH });
      }
      for (const col of columns) this.paintPanel(ctx, col, s, X, Y, U);
    }

    // Right action column (1/8 of the width): primary + context actions +
    // back, plus the fullscreen toggle. Boot/splash screens keep only the
    // toggle; the game/HUD mode toggles the whole column off.
    if (this.showActions) {
      this.regions.push(...paintActionColumn(ctx, s, X, Y, U, {
        primary: !this.screen.hideChrome && this.screen.primary
          ? { id: 'primary', label: this.screen.primary.label } : undefined,
        actions: this.screen.hideChrome ? undefined : this.screen.actions,
        back: this.screen.hideChrome ? undefined : { id: 'back', label: this.screen.backLabel ?? 'back' },
        hover: this.hover,
        chrome: !this.screen.hideChrome,
        accent: this.accent,
      }));
    }
    if (this.colorPicker) this.paintColorPicker(ctx, s, X, Y, U);
    if (this.dropdown) this.paintDropdown(ctx, s, X, Y, U);
  }

  /**
   * Clickable navigation path in the shared navbar. The old pilot/version
   * subtitle is gone, and this screen title no longer eats into the icons.
   */
  private paintPath(
    ctx: CanvasRenderingContext2D, s: number,
    X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
    width = CONTENT_W,
  ): void {
    const crumbs = this.crumbs.length
      ? this.crumbs
      : this.screen.title ? [{ label: this.screen.title, current: true }] : [];
    this.regions.push(...paintNavbar(
      ctx, s, X, Y, U, crumbs, this.hover, this.accent, width, satsLabel(store.sats),
    ));
  }

  /** Palette modal for a `color` row. The swatch regions are published after
   *  the normal screen regions, so they win hit-testing over the row beneath. */
  private paintColorPicker(
    ctx: CanvasRenderingContext2D, s: number,
    X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  ): void {
    const picker = this.colorPicker;
    if (!picker) return;
    // Full-screen backdrop: clicking outside the palette closes it and blocks
    // the rows underneath.
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(0, 0, this.logical.w, this.logical.h);
    this.regions.push({
      id: 'color:backdrop', x: 0, y: 0, w: this.logical.w, h: this.logical.h,
    });
    const w = 520, h = 440;
    const x = (DW - w) / 2, y = (DH - h) / 2;
    const bx = X(x), by = Y(y), bw = U(w), bh = U(h);
    ctx.fillStyle = 'rgba(7, 13, 21, 0.97)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = cssColor(this.accent, 0.5);
    ctx.lineWidth = Math.max(1, s);
    ctx.strokeRect(bx, by, bw, bh);
    ctx.font = `700 ${U(20)}px ${FONT}`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.fillText(picker.label.toUpperCase(), X(x + 26), Y(y + 36));
    ctx.font = `${U(13)}px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText('choose a colour swatch', X(x + 26), Y(y + 59));
    // Close cross.
    const cbx = X(x + w - 42), cby = Y(y + 18), cbs = U(24);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = Math.max(1, U(2));
    ctx.beginPath();
    ctx.moveTo(cbx + U(6), cby + U(6));
    ctx.lineTo(cbx + cbs - U(6), cby + cbs - U(6));
    ctx.moveTo(cbx + cbs - U(6), cby + U(6));
    ctx.lineTo(cbx + U(6), cby + cbs - U(6));
    ctx.stroke();
    this.regions.push({ id: 'color:close', x: cbx, y: cby, w: cbs, h: cbs });
    // Six columns of six swatches.
    const cols = 6, sw = 48, gap = 8;
    const gridW = cols * sw + (cols - 1) * gap;
    const gx = x + (w - gridW) / 2;
    const gy = y + 84;
    const selected = normalizeHexColor(picker.value, '');
    for (let i = 0; i < COLOR_PALETTE.length; i++) {
      const color = COLOR_PALETTE[i];
      const cx = gx + (i % cols) * (sw + gap);
      const cy = gy + Math.floor(i / cols) * (sw + gap);
      const sx = X(cx), sy = Y(cy), size = U(sw);
      ctx.fillStyle = color;
      ctx.fillRect(sx, sy, size, size);
      const isSelected = color === selected;
      const hovered = this.hover === `color:${picker.id}:${color}`;
      ctx.strokeStyle = isSelected
        ? cssColor(this.accentText)
        : hovered ? cssColor(this.accent) : 'rgba(255,255,255,0.22)';
      ctx.lineWidth = Math.max(1, U(isSelected ? 3 : 1));
      ctx.strokeRect(sx, sy, size, size);
      if (isSelected) {
        ctx.beginPath();
        ctx.arc(sx + size / 2, sy + size / 2, U(6), 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(1, U(2));
        ctx.stroke();
      }
      this.regions.push({ id: `color:${picker.id}:${color}`, x: sx, y: sy, w: size, h: size });
    }
    ctx.font = `${U(12)}px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.textAlign = 'center';
    ctx.fillText('click outside to cancel', X(x + w / 2), Y(y + h - 20));
    ctx.textAlign = 'left';
  }

  /** Generic list dropdown for an agent AI/TEAM chip. */
  private paintDropdown(
    ctx: CanvasRenderingContext2D, s: number,
    X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  ): void {
    const dd = this.dropdown;
    if (!dd) return;
    // Backdrop: a click outside the list closes it and blocks the rows below.
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, this.logical.w, this.logical.h);
    this.regions.push({ id: 'dropdown:backdrop', x: 0, y: 0, w: this.logical.w, h: this.logical.h });
    const rowH = U(26);
    const pad = U(4);
    const h = optionListHeight(dd.options.length, rowH, pad);
    const w = Math.max(dd.anchor.w, U(150));
    let x = dd.anchor.x;
    if (x + w > this.logical.w) x = Math.max(0, this.logical.w - w);
    let top = dd.anchor.y + dd.anchor.h + U(4);
    if (top + h > this.logical.h) top = Math.max(0, dd.anchor.y - h - U(4));
    const rects = paintOptionList({
      ctx, x, y: top, w, h, options: dd.options, value: dd.value,
      hoverPrefix: 'dropdown:', hover: this.hover,
      rowH, padding: pad, fontPx: U(13), font: FONT,
      accent: this.accent, accentText: this.accentText, lineWidth: s,
    });
    rects.forEach((r, i) => {
      this.regions.push({ id: 'dropdown:' + i, x: r.x, y: r.y, w: r.w, h: r.h });
    });
  }

  private paintWordmark(
    ctx: CanvasRenderingContext2D, s: number,
    X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  ): void {
    const text = this.screen.wordmark;
    if (text) {
      // Same place and proportions as the old 512x128 bitmap wordmarks (their
      // glyphs were ~508x37 at y=51..88), but rendered as text in Airstrike.
      // Boot/start wordmarks are standalone splash art, not menu content:
      // centre them on the whole design plane rather than the menu rectangle.
      const cx = X(MENU_W / 2);
      const cy = Y(280);
      const chars = [...text];
      let size = U(64);
      let tracking = U(4);
      ctx.font = wordmarkFont(size);
      let widths = chars.map((ch) => ctx.measureText(ch).width);
      const width = (): number =>
        widths.reduce((a, b) => a + b, 0) + tracking * Math.max(0, chars.length - 1);
      // Never overflow the 1280-wide design canvas.
      if (width() > U(760)) {
        const k = U(760) / width();
        size *= k;
        tracking *= k;
        ctx.font = wordmarkFont(size);
        widths = chars.map((ch) => ctx.measureText(ch).width);
      }
      const total = width();
      // Brushed-metal fill: light top, grey waist, light bottom (the bitmap's
      // look), with a soft drop shadow for the dark space background.
      const grad = ctx.createLinearGradient(0, cy - size * 0.6, 0, cy + size * 0.6);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.42, '#d7dfe6');
      grad.addColorStop(0.58, '#8f9dab');
      grad.addColorStop(1, '#eef3f7');
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = U(10);
      ctx.shadowOffsetY = U(3);
      ctx.fillStyle = grad;
      let x = cx - total / 2;
      for (let i = 0; i < chars.length; i++) {
        ctx.fillText(chars[i], x + widths[i] / 2, cy);
        x += widths[i] + tracking;
      }
      ctx.restore();
    }
    if (this.screen.loading) {
      const done = this.screen.loading.done;
      const total = this.screen.loading.total;
      const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
      const bw = U(420), bh = U(14);
      const bx = X(CONTENT_CX) - bw / 2;
      const by = Y(420);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(bx - U(10), by - U(34), bw + U(20), U(86));
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = Math.max(1, s);
      ctx.strokeRect(bx - U(10), by - U(34), bw + U(20), U(86));
      ctx.font = `700 ${U(15)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText('loading', X(CONTENT_CX), by - U(14));
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = cssColor(this.accent);
      ctx.fillRect(bx, by, (bw * pct) / 100, bh);
      ctx.font = `${U(13)}px ${FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText(total > 0 ? `${done} / ${total}` : `${done} / …`, X(CONTENT_CX), by + U(28));
      ctx.textAlign = 'left';
    }
  }

  /** Tab bar above the content panels (Options: Settings / Controls). */
  private paintTabs(
    ctx: CanvasRenderingContext2D, s: number,
    X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  ): void {
    const tabs = this.screen.tabs ?? [];
    if (tabs.length === 0) return;
    const y = PANEL_Y;
    const h = TAB_H - 12;
    let x = CONTENT_X + CONTENT_MARGIN;
    ctx.textAlign = 'center';
    for (const tab of tabs) {
      ctx.font = `700 ${U(15)}px ${FONT}`;
      const tw = Math.max(150, ctx.measureText(tab.label).width / s + 52);
      const bx = X(x), by = Y(y), bw = U(tw), bh = U(h);
      const hot = this.hover === tab.id;
      if (tab.active) {
        ctx.fillStyle = cssColor(this.accent, hot ? 0.34 : 0.24);
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeStyle = cssColor(this.accent, 0.9);
      } else {
        ctx.fillStyle = hot ? 'rgba(14,20,30,0.8)' : 'rgba(10,14,22,0.55)';
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      }
      ctx.lineWidth = Math.max(1, s);
      ctx.strokeRect(bx, by, bw, bh);
      ctx.font = `700 ${U(15)}px ${FONT}`;
      ctx.fillStyle = tab.active ? cssColor(this.accentText) : 'rgba(255,255,255,0.65)';
      ctx.fillText(tab.label, X(x + tw / 2), Y(y + h / 2 + 1));
      this.regions.push({ id: tab.id, x: bx, y: by, w: bw, h: bh });
      x += tw + 8;
    }
    ctx.textAlign = 'left';
  }

  private paintPanel(
    ctx: CanvasRenderingContext2D, col: Column, s: number,
    X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  ): void {
    const p = col.panel;
    if (p.watermark) {
      const img = this.image(p.watermark);
      if (img) {
        ctx.globalAlpha = 0.18;
        const size = U(300);
        ctx.drawImage(img, X(col.x + col.w / 2) - size / 2, Y(col.y + col.h / 2) - size / 2, size, size);
        ctx.globalAlpha = 1;
      }
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(X(col.x + 4), Y(col.y + 4), U(col.w - 8), U(col.h - 8));
    ctx.clip();
    ctx.translate(0, -U(this.scroll));
    let y = col.y + 22;
    if (p.heading) {
      ctx.font = `700 ${U(19)}px ${FONT}`;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(p.heading, X(col.x + 20), Y(y + 4));
      y += 34;
    }
    if (p.icons) y = this.paintIcons(ctx, p.icons, col, y, s, X, Y, U);
    if (p.buttons) y = this.paintButtons(ctx, p.buttons, col, y, s, X, Y, U);
    if (p.table) y = this.paintTable(ctx, p.table, col, y, s, X, Y, U);
    if (p.lines) y = this.paintLines(ctx, p.lines, col, y, s, X, Y, U);
    if (p.rows) {
      // Spread a short list over the enlarged panel instead of leaving a large
      // empty tail; info rows still keep their compact vertical rhythm.
      const available = col.h - 46 - (p.heading ? 34 : 0) - (p.footer ? 26 : 0);
      col.rowH = Math.max(34, Math.min(56, available / Math.max(1, p.rows.length)));
      for (const row of p.rows) {
        y = this.paintRow(ctx, row, col, y, s, X, Y, U);
      }
    }
    if (p.footer) {
      ctx.font = `${U(13)}px ${FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText(p.footer, X(col.x + 20), Y(col.y + col.h - 20));
    }
    this.contentBottom = Math.max(this.contentBottom, y);
    ctx.restore();
  }

  private paintIcons(
    ctx: CanvasRenderingContext2D, items: MenuIconItem[], col: Column, y: number, s: number,
    X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  ): number {
    const perRow = items.length <= 3 ? items.length : Math.ceil(items.length / 2);
    const cellW = (col.w - 40) / Math.max(1, perRow);
    // cellW is already in design pixels, so do not multiply by the canvas
    // scale again: that shrank the original icons twice on small screens.
    const iconSize = U(Math.min(160, cellW * 0.92));
    const rows = Math.ceil(items.length / perRow);
    const rowStep = iconSize / s + 52;
    // Balance the icon block in the taller panel when there is no heading.
    const startY = col.panel.heading ? y : col.y + (col.h - rows * rowStep) / 2;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const row = Math.floor(i / perRow);
      const colIdx = i % perRow;
      const cx = col.x + 20 + cellW * colIdx + cellW / 2;
      const cy = startY + row * rowStep + iconSize / s / 2;
      const img = item.icon ? this.image(item.icon) : null;
      if (img) {
        ctx.drawImage(img, X(cx) - iconSize / 2, Y(cy) - iconSize / 2, iconSize, iconSize);
      }
      ctx.font = `700 ${U(14)}px ${FONT}`;
      ctx.fillStyle = this.hover === item.id
        ? cssColor(this.accent)
        : cssColor(this.accentText, 0.9);
      ctx.textAlign = 'center';
      ctx.fillText(item.label, X(cx), Y(cy + iconSize / s / 2 + 18));
      ctx.textAlign = 'left';
      this.regions.push({
        id: item.id, x: X(cx) - iconSize / 2, y: Y(cy) - iconSize / 2,
        w: iconSize, h: iconSize + U(34),
      });
    }
    return startY + rows * rowStep + 6;
  }

  private paintButtons(
    ctx: CanvasRenderingContext2D, items: MenuIconItem[], col: Column, y: number, s: number,
    X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  ): number {
    const plate = this.image('_menubtn.png');
    for (const item of items) {
      const bw = col.w - 48, bh = 46;
      const bx = col.x + 24;
      if (plate) {
        ctx.globalAlpha = this.hover === item.id ? 1 : 0.92;
        ctx.drawImage(plate, X(bx), Y(y), U(bw), U(bh));
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = 'rgba(10,14,22,0.72)';
        ctx.fillRect(X(bx), Y(y), U(bw), U(bh));
      }
      ctx.strokeStyle = cssColor(this.accent, this.hover === item.id ? 0.7 : 0.3);
      ctx.lineWidth = Math.max(1, s);
      ctx.strokeRect(X(bx), Y(y), U(bw), U(bh));
      ctx.font = `700 ${U(17)}px ${FONT}`;
      ctx.textAlign = 'center';
      // The accent label sits on the pale plate: a dark outline keeps every
      // player colour (including white) readable.
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(4,8,14,0.72)';
      ctx.lineWidth = U(3);
      ctx.strokeText(item.label, X(bx + bw / 2), Y(y + bh / 2 + 1));
      ctx.fillStyle = cssColor(this.accentText);
      ctx.fillText(item.label, X(bx + bw / 2), Y(y + bh / 2 + 1));
      ctx.textAlign = 'left';
      this.regions.push({ id: item.id, x: X(bx), y: Y(y), w: U(bw), h: U(bh) });
      y += bh + 12;
    }
    return y;
  }

  private paintTable(
    ctx: CanvasRenderingContext2D, table: { title?: string; rows: string[] }, col: Column,
    y: number, s: number, X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  ): number {
    if (table.title) {
      ctx.font = `${U(14)}px ${FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillText(table.title, X(col.x + 20), Y(y));
      y += 22;
    }
    ctx.font = `${U(13)}px ${FONT}`;
    ctx.fillStyle = '#ffffff';
    for (const row of table.rows) {
      ctx.fillText(row, X(col.x + 20), Y(y));
      y += 19;
    }
    return y + 8;
  }

  private paintLines(
    ctx: CanvasRenderingContext2D, lines: PanelLine[], col: Column, y: number, s: number,
    X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  ): number {
    const maxW = U(col.w - 40);
    for (const line of lines) {
      if (line.gapBefore) y += line.gapBefore;
      if ('left' in line) {
        ctx.font = `${U(13)}px ${FONT}`;
        ctx.fillStyle = line.color ?? 'rgba(255,255,255,0.72)';
        ctx.textAlign = 'left';
        ctx.fillText(line.left, X(col.x + 20), Y(y));
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'right';
        ctx.fillText(line.right, X(col.x + col.w - 20), Y(y));
        ctx.textAlign = 'left';
        y += 19;
        continue;
      }
      const size = line.size ?? 13;
      ctx.font = `${line.bold ? '700 ' : ''}${U(size)}px ${FONT}`;
      ctx.fillStyle = line.color ?? '#ffffff';
      const align = line.align ?? 'left';
      ctx.textAlign = align;
      const x = align === 'center' ? X(col.x + col.w / 2)
        : align === 'right' ? X(col.x + col.w - 20) : X(col.x + 20);
      if (line.wrap) {
        const words = line.text.split(' ');
        let text = '';
        for (const word of words) {
          const next = text ? text + ' ' + word : word;
          if (ctx.measureText(next).width > maxW && text) {
            ctx.fillText(text, x, Y(y));
            y += size * 1.45;
            text = word;
          } else {
            text = next;
          }
        }
        if (text) {
          ctx.fillText(text, x, Y(y));
          y += size * 1.45;
        }
      } else {
        ctx.fillText(line.text, x, Y(y));
        y += size * 1.5;
      }
      ctx.textAlign = 'left';
    }
    return y;
  }

  private paintRow(
    ctx: CanvasRenderingContext2D, row: MenuRow, col: Column, y: number, s: number,
    X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  ): number {
    const labelX = X(col.x + 20);
    const valueRight = X(col.x + col.w - 20);
    const rowH = col.rowH ?? 34;
    const fs = Math.max(14, Math.min(18, rowH * 0.31));
    switch (row.kind) {
      case 'slider': {
        ctx.font = `${U(fs)}px ${FONT}`;
        ctx.fillStyle = 'rgba(255,255,255,0.72)';
        ctx.fillText(row.label, labelX, Y(y));
        // Track on the right: knob position + value.
        const tw = U(240), tx = valueRight - tw - U(74), ty = Y(y) - U(3);
        ctx.fillStyle = 'rgba(255,255,255,0.16)';
        ctx.fillRect(tx, ty, tw, U(6));
        const frac = row.max > row.min ? (row.value - row.min) / (row.max - row.min) : 0;
        const kx = tx + tw * Math.max(0, Math.min(1, frac));
        ctx.fillStyle = cssColor(this.accent);
        ctx.fillRect(tx, ty, kx - tx, U(6));
        ctx.beginPath();
        ctx.arc(kx, ty + U(3), U(8), 0, Math.PI * 2);
        ctx.fillStyle = cssColor(this.accentText);
        ctx.fill();
        ctx.font = `${U(Math.max(13, fs - 1))}px ${FONT}`;
        ctx.textAlign = 'right';
        ctx.fillStyle = cssColor(this.accentText);
        ctx.fillText(row.display(row.value), valueRight, Y(y));
        ctx.textAlign = 'left';
        this.regions.push({
          id: 'row:' + row.id, x: tx - U(8), y: ty - U(14), w: tw + U(16), h: U(32),
        });
        return y + rowH;
      }
      case 'check': {
        ctx.font = `${U(fs)}px ${FONT}`;
        ctx.fillStyle = 'rgba(255,255,255,0.72)';
        ctx.fillText(row.label, labelX, Y(y));
        const box = U(Math.max(18, Math.min(24, rowH * 0.42)));
        const bx = valueRight - box, by = Y(y) - box / 2;
        ctx.strokeStyle = cssColor(this.accent, 0.55);
        ctx.lineWidth = Math.max(1, s);
        ctx.strokeRect(bx, by, box, box);
        if (row.value) {
          ctx.fillStyle = cssColor(this.accent);
          const ball = box - U(8);
          ctx.beginPath();
          ctx.arc(bx + box / 2, by + box / 2, ball / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        this.regions.push({ id: 'row:' + row.id, x: bx - U(10), y: Y(y) - U(16), w: box + U(20), h: U(32) });
        return y + rowH;
      }
      case 'text': {
        ctx.font = `${U(fs)}px ${FONT}`;
        ctx.fillStyle = 'rgba(255,255,255,0.72)';
        ctx.fillText(row.label, labelX, Y(y));
        const w = U(280), h = U(Math.max(28, Math.min(38, rowH - 10)));
        const bx = valueRight - w, by = Y(y) - h / 2;
        const focused = this.focus === row.id;
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(bx, by, w, h);
        ctx.strokeStyle = focused ? cssColor(this.accent, 0.85) : 'rgba(255,255,255,0.25)';
        ctx.strokeRect(bx, by, w, h);
        ctx.font = `${U(Math.max(15, fs))}px ${FONT}`;
        ctx.fillStyle = cssColor(this.accentText);
        ctx.fillText(row.value, bx + U(8), Y(y));
        if (focused && this.caretOn) {
          const tw = ctx.measureText(row.value).width;
          ctx.fillStyle = cssColor(this.accentText);
          ctx.fillRect(bx + U(8) + tw + U(2), Y(y) - U(9), Math.max(1, s), U(18));
        }
        this.regions.push({ id: 'row:' + row.id, x: bx, y: by, w, h });
        return y + rowH;
      }
      case 'color': {
        const hovered = this.hover === 'row:' + row.id;
        ctx.font = `${U(fs)}px ${FONT}`;
        ctx.fillStyle = hovered ? cssColor(this.accent) : 'rgba(255,255,255,0.72)';
        ctx.fillText(row.label, labelX, Y(y));
        const sw = U(28), sh = U(Math.max(16, Math.min(22, rowH * 0.4)));
        const sx = valueRight - sw, sy = Y(y) - sh / 2;
        ctx.fillStyle = normalizeHexColor(row.value, DEFAULT_PLAYER_COLOR);
        ctx.fillRect(sx, sy, sw, sh);
        ctx.strokeStyle = 'rgba(255,255,255,0.65)';
        ctx.lineWidth = Math.max(1, s);
        ctx.strokeRect(sx, sy, sw, sh);
        ctx.font = `${U(12)}px ${FONT}`;
        ctx.fillStyle = cssColor(this.accentText, 0.72);
        ctx.textAlign = 'right';
        ctx.fillText(normalizeHexColor(row.value, DEFAULT_PLAYER_COLOR), sx - U(9), Y(y));
        ctx.textAlign = 'left';
        this.regions.push({
          id: 'row:' + row.id, x: labelX, y: Y(y) - U(16), w: valueRight - labelX, h: U(32),
        });
        return y + rowH;
      }
      case 'button': {
        const bh = U(Math.max(32, Math.min(44, rowH - 10)));
        const bw = U(col.w - 48);
        const bx = X(col.x + 24);
        const disabled = row.disabled === true;
        const hovered = !disabled && this.hover === 'row:' + row.id;
        ctx.fillStyle = disabled
          ? 'rgba(10,14,22,0.4)'
          : hovered ? cssColor(this.accent, 0.18) : 'rgba(10,14,22,0.72)';
        ctx.fillRect(bx, Y(y) - bh / 2, bw, bh);
        ctx.strokeStyle = disabled
          ? 'rgba(255,255,255,0.1)'
          : cssColor(this.accent, hovered ? 0.55 : 0.28);
        ctx.strokeRect(bx, Y(y) - bh / 2, bw, bh);
        ctx.font = `700 ${U(Math.max(13, fs - 1))}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillStyle = disabled ? 'rgba(255,255,255,0.35)' : cssColor(this.accentText);
        const text = row.value ? `${row.label}  ·  ${row.value}` : row.label;
        ctx.fillText(text, bx + bw / 2, Y(y) + 1);
        ctx.textAlign = 'left';
        if (!disabled) {
          this.regions.push({ id: 'row:' + row.id, x: bx, y: Y(y) - bh / 2, w: bw, h: bh });
        }
        return y + rowH + 6;
      }
      case 'select': {
        ctx.font = `${U(fs)}px ${FONT}`;
        ctx.fillStyle = 'rgba(255,255,255,0.72)';
        ctx.fillText(row.label, labelX, Y(y));
        const bh = U(Math.max(24, Math.min(30, rowH - 8)));
        const bw = U(160);
        const bx = valueRight - bw;
        paintChip({
          ctx, x: bx, y: Y(y) - bh / 2, w: bw, h: bh,
          text: optionLabel(row.options, row.value),
          hovered: this.hover === 'row:' + row.id,
          accent: this.accent, accentText: this.accentText, lineWidth: s,
          fontPx: U(Math.max(12, Math.min(14, rowH * 0.32))), font: FONT,
        });
        this.regions.push({ id: 'row:' + row.id, x: bx, y: Y(y) - bh / 2, w: bw, h: bh });
        return y + rowH;
      }
      case 'agent': {
        const bh = U(Math.max(24, Math.min(30, rowH - 8)));
        const chipFont = Math.max(12, Math.min(14, rowH * 0.32));
        ctx.font = `700 ${U(fs)}px ${FONT}`;
        ctx.fillStyle = cssColor(this.accentText);
        ctx.fillText(row.name, labelX, Y(y));
        const removeW = U(24);
        const chipW = U(122);
        const gap = U(8);
        const removeX = valueRight - removeW;
        const teamX = removeX - gap - chipW;
        const aiX = teamX - gap - chipW;
        const chip = (x: number, w: number, text: string, cid: string): void => {
          paintChip({
            ctx, x, y: Y(y) - bh / 2, w, h: bh, text,
            hovered: this.hover === cid,
            accent: this.accent, accentText: this.accentText, lineWidth: s,
            fontPx: U(chipFont), font: FONT,
          });
          this.regions.push({ id: cid, x, y: Y(y) - bh / 2, w, h: bh });
        };
        const aiLabel = row.aiOptions.find((o) => o.value === row.ai)?.label ?? row.ai;
        const teamLabel = row.teamOptions.find((o) => o.value === row.team)?.label ?? row.team;
        chip(aiX, chipW, `AI: ${aiLabel}`, `agent:${row.id}:ai`);
        chip(teamX, chipW, `TEAM: ${teamLabel}`, `agent:${row.id}:team`);
        if (row.removable) {
          const hovered = this.hover === `agent:${row.id}:remove`;
          ctx.fillStyle = hovered ? 'rgba(130,36,28,0.6)' : 'rgba(70,18,18,0.42)';
          ctx.fillRect(removeX, Y(y) - bh / 2, removeW, bh);
          ctx.strokeStyle = 'rgba(255,122,82,0.5)';
          ctx.lineWidth = Math.max(1, s);
          ctx.strokeRect(removeX, Y(y) - bh / 2, removeW, bh);
          ctx.font = `700 ${U(15)}px ${FONT}`;
          ctx.fillStyle = '#ffb0a0';
          ctx.textAlign = 'center';
          ctx.fillText('×', removeX + removeW / 2, Y(y) + 1);
          ctx.textAlign = 'left';
          this.regions.push({
            id: `agent:${row.id}:remove`, x: removeX, y: Y(y) - bh / 2, w: removeW, h: bh,
          });
        }
        return y + rowH;
      }
      case 'info': {
        ctx.font = `${U(row.small ? 13 : 14)}px ${FONT}`;
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.fillText(row.text, labelX, Y(y));
        return y + (row.small ? 20 : 22);
      }
    }
    return y + rowH;
  }

  // ---------------------------------------------------------------- input
  pointer(kind: 'move' | 'down' | 'up', x: number, y: number, cssW: number, cssH: number): boolean {
    const lx = x * (this.logical.w / Math.max(1, cssW));
    const ly = y * (this.logical.h / Math.max(1, cssH));
    const hit = this.hit(lx, ly);
    const id = hit?.id ?? null;
    if (kind === 'move') {
      if (this.dragging) {
        this.dragSlider(this.dragging, lx);
        return true;
      }
      if (id !== this.hover) {
        this.hover = id;
        this.bump();
      }
      return !!id;
    }
    if (kind === 'down') {
      if (!id) {
        if (this.focus) {
          this.focus = null;
          this.bump();
        }
        return false;
      }
      this.pressed = id;
      if (id.startsWith('row:')) {
        const rowId = id.slice(4);
        const row = this.rowById(rowId);
        if (row?.kind === 'slider') {
          this.dragging = rowId;
          this.dragSlider(rowId, lx);
        } else if (row?.kind === 'text') {
          this.focus = rowId;
          this.bump();
        }
      }
      this.bump();
      return true;
    }
    // up
    const pressed = this.pressed;
    this.pressed = null;
    if (this.dragging) {
      this.dragging = null;
      return true;
    }
    if (id && id === pressed) {
      this.activate(id);
      return true;
    }
    return !!id;
  }

  /** Stable clickable-region id for VR dwell target changes. */
  gazeTarget(x: number, y: number, cssW: number, cssH: number): string | null {
    const lx = x * (this.logical.w / Math.max(1, cssW));
    const ly = y * (this.logical.h / Math.max(1, cssH));
    return this.hit(lx, ly)?.id ?? null;
  }

  wheel(deltaY: number): boolean {
    const overflow = this.contentBottom - (PANEL_Y + PANEL_H);
    if (overflow <= 6) return false;
    const next = this.scroll + (deltaY > 0 ? 40 : -40);
    this.scroll = Math.max(0, Math.min(overflow, next));
    this.bump();
    return true;
  }

  /** Keyboard: returns true when the menu consumed the key. */
  key(e: KeyboardEvent): boolean {
    if (this.dropdown) {
      if (e.key === 'Escape') {
        this.dropdown = null;
        this.bump();
      }
      // Modal: never let the keys reach the screen behind the list.
      return true;
    }
    if (this.colorPicker) {
      if (e.key === 'Escape') this.closeColorPicker();
      // Modal: never let the keys reach the screen behind the palette.
      return true;
    }
    if (this.focus) {
      const row = this.rowById(this.focus);
      if (e.key === 'Escape' || e.key === 'Enter') {
        this.focus = null;
        this.bump();
        return true;
      }
      if (row?.kind === 'text') {
        if (e.key === 'Backspace') {
          this.cb.onChange(row.id, row.value.slice(0, -1));
          this.bump();
          return true;
        }
        if (e.key.length === 1 && row.value.length < row.maxLength && !e.ctrlKey && !e.metaKey) {
          this.cb.onChange(row.id, row.value + e.key);
          this.bump();
          return true;
        }
      }
      return false;
    }
    if (e.key === 'Escape') {
      this.cb.onBack();
      return true;
    }
    if (e.key === 'Enter' && this.screen.primary) {
      this.cb.onPrimary();
      return true;
    }
    return false;
  }

  private rowById(id: string): MenuRow | null {
    for (const panel of [this.screen.left, this.screen.right]) {
      if (!panel?.rows) continue;
      for (const row of panel.rows) {
        if (row.kind !== 'info' && row.id === id) return row;
      }
    }
    return null;
  }

  private closeColorPicker(): void {
    if (!this.colorPicker) return;
    this.colorPicker = null;
    this.hover = null;
    this.bump();
  }

  private dragSlider(id: string, lx: number): void {
    const row = this.rowById(id);
    if (row?.kind !== 'slider') return;
    // Recover the track geometry from the last paint (regions are CSS-scaled).
    const reg = this.regions.find((r) => r.id === 'row:' + id);
    if (!reg) return;
    const frac = Math.max(0, Math.min(1, (lx - reg.x) / reg.w));
    const raw = row.min + frac * (row.max - row.min);
    const stepped = Math.round(raw / row.step) * row.step;
    const value = Math.max(row.min, Math.min(row.max, stepped));
    // The screen rebuilds with the new value; keep dragging across rebuilds.
    this.cb.onChange(row.id, Number(value.toFixed(4)));
  }

  private hit(x: number, y: number): Region | null {
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const r = this.regions[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
    }
    return null;
  }

  private activate(id: string): void {
    if (id === 'dropdown:backdrop') {
      this.dropdown = null;
      this.hover = null;
      this.bump();
      return;
    }
    if (id.startsWith('dropdown:')) {
      const i = Number(id.slice('dropdown:'.length));
      const dd = this.dropdown;
      if (dd && dd.options[i]) {
        const value = dd.options[i].value;
        this.dropdown = null;
        this.hover = null;
        this.bump();
        this.cb.onChange(dd.id, value);
      }
      return;
    }
    // Agent row: the AI/TEAM chips open a dropdown, the × removes the bot.
    const agentHit = /^agent:([^:]+):(ai|team|remove)$/.exec(id);
    if (agentHit) {
      const botId = agentHit[1];
      const field = agentHit[2];
      if (field === 'remove') {
        this.cb.onSelect(id);
        return;
      }
      const row = this.rowById(botId);
      if (row?.kind === 'agent') {
        const anchor = this.regions.find((r) => r.id === id);
        if (anchor) {
          this.dropdown = {
            id,
            options: field === 'ai' ? row.aiOptions : row.teamOptions,
            value: field === 'ai' ? row.ai : row.team,
            anchor,
          };
          this.hover = null;
          this.bump();
        }
      }
      return;
    }
    if (id === 'color:backdrop' || id === 'color:close') {
      this.closeColorPicker();
      return;
    }
    if (id.startsWith('color:')) {
      const [, rowId, color] = id.split(':');
      if (rowId && color) {
        this.closeColorPicker();
        this.cb.onChange(rowId, color);
      }
      return;
    }
    if (id === FS_REGION) {
      this.cb.onSelect('fs');
      return;
    }
    if (id === VR_REGION) {
      this.cb.onSelect('vr-toggle');
      return;
    }
    if (id === 'back') {
      this.cb.onBack();
      return;
    }
    if (id === 'primary') {
      this.cb.onPrimary();
      return;
    }
    if (id.startsWith('crumb:')) {
      this.cb.onCrumb(Number(id.slice(6)));
      return;
    }
    if (id.startsWith('row:')) {
      const rowId = id.slice(4);
      const row = this.rowById(rowId);
      if (row?.kind === 'check') this.cb.onChange(rowId, !row.value);
      else if (row?.kind === 'button') this.cb.onSelect(rowId);
      else if (row?.kind === 'select') {
        const anchor = this.regions.find((r) => r.id === id);
        if (anchor) {
          this.dropdown = { id: rowId, options: row.options, value: row.value, anchor };
          this.hover = null;
          this.bump();
        }
      } else if (row?.kind === 'color') {
        this.colorPicker = { id: row.id, label: row.label, value: row.value };
        this.hover = null;
        this.bump();
      }
      return;
    }
    this.cb.onSelect(id);
  }
}
