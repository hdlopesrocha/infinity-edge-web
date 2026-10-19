// WebGL menu UI: every menu screen is painted into the WebGL frame (the same
// ScreenUi overlay the multiplayer lobby uses), so the menus need no DOM at
// all. The original menu art is used: 128/256 px icons, the `_menubtn` button
// plate, the logo and medal textures.
//
// The screens (src/game/ui/screens.ts) describe their content declaratively;
// this module lays it out, paints it, and routes pointer/keyboard input back
// as `onSelect` / `onChange` callbacks.

import { nextUiVersion } from '../../engine/overlay';
import { FS_REGION, paintFullscreenButton } from './fullscreen';
import type { ScreenUi } from '../../engine/overlay';

const FONT = "'DejaVu Sans','Segoe UI',Verdana,sans-serif";
const DW = 1280;
const DH = 720;
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
  | { kind: 'button'; id: string; label: string; value?: string }
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

export interface MenuScreen {
  /** Big title; empty string = no title (unknown route / boot chrome). */
  title: string;
  subtitle?: string;
  left?: MenuPanel;
  right?: MenuPanel;
  /** Canvas-painted background behind the panels (boot logos). */
  logo?: string;
  /** Loading bar (boot screens). */
  loading?: { done: number; total: number } | null;
  /** Primary corner button (save/start/menu); null = none. */
  primary?: { id: string; label: string };
  /** Corner back label (exit at the root, else back). */
  backLabel?: string;
  /** No panels at all (unknown route: only the chrome). */
  empty?: boolean;
  /** Splash screens (boot/engine/start) draw no corner buttons at all. */
  hideChrome?: boolean;
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
  private caretOn = true;
  private scroll = 0;
  private contentBottom = 0;
  private crumbs: { label: string; current: boolean }[] = [];
  private onImageLoad: () => void;

  constructor(screen: MenuScreen, cb: MenuCallbacks, onImageLoad: () => void) {
    this.screen = screen;
    this.cb = cb;
    this.onImageLoad = onImageLoad;
  }

  setScreen(screen: MenuScreen): void {
    this.screen = screen;
    this.scroll = 0;
    this.hover = null;
    this.pressed = null;
    this.dragging = null;
    this.focus = null;
    this.bump();
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
    const s = Math.min(w / DW, h / DH);
    const ox = (w - DW * s) / 2;
    const oy = (h - DH * s) / 2;
    const X = (x: number): number => ox + x * s;
    const Y = (y: number): number => oy + y * s;
    const U = (u: number): number => u * s;
    this.regions = [];
    this.contentBottom = 0;
    ctx.clearRect(0, 0, w, h);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    // Same dim as the multiplayer lobby: the 3D menu background stays visible.
    ctx.fillStyle = 'rgba(4, 8, 14, 0.42)';
    ctx.fillRect(0, 0, w, h);

    if (this.screen.logo) this.paintLogo(ctx, s, X, Y, U);
    if (this.screen.title) this.paintTitle(ctx, s, X, Y, U);

    if (!this.screen.empty && !this.screen.logo) {
      const both = !!(this.screen.left && this.screen.right);
      const columns: Column[] = [];
      if (both) {
        columns.push({ panel: this.screen.left!, x: 50, y: 104, w: 560, h: 512 });
        columns.push({ panel: this.screen.right!, x: 670, y: 104, w: 560, h: 512 });
      } else {
        const only = this.screen.left ?? this.screen.right;
        if (only) columns.push({ panel: only, x: 280, y: 104, w: 720, h: 512 });
      }
      for (const col of columns) this.paintPanel(ctx, col, s, X, Y, U);
    }

    if (!this.screen.hideChrome) this.paintChrome(ctx, s, X, Y, U);
    // Always available, including the boot/engine/start screens (hideChrome).
    this.paintFullscreen(ctx, s, X, Y, U);
  }

  private paintFullscreen(
    ctx: CanvasRenderingContext2D, s: number,
    X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  ): void {
    const size = U(44);
    const x = X(DW - 60);
    const y = Y(12);
    paintFullscreenButton(ctx, x, y, size, s, this.hover === FS_REGION);
    this.regions.push({ id: FS_REGION, x, y, w: size, h: size });
  }

  private paintTitle(
    ctx: CanvasRenderingContext2D, s: number,
    X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  ): void {
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${U(32)}px ${FONT}`;
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = U(8);
    ctx.fillText(this.screen.title, X(DW / 2), Y(34));
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(127,232,216,0.9)';
    ctx.fillRect(X(DW / 2 - 90), Y(54), U(180), U(2));
    if (this.screen.subtitle) {
      ctx.font = `${U(14)}px ${FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.fillText(this.screen.subtitle, X(DW / 2), Y(76));
    }
    ctx.textAlign = 'left';
  }

  private paintLogo(
    ctx: CanvasRenderingContext2D, s: number,
    X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  ): void {
    const img = this.image(this.screen.logo!);
    if (img) {
      const w = U(512 * 1.1), h = U(128 * 1.1);
      ctx.globalAlpha = 1;
      ctx.drawImage(img, X(DW / 2) - w / 2, Y(280) - h / 2, w, h);
    }
    if (this.screen.loading) {
      const done = this.screen.loading.done;
      const total = this.screen.loading.total;
      const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
      const bw = U(420), bh = U(14);
      const bx = X(DW / 2) - bw / 2;
      const by = Y(420);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(bx - U(10), by - U(34), bw + U(20), U(86));
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = Math.max(1, s);
      ctx.strokeRect(bx - U(10), by - U(34), bw + U(20), U(86));
      ctx.font = `700 ${U(15)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText('loading', X(DW / 2), by - U(14));
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = '#7fe8d8';
      ctx.fillRect(bx, by, (bw * pct) / 100, bh);
      ctx.font = `${U(13)}px ${FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText(total > 0 ? `${done} / ${total}` : `${done} / …`, X(DW / 2), by + U(28));
      ctx.textAlign = 'left';
    }
  }

  private paintPanel(
    ctx: CanvasRenderingContext2D, col: Column, s: number,
    X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  ): void {
    const p = col.panel;
    ctx.fillStyle = 'rgba(8,12,20,0.64)';
    ctx.fillRect(X(col.x), Y(col.y), U(col.w), U(col.h));
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = Math.max(1, s);
    ctx.strokeRect(X(col.x), Y(col.y), U(col.w), U(col.h));

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
    const iconSize = U(Math.min(120, cellW * s * 0.62));
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const row = Math.floor(i / perRow);
      const colIdx = i % perRow;
      const cx = col.x + 20 + cellW * colIdx + cellW / 2;
      const cy = y + row * (iconSize / s + 46) + iconSize / s / 2;
      const img = item.icon ? this.image(item.icon) : null;
      if (img) {
        ctx.drawImage(img, X(cx) - iconSize / 2, Y(cy) - iconSize / 2, iconSize, iconSize);
      }
      ctx.font = `700 ${U(13)}px ${FONT}`;
      ctx.fillStyle = this.hover === item.id ? '#7fe8d8' : 'rgba(255,255,255,0.85)';
      ctx.textAlign = 'center';
      ctx.fillText(item.label, X(cx), Y(cy + iconSize / s / 2 + 16));
      ctx.textAlign = 'left';
      this.regions.push({
        id: item.id, x: X(cx) - iconSize / 2, y: Y(cy) - iconSize / 2,
        w: iconSize, h: iconSize + U(30),
      });
    }
    const rows = Math.ceil(items.length / perRow);
    return y + rows * (iconSize / s + 46) + 6;
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
        ctx.strokeStyle = 'rgba(255,255,255,0.16)';
        ctx.strokeRect(X(bx), Y(y), U(bw), U(bh));
      }
      ctx.font = `700 ${U(17)}px ${FONT}`;
      ctx.fillStyle = '#0a0e16';
      ctx.textAlign = 'center';
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
    const rowH = 34;
    switch (row.kind) {
      case 'slider': {
        ctx.font = `${U(14)}px ${FONT}`;
        ctx.fillStyle = 'rgba(255,255,255,0.72)';
        ctx.fillText(row.label, labelX, Y(y));
        // Track on the right: knob position + value.
        const tw = U(190), tx = valueRight - tw - U(70), ty = Y(y) - U(3);
        ctx.fillStyle = 'rgba(255,255,255,0.16)';
        ctx.fillRect(tx, ty, tw, U(6));
        const frac = row.max > row.min ? (row.value - row.min) / (row.max - row.min) : 0;
        const kx = tx + tw * Math.max(0, Math.min(1, frac));
        ctx.fillStyle = '#7fe8d8';
        ctx.fillRect(tx, ty, kx - tx, U(6));
        ctx.beginPath();
        ctx.arc(kx, ty + U(3), U(7), 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.font = `${U(13)}px ${FONT}`;
        ctx.textAlign = 'right';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(row.display(row.value), valueRight, Y(y));
        ctx.textAlign = 'left';
        this.regions.push({
          id: 'row:' + row.id, x: tx - U(8), y: ty - U(12), w: tw + U(16), h: U(28),
        });
        return y + rowH;
      }
      case 'check': {
        ctx.font = `${U(14)}px ${FONT}`;
        ctx.fillStyle = 'rgba(255,255,255,0.72)';
        ctx.fillText(row.label, labelX, Y(y));
        const box = U(18);
        const bx = valueRight - box, by = Y(y) - box / 2;
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = Math.max(1, s);
        ctx.strokeRect(bx, by, box, box);
        if (row.value) {
          ctx.fillStyle = '#7fe8d8';
          const ball = box - U(8);
          ctx.beginPath();
          ctx.arc(bx + box / 2, by + box / 2, ball / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        this.regions.push({ id: 'row:' + row.id, x: bx - U(10), y: Y(y) - U(14), w: box + U(20), h: U(28) });
        return y + rowH;
      }
      case 'text': {
        ctx.font = `${U(14)}px ${FONT}`;
        ctx.fillStyle = 'rgba(255,255,255,0.72)';
        ctx.fillText(row.label, labelX, Y(y));
        const w = U(240), h = U(28);
        const bx = valueRight - w, by = Y(y) - h / 2;
        const focused = this.focus === row.id;
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(bx, by, w, h);
        ctx.strokeStyle = focused ? 'rgba(127,232,216,0.85)' : 'rgba(255,255,255,0.25)';
        ctx.strokeRect(bx, by, w, h);
        ctx.font = `${U(15)}px ${FONT}`;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(row.value, bx + U(8), Y(y));
        if (focused && this.caretOn) {
          const tw = ctx.measureText(row.value).width;
          ctx.fillRect(bx + U(8) + tw + U(2), Y(y) - U(8), Math.max(1, s), U(16));
        }
        this.regions.push({ id: 'row:' + row.id, x: bx, y: by, w, h });
        return y + rowH;
      }
      case 'button': {
        const bh = U(32);
        const bw = U(col.w - 48);
        const bx = X(col.x + 24);
        const hovered = this.hover === 'row:' + row.id;
        ctx.fillStyle = hovered ? 'rgba(255,255,255,0.16)' : 'rgba(10,14,22,0.72)';
        ctx.fillRect(bx, Y(y) - bh / 2, bw, bh);
        ctx.strokeStyle = 'rgba(255,255,255,0.16)';
        ctx.strokeRect(bx, Y(y) - bh / 2, bw, bh);
        ctx.font = `700 ${U(13)}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ffffff';
        const text = row.value ? `${row.label}  ·  ${row.value}` : row.label;
        ctx.fillText(text, bx + bw / 2, Y(y) + 1);
        ctx.textAlign = 'left';
        this.regions.push({ id: 'row:' + row.id, x: bx, y: Y(y) - bh / 2, w: bw, h: bh });
        return y + rowH + 6;
      }
      case 'info': {
        ctx.font = `${U(row.small ? 12 : 13)}px ${FONT}`;
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.fillText(row.text, labelX, Y(y));
        return y + (row.small ? 18 : 20);
      }
    }
    return y + rowH;
  }

  private paintChrome(
    ctx: CanvasRenderingContext2D, s: number,
    X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  ): void {
    const back = this.screen.backLabel ?? 'back';
    this.corner(ctx, X(0), Y(DH - 54), U(160), U(48), back, 'back', s);
    if (this.screen.primary) {
      this.corner(ctx, X(DW - 160), Y(DH - 54), U(160), U(48), this.screen.primary.label, 'primary', s);
    }
    // Breadcrumbs, bottom centre (same trail the DOM chrome used).
    if (this.crumbs.length > 1) {
      ctx.font = `${U(12)}px ${FONT}`;
      const full = this.crumbs.map((c) => c.label).join('  ›  ');
      let total = ctx.measureText(full).width;
      let x = X(DW / 2) - total / 2;
      const y = Y(DH - 30);
      for (let i = 0; i < this.crumbs.length; i++) {
        const c = this.crumbs[i];
        const label = c.label;
        const w = ctx.measureText(label).width;
        ctx.fillStyle = c.current ? 'rgba(255,255,255,0.45)' : 'rgba(127,232,216,0.85)';
        ctx.fillText(label, x, y);
        if (!c.current) {
          const id = 'crumb:' + i;
          this.regions.push({ id, x: x - U(4), y: y - U(10), w: w + U(8), h: U(20) });
        }
        x += w;
        if (i < this.crumbs.length - 1) {
          const sep = '  ›  ';
          ctx.fillStyle = 'rgba(255,255,255,0.3)';
          ctx.fillText(sep, x, y);
          x += ctx.measureText(sep).width;
        }
      }
      void total;
    }
  }

  private corner(
    ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
    label: string, id: string, s: number,
  ): void {
    const hovered = this.hover === id;
    ctx.fillStyle = hovered ? 'rgba(255,255,255,0.16)' : 'rgba(10,14,22,0.72)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = Math.max(1, s);
    ctx.strokeRect(x, y, w, h);
    ctx.font = `700 ${Math.round(15 * s)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, x + w / 2, y + h / 2 + s);
    ctx.textAlign = 'left';
    this.regions.push({ id, x, y, w, h });
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

  wheel(deltaY: number): boolean {
    const overflow = this.contentBottom - (104 + 512);
    if (overflow <= 6) return false;
    const next = this.scroll + (deltaY > 0 ? 40 : -40);
    this.scroll = Math.max(0, Math.min(overflow, next));
    this.bump();
    return true;
  }

  /** Keyboard: returns true when the menu consumed the key. */
  key(e: KeyboardEvent): boolean {
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
    if (id === FS_REGION) {
      this.cb.onSelect('fs');
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
      return;
    }
    this.cb.onSelect(id);
  }
}
