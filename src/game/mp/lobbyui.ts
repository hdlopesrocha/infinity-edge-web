// Multiplayer lobby, painted entirely into the WebGL frame (no DOM UI).
//
// The lobby owns its own state (open dropdown, scroll, hover) and draws
// through renderer.uiOverlay; the same computed regions are hit-tested from
// the view's pointer events. Rooms come from mp/manager.ts (Nostr), matches
// run in the browser that created the room (mp/host.ts). A hosted room
// survives leaving this menu, so the lobby also offers RETURN TO ROOM
// (mp.rejoinRoom) and an optional create/join password field.

import { CTF_LEVELS, KOTS_LEVELS, SURV_LEVELS, TT_GROUPS } from '../levels';
import { MAX_AGE_CHOICES, mp } from './manager';
import type { Multiplayer } from './manager';
import type { RoomInfo } from '../nostr/event';
import { nextUiVersion } from '../../engine/overlay';
import { FS_REGION, toggleFullscreen } from '../ui/fullscreen';
import { VR_REGION, clickVrToggle } from '../ui/vrchrome';
import type { Rgb } from '../colors';
import { satsLabel } from '../wallet';
import { store } from '../store';
import { cssColor, accentMoved, currentPlayerAccent, readableAccent } from '../ui/theme';
import {
  UI_FONT as FONT, CONTENT_CX, CONTENT_W, PANEL_W, PANEL_Y, PANEL_H, leftPanelX,
  paintActionColumn, paintContentShell, paintNavbar, contentFocusRect,
} from '../ui/layout';
import type { ScreenUi } from '../../engine/overlay';

export interface LobbyHooks {
  /** The player picked CREATE ROOM: publish the room and wait in its menu. */
  startHost(level: string, type: string, title: string, maxPlayers: number, password: string): void;
  /** The player picked JOIN on a listed room (password for a locked room). */
  join(room: RoomInfo, password?: string): void;
  /** The player deleted one of their own rooms. */
  deleteRoom(room: RoomInfo): void;
  /** Re-open the room this client is already hosting (kept alive on back). */
  reenter(): void;
  /** Leave the multiplayer screen (LIFO back). */
  back(): void;
}

interface Mode {
  id: string;
  label: string;
  levels: { key: string; label: string }[];
}

function prettyLevel(key: string): string {
  const parts = key.split('-');
  const last = parts[parts.length - 1];
  const cap = last.length === 2 && /^\d+$/.test(last) ? 'Track ' + last : last.charAt(0).toUpperCase() + last.slice(1);
  if (key.startsWith('kots')) return 'King of the System · ' + (key.includes('solo') ? 'Solo · ' : 'Teams · ') + cap;
  if (key.startsWith('surv')) return 'Survival · ' + (key.includes('solo') ? 'Solo · ' : 'Teams · ') + cap;
  if (key.startsWith('tt')) return 'Time Trial · ' + (key.includes('easy') ? 'Easy · ' : key.includes('normal') ? 'Normal · ' : 'Hard · ') + cap;
  if (key.startsWith('ctf')) return 'Capture the Flag · ' + cap;
  return cap;
}

const MODES: Mode[] = [
  { id: 'CTF', label: 'CAPTURE THE FLAG', levels: CTF_LEVELS.map((k) => ({ key: k, label: prettyLevel(k) })) },
  {
    id: 'TT',
    label: 'TIME TRIAL',
    levels: TT_GROUPS.flatMap((g) => g.tracks.map((k) => ({ key: k, label: prettyLevel(k) }))),
  },
  {
    id: 'KOTS',
    label: 'KING OF THE SYSTEM',
    levels: [...KOTS_LEVELS.teams, ...KOTS_LEVELS.solo].map((k) => ({ key: k, label: prettyLevel(k) })),
  },
  {
    id: 'SURV',
    label: 'SURVIVAL',
    levels: [...SURV_LEVELS.teams, ...SURV_LEVELS.solo].map((k) => ({ key: k, label: prettyLevel(k) })),
  },
];

const MAX_PLAYERS = [2, 4, 6, 8, 12, 16];
/** Design resolution the layout is authored in. */
const DW = 1280;
const DH = 720;

interface Region {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export class LobbyUi implements ScreenUi {
  version = nextUiVersion();
  /** Join progress, shown as a modal line (null = idle). */
  joining: string | null = null;
  /** Bumped from outside whenever the manager changes. */
  private hooks: LobbyHooks;
  private mp: Multiplayer;
  private ctx2: CanvasRenderingContext2D | null = null;
  private hover: string | null = null;
  private pressed: string | null = null;
  private openDropdown: string | null = null;
  private scroll = 0;
  private regions: Region[] = [];
  private logical = { w: DW, h: DH };
  /** Scroll-only region (the rooms list viewport). */
  private listBox = { x: 0, y: 0, w: 0, h: 0 };
  private typeIdx = 0;
  private levelIdx = 0;
  private maxIdx = 1;
  /** Create-room password ('' = unprotected). */
  private createPassword = '';
  /** Protected room waiting for a password (null = no prompt). */
  private joinTarget: RoomInfo | null = null;
  private joinPassword = '';
  /** Focused text field ('create-password' | 'join-password' | null). */
  private focusField: string | null = null;
  private caretOn = true;
  private accent: Rgb = currentPlayerAccent();
  private accentText: Rgb = readableAccent(this.accent);
  private paintedAccent: Rgb | null = null;
  private lastAccentCheck = 0;

  constructor(hooks: LobbyHooks, manager: Multiplayer = mp) {
    this.hooks = hooks;
    this.mp = manager;
  }

  /** Called on any external state change (manager notify, hover, …). */
  bump(): void {
    this.version = nextUiVersion();
  }

  /** Caret blink for the focused password field (driven by the view). */
  setCaret(on: boolean): void {
    if (this.caretOn !== on) {
      this.caretOn = on;
      this.bump();
    }
  }

  /** Follow a live party-mode accent without repainting a static lobby. */
  syncAccent(now: number): void {
    if (now - this.lastAccentCheck < 120) return;
    this.lastAccentCheck = now;
    const painted = this.paintedAccent;
    if (painted && !accentMoved(currentPlayerAccent(), painted)) return;
    this.bump();
  }

  /** Full menu plane kept sharp by the renderer's focus veil. */
  focusRect(w: number, h: number): { x: number; y: number; w: number; h: number } {
    return contentFocusRect(w, h);
  }

  // -------------------------------------------------------------- painting
  paint(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    this.ctx2 = ctx;
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
    this.regions = [];
    ctx.clearRect(0, 0, w, h);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    // Full-view dim so the WebGL background stays visible but the UI reads.
    // The same alpha and content rectangle as the menus, settings and room.
    ctx.fillStyle = 'rgba(4, 8, 14, 0.42)';
    ctx.fillRect(0, 0, w, h);
    paintContentShell(ctx, s, X, Y, U);

    // Shared navbar: the clickable path only (no pilot key, relay or guest
    // identity line), matching every other menu screen.
    this.regions.push(...paintNavbar(ctx, s, X, Y, U, [
      { label: 'MAIN MENU', current: false },
      { label: 'MULTIPLAYER', current: true },
    ], this.hover, this.accent, CONTENT_W, satsLabel(store.sats)));

    this.paintRooms(ctx, s, X, Y, U);
    this.paintCreate(ctx, s, X, Y, U);

    // Status line, bottom centre.
    const status = this.joining ? `connecting to ${this.joining}…`
      : this.mp.error ? this.mp.error
        : this.mp.status ? this.mp.status
          : 'rooms live on public Nostr relays: creating a room publishes it for everyone to see';
    ctx.textAlign = 'center';
    ctx.font = `${U(14)}px ${FONT}`;
    ctx.fillStyle = this.mp.error ? '#ff8a76' : this.joining ? '#ffd479' : 'rgba(255,255,255,0.55)';
    ctx.fillText(status, X(CONTENT_CX), Y(DH - 26));
    ctx.textAlign = 'left';

    // Right action column (1/8 of the width): create/refresh/close + back.
    this.regions.push(...paintActionColumn(ctx, s, X, Y, U, {
      primary: { id: 'create', label: 'CREATE ROOM' },
      actions: [
        { id: 'refresh', label: 'REFRESH' },
        // The hosted room survives leaving the room menu: re-open it here.
        ...(this.mp.hosting ? [{ id: 'return-room', label: 'RETURN TO ROOM' }] : []),
      ],
      back: { id: 'back', label: 'back' },
      hover: this.hover,
      accent: this.accent,
    }));

    // Open dropdown options last: they float above everything.
    if (this.openDropdown) this.paintDropdown(ctx, s, X, Y, U);
    // The password prompt floats above even the dropdowns.
    if (this.joinTarget) this.paintJoinPrompt(ctx, s, X, Y, U);
  }

  /** Draw `text` at the largest font size (down to `minPx`) that fits `maxW`. */
  private drawFitted(
    ctx: CanvasRenderingContext2D, text: string, x: number, y: number,
    maxW: number, U: (u: number) => number, startPx: number, minPx: number,
  ): void {
    let px = startPx;
    ctx.font = `${U(px)}px ${FONT}`;
    while (px > minPx && ctx.measureText(text).width > maxW) {
      px -= 0.5;
      ctx.font = `${U(px)}px ${FONT}`;
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x, y);
  }

  private paintRooms(
    ctx: CanvasRenderingContext2D, s: number,
    X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  ): void {
    const x0 = leftPanelX(0), y0 = PANEL_Y, w = PANEL_W, h = PANEL_H;
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${U(19)}px ${FONT}`;
    ctx.fillText('PUBLIC ROOMS', X(x0 + 20), Y(y0 + 26));
    // Filter dropdown (age) + count.
    const label = `younger than ${this.mp.config.maxAgeHours}h`;
    const fw = Math.max(U(150), ctx.measureText(label).width + U(40));
    this.button(ctx, X(x0 + w - 20) - fw, Y(y0 + 8), fw, U(30), `age · ${label}`, this.hover === 'dd:filter', s, 14, 'dd:filter');
    ctx.font = `${U(13)}px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText(`${this.mp.rooms.length} listed`, X(x0 + 20), Y(y0 + 48));

    // List viewport.
    const listY = y0 + 62;
    const listH = h - 62 - 18;
    this.listBox = { x: X(x0 + 12), y: Y(listY), w: U(w - 24), h: U(listH) };
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.listBox.x, this.listBox.y, this.listBox.w, this.listBox.h);
    ctx.clip();
    const rooms = this.mp.rooms;
    const rowH = 62;
    const content = Math.max(0, rooms.length * rowH + 8);
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, content - listH)));
    if (rooms.length === 0) {
      ctx.font = `${U(15)}px ${FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillText('no public rooms in this window —  press CREATE ROOM', X(x0 + 24), Y(listY + 30));
    }
    rooms.forEach((room, i) => {
      const ry = listY + 8 + i * rowH - this.scroll;
      if (ry > listY + listH || ry + rowH < listY) return;
      const own = room.hostPubkey === this.mp.pubkey;
      const dead = this.mp.deadRooms.has(room.hostPubkey + ':' + room.id);
      const rowId = 'room:' + room.hostPubkey + ':' + room.id;
      const hovered = this.hover === rowId;
      ctx.fillStyle = hovered ? cssColor(this.accent, 0.1) : i % 2 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.05)';
      ctx.fillRect(X(x0 + 16), Y(ry), U(w - 48) + U(16), U(rowH - 6));
      if (own) {
        ctx.fillStyle = cssColor(this.accent, 0.6);
        ctx.fillRect(X(x0 + 16), Y(ry), U(3), U(rowH - 6));
      }
      this.regions.push({ id: rowId, x: X(x0 + 16), y: Y(ry), w: U(w - 48) + U(16), h: U(rowH - 6) });
      ctx.font = `700 ${U(12)}px ${FONT}`;
      ctx.fillStyle = own ? cssColor(this.accentText) : 'rgba(255,200,120,0.95)';
      ctx.fillText(
        `${room.type || 'GAME'}${room.srv ? ' · SERVER' : ''}${own ? ' · YOURS' : ''}`
        + `${room.protected ? ' · LOCKED' : ''}${dead ? ' · OFFLINE?' : ''}`,
        X(x0 + 28), Y(ry + 15));
      ctx.font = `700 ${U(16)}px ${FONT}`;
      ctx.fillStyle = dead ? 'rgba(255,255,255,0.45)' : '#ffffff';
      ctx.fillText(clip(ctx, room.title, U(w - 260)), X(x0 + 28), Y(ry + 34));
      ctx.font = `${U(13)}px ${FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText(
        `${room.host} · ${room.players}/${room.maxPlayers} pilots · ${age(room.created)}`,
        X(x0 + 28), Y(ry + 51),
      );
      // Row buttons: DELETE + a JOINED badge for your own room (you are already
      // in it — clicking the row re-opens it), JOIN for everyone else's.
      // Their ids carry the room key (hostPubkey:roomId) directly.
      const bw = 92, bh = 30;
      const bx = x0 + w - bw - 22;
      const key = room.hostPubkey + ':' + room.id;
      if (own) {
        this.button(ctx, X(bx - bw - 8), Y(ry + 12), U(bw), U(bh), 'DELETE', this.hover === 'del:' + key, s, 13, 'del:' + key);
        // A static badge: the host is already in this room (the row re-opens it).
        this.button(ctx, X(bx), Y(ry + 12), U(bw), U(bh), 'JOINED', false, s, 13, undefined, false, true);
      } else {
        this.button(ctx, X(bx), Y(ry + 12), U(bw), U(bh), dead ? 'RETRY' : 'JOIN', this.hover === 'join:' + key, s, 14, 'join:' + key);
      }
    });
    ctx.restore();
    // Scrollbar.
    if (content > listH) {
      const trackH = U(listH);
      const knobH = Math.max(U(24), trackH * (listH / content));
      const knobY = this.listBox.y + (trackH - knobH) * (this.scroll / Math.max(1, content - listH));
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.fillRect(this.listBox.x + this.listBox.w - U(6), this.listBox.y, U(4), trackH);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(this.listBox.x + this.listBox.w - U(6), knobY, U(4), knobH);
    }
  }

  private paintCreate(
    ctx: CanvasRenderingContext2D, s: number,
    X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  ): void {
    const x0 = leftPanelX(1), y0 = PANEL_Y, w = PANEL_W, h = PANEL_H;
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${U(19)}px ${FONT}`;
    ctx.fillText('CREATE A ROOM', X(x0 + 20), Y(y0 + 26));

    const mode = MODES[this.typeIdx];
    const level = mode.levels[Math.min(this.levelIdx, mode.levels.length - 1)];
    const row = (i: number, label: string, value: string, id: string): void => {
      const ry = y0 + 68 + i * 62;
      ctx.font = `${U(14)}px ${FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText(label, X(x0 + 22), Y(ry + 1));
      const bw = w - 44;
      this.button(ctx, X(x0 + 22), Y(ry + 14), U(bw), U(34), value, this.hover === id, s, 16, id, this.openDropdown === id);
    };
    row(0, 'Game type', mode.label, 'dd:type');
    row(1, 'Level', level.label, 'dd:level');
    row(2, 'Room size', `${MAX_PLAYERS[this.maxIdx]} pilots`, 'dd:max');
    // Password field: empty publishes an open room; a value publishes only a
    // flag + salt and encrypts the signalling (see mp/crypto.ts).
    this.textField(ctx, s, X, Y, U, 3, 'Password (optional)', 'create-password',
      this.createPassword, 'leave empty for an open room', x0, w);

    // The CREATE ROOM action lives in the right column now.
    const cy = y0 + 68 + 4 * 62 + 2;
    ctx.font = `${U(14)}px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    wrap(ctx, this.createPassword
      ? 'a protected room: guests are asked for this password and all signalling is encrypted.'
      : 'press CREATE ROOM in the actions column to publish this room on Nostr and wait for guests.',
      X(x0 + 22), Y(cy), U(w - 44), U(20), ctx.fillStyle as string);

    if (this.mp.hosting) {
      ctx.font = `${U(13)}px ${FONT}`;
      ctx.fillStyle = 'rgba(255,212,121,0.9)';
      wrap(ctx, `hosting "${this.mp.hosting.title}" — guests join your match and fly with you.`,
        X(x0 + 22), Y(cy + 48), U(w - 44), U(18), ctx.fillStyle as string);
    }
  }

  /** Floating option list for the open dropdown. */
  private paintDropdown(
    ctx: CanvasRenderingContext2D, s: number,
    X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  ): void {
    const id = this.openDropdown!;
    const anchor = this.regions.find((r) => r.id === id);
    if (!anchor) {
      this.openDropdown = null;
      return;
    }
    const options = this.dropdownOptions(id);
    const rowH = Math.max(U(26), anchor.h);
    const height = Math.min(options.length * rowH + U(8), U(360));
    let y = anchor.y + anchor.h + U(4);
    if (y + height > this.logical.h) y = Math.max(0, anchor.y - height - U(4));
    ctx.fillStyle = 'rgba(6,10,16,0.94)';
    ctx.strokeStyle = cssColor(this.accent, 0.5);
    ctx.lineWidth = Math.max(1, U(1));
    ctx.fillRect(anchor.x, y, anchor.w, height);
    ctx.strokeRect(anchor.x, y, anchor.w, height);
    options.forEach((opt, i) => {
      const oy = y + U(4) + i * rowH;
      const rid = 'opt:' + id + ':' + opt.value;
      const hovered = this.hover === rid;
      if (hovered) {
        ctx.fillStyle = cssColor(this.accent, 0.16);
        ctx.fillRect(anchor.x + U(2), oy, anchor.w - U(4), rowH - U(2));
      }
      ctx.font = `700 ${U(14)}px ${FONT}`;
      ctx.fillStyle = opt.selected ? cssColor(this.accentText) : '#ffffff';
      ctx.fillText(clip(ctx, opt.label, anchor.w - U(20)), anchor.x + U(10), oy + rowH / 2);
      // Registered last: the dropdown wins hit testing over what it covers.
      this.regions.push({ id: rid, x: anchor.x, y: oy, w: anchor.w, h: rowH });
    });
  }

  private dropdownOptions(ddId: string): { label: string; value: string; selected: boolean }[] {
    if (ddId === 'dd:type') {
      return MODES.map((m, i) => ({ label: m.label, value: String(i), selected: i === this.typeIdx }));
    }
    if (ddId === 'dd:level') {
      const mode = MODES[this.typeIdx];
      return mode.levels.map((l, i) => ({ label: l.label, value: String(i), selected: i === this.levelIdx }));
    }
    if (ddId === 'dd:max') {
      return MAX_PLAYERS.map((n, i) => ({ label: `${n} pilots`, value: String(i), selected: i === this.maxIdx }));
    }
    if (ddId === 'dd:filter') {
      return MAX_AGE_CHOICES.map((h) => ({ label: `younger than ${h}h`, value: String(h), selected: h === this.mp.config.maxAgeHours }));
    }
    return [];
  }

  // --------------------------------------------------------------- drawing

  /** A labelled text input row (password). Registers its clickable region. */
  private textField(
    ctx: CanvasRenderingContext2D, s: number,
    X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
    rowIndex: number, label: string, id: string, value: string, placeholder: string,
    x0: number, w: number,
  ): void {
    const ry = PANEL_Y + 68 + rowIndex * 62;
    ctx.font = `${U(14)}px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText(label, X(x0 + 22), Y(ry + 1));
    const bw = w - 44;
    const bx = X(x0 + 22);
    const by = Y(ry + 14);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(bx, by, U(bw), U(34));
    const focused = this.focusField === id;
    ctx.strokeStyle = focused ? cssColor(this.accent, 0.85) : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = Math.max(1, s);
    ctx.strokeRect(bx, by, U(bw), U(34));
    ctx.font = `${U(15)}px ${FONT}`;
    ctx.fillStyle = value ? cssColor(this.accentText) : 'rgba(255,255,255,0.4)';
    // The password is masked, like any password field.
    const shown = value ? '•'.repeat(Math.min(value.length, 32)) : placeholder;
    ctx.fillText(shown, bx + U(10), by + U(17));
    if (focused && this.caretOn) {
      const tw = ctx.measureText(value ? shown : '').width;
      ctx.fillStyle = cssColor(this.accentText);
      ctx.fillRect(bx + U(10) + tw + U(2), by + U(9), Math.max(1, s), U(16));
    }
    this.regions.push({ id, x: bx, y: by, w: U(bw), h: U(34) });
  }

  /** Modal asking for a protected room's password before joining. */
  private paintJoinPrompt(
    ctx: CanvasRenderingContext2D, s: number,
    X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  ): void {
    const room = this.joinTarget;
    if (!room) return;
    ctx.fillStyle = 'rgba(2, 4, 8, 0.72)';
    ctx.fillRect(0, 0, this.logical.w, this.logical.h);
    // Swallow clicks on the backdrop (so the room list below is unreachable).
    this.regions.push({ id: 'join-prompt-bg', x: 0, y: 0, w: this.logical.w, h: this.logical.h });
    const pw = U(420), ph = U(210);
    const px = X(CONTENT_CX) - pw / 2;
    const py = Y(DH / 2) - ph / 2;
    ctx.fillStyle = 'rgba(6,10,16,0.97)';
    ctx.strokeStyle = cssColor(this.accent, 0.6);
    ctx.lineWidth = Math.max(1, U(1));
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeRect(px, py, pw, ph);
    ctx.textAlign = 'center';
    ctx.font = `700 ${U(17)}px ${FONT}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText('ROOM IS LOCKED', px + pw / 2, py + U(30));
    ctx.font = `${U(13)}px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText(clip(ctx, room.title || room.host, pw - U(40)), px + pw / 2, py + U(54));
    ctx.textAlign = 'left';
    // Password field.
    const fw = pw - U(48), fx = px + U(24), fy = py + U(78);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(fx, fy, fw, U(34));
    ctx.strokeStyle = this.focusField === 'join-password' ? cssColor(this.accent, 0.85) : 'rgba(255,255,255,0.3)';
    ctx.strokeRect(fx, fy, fw, U(34));
    ctx.font = `${U(15)}px ${FONT}`;
    ctx.fillStyle = this.joinPassword ? cssColor(this.accentText) : 'rgba(255,255,255,0.4)';
    const shown = this.joinPassword ? '•'.repeat(Math.min(this.joinPassword.length, 32)) : 'password';
    ctx.fillText(shown, fx + U(10), fy + U(17));
    if (this.focusField === 'join-password' && this.caretOn) {
      const tw = this.joinPassword ? ctx.measureText(shown).width : 0;
      ctx.fillStyle = cssColor(this.accentText);
      ctx.fillRect(fx + U(10) + tw + U(2), fy + U(9), Math.max(1, s), U(16));
    }
    this.regions.push({ id: 'join-password', x: fx, y: fy, w: fw, h: U(34) });
    // JOIN / CANCEL.
    this.button(ctx, px + U(24), py + U(132), (fw - U(12)) / 2, U(38), 'JOIN',
      this.hover === 'join-confirm', s, 15, 'join-confirm', false, true);
    this.button(ctx, px + U(24) + (fw - U(12)) / 2 + U(12), py + U(132), (fw - U(12)) / 2, U(38), 'CANCEL',
      this.hover === 'join-cancel', s, 15, 'join-cancel');
  }

  private button(
    ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
    label: string, hovered: boolean, s: number, size: number, id?: string, open = false, emphasis = false,
  ): void {
    const pressed = id !== undefined && this.pressed === id;
    ctx.fillStyle = emphasis
      ? cssColor(this.accent, hovered ? 0.32 : 0.18)
      : open
        ? cssColor(this.accent, 0.16)
        : (hovered ? cssColor(this.accent, 0.16) : 'rgba(10,14,22,0.72)');
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = emphasis
      ? cssColor(this.accent, 0.8)
      : open ? cssColor(this.accent, 0.6) : cssColor(this.accent, 0.24);
    ctx.lineWidth = Math.max(1, s);
    ctx.strokeRect(x, y, w, h);
    if (pressed) {
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(x, y, w, h);
    }
    ctx.font = `700 ${Math.round(size * s)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = cssColor(this.accentText);
    ctx.fillText(clip(ctx, label, w - 12 * s), x + w / 2, y + h / 2 + s);
    ctx.textAlign = 'left';
    if (id !== undefined) this.regions.push({ id, x, y, w, h });
  }

  // ---------------------------------------------------------------- input
  /** Pointer in CSS px of the canvas element; returns true when consumed. */
  pointer(kind: 'move' | 'down' | 'up', x: number, y: number, cssW: number, cssH: number): boolean {
    const lx = x * (this.logical.w / Math.max(1, cssW));
    const ly = y * (this.logical.h / Math.max(1, cssH));
    const hit = this.hit(lx, ly);
    const id = hit?.id ?? null;
    if (kind === 'move') {
      const overList = this.inBox(lx, ly);
      if (id !== this.hover) {
        this.hover = id;
        this.bump();
      }
      return !!id || overList;
    }
    if (kind === 'down') {
      this.pressed = id;
      // Clicking outside a text field blurs it (the caret stops blinking).
      if (this.focusField && id !== this.focusField) this.focusField = null;
      if (id) this.bump();
      return !!id;
    }
    // up
    const wasPressed = this.pressed;
    this.pressed = null;
    if (id && id === wasPressed) {
      this.activate(id);
      return true;
    }
    this.bump();
    return !!id;
  }

  /** Stable clickable-region id for VR dwell target changes. */
  gazeTarget(x: number, y: number, cssW: number, cssH: number): string | null {
    const lx = x * (this.logical.w / Math.max(1, cssW));
    const ly = y * (this.logical.h / Math.max(1, cssH));
    return this.hit(lx, ly)?.id ?? null;
  }

  wheel(deltaY: number, x: number, y: number, cssW: number, cssH: number): boolean {
    const lx = x * (this.logical.w / Math.max(1, cssW));
    const ly = y * (this.logical.h / Math.max(1, cssH));
    if (!this.inBox(lx, ly)) return false;
    this.scroll = Math.max(0, this.scroll + (deltaY > 0 ? 48 : -48));
    this.bump();
    return true;
  }

  private inBox(x: number, y: number): boolean {
    const b = this.listBox;
    return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
  }

  private hit(x: number, y: number): Region | null {
    // Later regions (dropdown options, floating) win.
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const r = this.regions[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
    }
    return null;
  }

  private activate(id: string): void {
    if (id === FS_REGION) {
      void toggleFullscreen().then(() => this.bump());
      return;
    }
    if (id === VR_REGION) {
      void clickVrToggle().then(() => this.bump());
      return;
    }
    if (id.startsWith('dd:')) {
      this.openDropdown = this.openDropdown === id ? null : id;
      this.bump();
      return;
    }
    if (id.startsWith('opt:dd:')) {
      const rest = id.slice('opt:'.length);
      const second = rest.indexOf(':', 'dd:'.length);
      const ddId = rest.slice(0, second);
      const value = rest.slice(second + 1);
      if (ddId === 'dd:type') {
        this.typeIdx = Number(value);
        this.levelIdx = 0;
      } else if (ddId === 'dd:level') {
        this.levelIdx = Number(value);
      } else if (ddId === 'dd:max') {
        this.maxIdx = Number(value);
      } else if (ddId === 'dd:filter') {
        this.mp.setMaxAge(Number(value));
      }
      this.openDropdown = null;
      this.bump();
      return;
    }
    if (id === 'create-password' || id === 'join-password') {
      this.focusField = id;
      this.bump();
      return;
    }
    if (id === 'join-confirm') {
      const room = this.joinTarget;
      const password = this.joinPassword;
      this.joinTarget = null;
      this.joinPassword = '';
      this.focusField = null;
      if (room) this.hooks.join(room, password);
      this.bump();
      return;
    }
    if (id === 'join-cancel') {
      this.joinTarget = null;
      this.joinPassword = '';
      this.focusField = null;
      this.bump();
      return;
    }
    if (id.startsWith('room:') || id.startsWith('join:') || id.startsWith('del:')) {
      const key = id.slice(id.indexOf(':') + 1).replace(/^room:/, '');
      const room = this.mp.rooms.find((r) => r.hostPubkey + ':' + r.id === key);
      if (!room) return;
      // Your own room: re-open it instead of connecting to yourself.
      if (room.hostPubkey === this.mp.pubkey && !id.startsWith('del:')) {
        this.hooks.reenter();
        return;
      }
      if (id.startsWith('del:')) this.hooks.deleteRoom(room);
      else if (room.protected) {
        // Locked room: ask for the password before connecting.
        this.joinTarget = room;
        this.joinPassword = '';
        this.focusField = 'join-password';
        this.bump();
      } else {
        this.hooks.join(room);
      }
      return;
    }
    if (id === 'create') {
      const mode = MODES[this.typeIdx];
      const level = mode.levels[Math.min(this.levelIdx, mode.levels.length - 1)];
      this.hooks.startHost(
        level.key, mode.id, level.label, MAX_PLAYERS[this.maxIdx], this.createPassword.trim());
      this.bump();
      return;
    }
    if (id === 'return-room') {
      this.hooks.reenter();
      return;
    }
    if (id === 'refresh') {
      this.mp.refreshRooms();
      this.mp.connect();
      this.bump();
      return;
    }
    if (id === 'back' || id === 'crumb:0') {
      this.hooks.back();
      return;
    }
  }

  /** Keyboard input for the focused password field. Returns true if consumed. */
  key(e: KeyboardEvent): boolean {
    // Escape closes an open join prompt even before its field is focused.
    if (!this.focusField && this.joinTarget && e.key === 'Escape') {
      this.joinTarget = null;
      this.joinPassword = '';
      this.bump();
      return true;
    }
    const field = this.focusField;
    if (!field) return false;
    const value = field === 'join-password' ? this.joinPassword : this.createPassword;
    if (e.key === 'Escape') {
      if (field === 'join-password') {
        this.joinTarget = null;
        this.joinPassword = '';
      }
      this.focusField = null;
      this.bump();
      return true;
    }
    if (e.key === 'Enter') {
      if (field === 'join-password') {
        const room = this.joinTarget;
        const password = this.joinPassword;
        this.joinTarget = null;
        this.joinPassword = '';
        this.focusField = null;
        if (room) this.hooks.join(room, password);
      } else {
        this.focusField = null;
      }
      this.bump();
      return true;
    }
    if (e.key === 'Backspace') {
      const next = value.slice(0, -1);
      if (field === 'join-password') this.joinPassword = next;
      else this.createPassword = next;
      this.bump();
      return true;
    }
    if (e.key.length === 1 && value.length < 64 && !e.ctrlKey && !e.metaKey) {
      if (field === 'join-password') this.joinPassword += e.key;
      else this.createPassword += e.key;
      this.bump();
      return true;
    }
    return false;
  }
}


function clip(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

function wrap(
  ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lineH: number, color: string,
): void {
  ctx.fillStyle = color;
  const words = text.split(' ');
  let line = '';
  let ly = y;
  for (const word of words) {
    const next = line ? line + ' ' + word : word;
    if (ctx.measureText(next).width > maxW && line) {
      ctx.fillText(line, x, ly);
      line = word;
      ly += lineH;
    } else {
      line = next;
    }
  }
  if (line) ctx.fillText(line, x, ly);
}

function age(created: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - created);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}
