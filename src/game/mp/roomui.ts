// Waiting-room menu, painted into the WebGL frame (like the lobby): the host
// opens it by creating a room, guests land here after joining, and the match
// starts only when the host presses PLAY. It carries the roster with per-player
// team pickers, a chat (text over the data channels) and a microphone toggle
// (voice PCM over the same channels — the capture lives in the room view).

import { nextUiVersion } from '../../engine/overlay';
import type { ScreenUi } from '../../engine/overlay';
import type { RoomSnapshot } from './manager';
import { teamDisplayName } from '../team';
import { FS_REGION, toggleFullscreen } from '../ui/fullscreen';
import { VR_REGION, clickVrToggle } from '../ui/vrchrome';
import type { Rgb } from '../colors';
import { teamColor } from '../colors';
import { DEFAULT_TEAM } from './host';
import { satsLabel } from '../wallet';
import { store } from '../store';
import { cssColor, accentMoved, currentPlayerAccent, readableAccent } from '../ui/theme';
import { optionListHeight, paintChip, paintOptionList, teamOptions } from '../ui/rosterui';
import type { RosterOption } from '../ui/rosterui';
import {
  UI_FONT as FONT, CONTENT_CX, CONTENT_W, PANEL_W, PANEL_Y, PANEL_H, leftPanelX,
  paintActionColumn, paintContentShell, paintNavbar, contentFocusRect,
} from '../ui/layout';

const DW = 1280;
const DH = 720;

interface Region {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RoomHooks {
  /** Host: start the match. */
  play(): void;
  /** Leave the room (host: closes it). */
  back(): void;
  /** Pick a team for a player (host: anyone; guest: itself). */
  setTeam(index: number, team: string): void;
  /** Host: cycle the escrowed bet (0 / 50 / 100 / 200). */
  cycleBet(): void;
  /** Guest: accept / withdraw from the host's bet. */
  toggleBetAccept(): void;
  sendChat(text: string): void;
  toggleMic(): void;
  micOn(): boolean;
  /** 0..1 input level for the mic meter. */
  micLevel(): number;
}

export class RoomUi implements ScreenUi {
  version = nextUiVersion();
  private snap: RoomSnapshot | null = null;
  private hooks: RoomHooks;
  private logical = { w: DW, h: DH };
  private regions: Region[] = [];
  private hover: string | null = null;
  private pressed: string | null = null;
  private openTeam: number | null = null;
  /** Team filter for the players list (null = show everyone). */
  private teamFilter: string | null = null;
  private focusChat = false;
  private chatText = '';
  private chatScroll = 0;
  private chatBox = { x: 0, y: 0, w: 0, h: 0 };
  private accent: Rgb = currentPlayerAccent();
  private accentText: Rgb = readableAccent(this.accent);
  private paintedAccent: Rgb | null = null;
  private lastAccentCheck = 0;

  constructor(hooks: RoomHooks) {
    this.hooks = hooks;
  }

  setSnapshot(snap: RoomSnapshot | null): void {
    this.snap = snap;
    this.bump();
  }

  setCaret(on: boolean): void {
    if (this.caretOn !== on) {
      this.caretOn = on;
      this.bump();
    }
  }

  private caretOn = true;

  bump(): void {
    this.version = nextUiVersion();
  }

  /** Follow a live party-mode accent without repainting a static room. */
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
    const snap = this.snap;
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
    ctx.fillStyle = 'rgba(4, 8, 14, 0.48)';
    ctx.fillRect(0, 0, w, h);
    if (!snap) return;

    // Same dim, one content rectangle and shared navbar as the menus,
    // settings and lobby. The room's title is the last crumb.
    paintContentShell(ctx, s, X, Y, U);
    this.regions.push(...paintNavbar(ctx, s, X, Y, U, [
      { label: 'MULTIPLAYER', current: false },
      { label: (snap.title || snap.level) + (snap.protected ? ' · LOCKED' : ''), current: true },
    ], this.hover, this.accent, CONTENT_W, satsLabel(store.sats)));

    this.paintPlayers(ctx, snap, s, X, Y, U);
    this.paintBet(ctx, snap, s, X, Y, U);
    this.paintChat(ctx, snap, s, X, Y, U);

    // Status line, bottom centre.
    const needsAccept = snap.betAmount > 0
      && snap.players.some((p) => !p.host && !p.betAccepted);
    ctx.textAlign = 'center';
    ctx.font = `${U(14)}px ${FONT}`;
    ctx.fillStyle = snap.phase === 'playing' ? '#ffd479' : 'rgba(255,255,255,0.8)';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = U(5);
    const status = snap.phase === 'playing'
      ? 'match starting…'
      : needsAccept
        ? 'waiting for every pilot to accept the bet…'
        : snap.isHost
          ? 'waiting for players — PLAY starts the match for everyone'
          : 'waiting for the host to start the match…';
    const statusW = ctx.measureText(status).width;
    ctx.fillStyle = 'rgba(3, 7, 12, 0.55)';
    ctx.fillRect(X(CONTENT_CX) - statusW / 2 - U(10), Y(DH - 38), statusW + U(20), U(20));
    ctx.fillStyle = snap.phase === 'playing' ? '#ffd479' : 'rgba(255,255,255,0.9)';
    ctx.fillText(status, X(CONTENT_CX), Y(DH - 26));
    ctx.shadowBlur = 0;
    ctx.textAlign = 'left';

    // Right action column (1/8 of the width): host PLAY + leave/close.
    this.regions.push(...paintActionColumn(ctx, s, X, Y, U, {
      primary: snap.isHost
        ? {
            id: 'play',
            label: snap.phase === 'playing' ? 'STARTING…' : 'PLAY',
            disabled: snap.phase === 'playing' || needsAccept,
          }
        : undefined,
      // Back keeps a hosted room alive (the lobby's DELETE closes it); only a
      // guest's leave is destructive.
      back: { id: 'back', label: snap.isHost ? 'BACK TO LOBBY' : 'LEAVE ROOM', danger: !snap.isHost },
      hover: this.hover,
      accent: this.accent,
    }));

    if (this.openTeam !== null) this.paintTeamDropdown(ctx, snap, s, X, Y, U);
  }

  private paintPlayers(
    ctx: CanvasRenderingContext2D, snap: RoomSnapshot, s: number,
    X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  ): void {
    const x0 = leftPanelX(0), y0 = PANEL_Y, w = PANEL_W, h = PANEL_H;
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${U(19)}px ${FONT}`;
    ctx.fillText('PLAYERS', X(x0 + 20), Y(y0 + 26));

    // Team filter: ALL plus every team the pilots are on. Only the picked
    // team's rows stay visible; each chip carries its team colour.
    const teamsPresent: string[] = [];
    for (const p of snap.players) {
      const t = p.team || DEFAULT_TEAM;
      if (!teamsPresent.includes(t)) teamsPresent.push(t);
    }
    teamsPresent.sort();
    if (this.teamFilter !== null && !teamsPresent.includes(this.teamFilter)) this.teamFilter = null;
    const chipH = 20;
    const fy = y0 + 42;
    let fx = x0 + 20;
    const filterChip = (id: string, label: string, color: Rgb, active: boolean): void => {
      ctx.font = `700 ${U(11)}px ${FONT}`;
      const cw = ctx.measureText(label).width / s + 18;
      ctx.fillStyle = active ? cssColor(color, 0.3) : 'rgba(10,14,22,0.72)';
      ctx.fillRect(X(fx), Y(fy), U(cw), U(chipH));
      ctx.strokeStyle = cssColor(color, active ? 0.9 : 0.35);
      ctx.lineWidth = Math.max(1, s);
      ctx.strokeRect(X(fx), Y(fy), U(cw), U(chipH));
      ctx.fillStyle = active ? cssColor(color) : 'rgba(255,255,255,0.7)';
      ctx.textAlign = 'center';
      ctx.fillText(label, X(fx + cw / 2), Y(fy + chipH / 2 + 1));
      ctx.textAlign = 'left';
      this.regions.push({ id, x: X(fx), y: Y(fy), w: U(cw), h: U(chipH) });
      fx += cw + 6;
    };
    filterChip('filter:all', 'ALL', this.accent, this.teamFilter === null);
    for (const t of teamsPresent) {
      filterChip('filter:' + t, teamDisplayName(t), teamColor(t, store.options), this.teamFilter === t);
    }

    const rowH = 44;
    let y = y0 + 76;
    snap.players.forEach((player, i) => {
      const team = player.team || DEFAULT_TEAM;
      if (this.teamFilter !== null && team !== this.teamFilter) return;
      const me = i === snap.meIndex;
      const canPick = snap.isHost || me;
      const rgb = teamColor(team, store.options);
      const rgbText = readableAccent(rgb);
      if (me) {
        ctx.fillStyle = cssColor(this.accent, 0.1);
        ctx.fillRect(X(x0 + 12), Y(y - 4), U(w - 24), U(rowH - 6));
      }
      // A team-coloured stripe down the row's left edge.
      ctx.fillStyle = cssColor(rgb, 0.9);
      ctx.fillRect(X(x0 + 12), Y(y - 4), U(3), U(rowH - 6));
      ctx.font = `700 ${U(15)}px ${FONT}`;
      ctx.fillStyle = cssColor(rgbText);
      ctx.fillText(player.name, X(x0 + 22), Y(y + 6));
      // Badges: HOST, MIC.
      let badgeX = x0 + 22 + ctx.measureText(player.name).width / s + 14;
      const badge = (text: string, color: string): void => {
        ctx.font = `700 ${U(10)}px ${FONT}`;
        const bw = ctx.measureText(text).width / s + 12;
        ctx.fillStyle = color;
        ctx.fillRect(X(badgeX), Y(y - 2), U(bw), U(16));
        ctx.fillStyle = '#0a0e16';
        ctx.fillText(text, X(badgeX + 6), Y(y + 6));
        badgeX += bw + 6;
      };
      if (player.host) badge('HOST', cssColor(rgbText, 0.9));
      if (player.mic) badge('MIC', 'rgba(255,212,121,0.95)');
      // Team picker on the right: the same select chip the briefing roster uses,
      // tinted with the team's colour.
      const tw = 150;
      const bx = X(x0 + w - tw - 22);
      const by = Y(y - 6);
      const bw2 = U(tw);
      const bh2 = U(28);
      paintChip({
        ctx, x: bx, y: by, w: bw2, h: bh2,
        text: player.team ? teamDisplayName(player.team) : 'auto',
        hovered: this.hover === 'team:' + i,
        accent: rgb, accentText: rgbText, lineWidth: s,
        fontPx: U(13), font: FONT,
      });
      if (canPick) this.regions.push({ id: 'team:' + i, x: bx, y: by, w: bw2, h: bh2 });
      y += rowH;
    });
    // Fill the empty slots so the room size is visible (only when unfiltered).
    if (this.teamFilter === null) {
      for (let i = snap.players.length; i < snap.maxPlayers && i < snap.players.length + 6; i++) {
        ctx.font = `${U(13)}px ${FONT}`;
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        ctx.fillText('waiting for a pilot…', X(x0 + 22), Y(y + 6));
        y += rowH;
      }
    }
    ctx.font = `${U(12)}px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText(snap.isHost
      ? 'pick a team for every pilot (auto = level default)'
      : 'your team can be changed on your own row', X(x0 + 20), Y(y0 + h - 20));
  }

  /** Escrowed-bet control (host sets it; guests accept it). */
  private paintBet(
    ctx: CanvasRenderingContext2D, snap: RoomSnapshot, s: number,
    X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  ): void {
    const x0 = leftPanelX(0), y0 = PANEL_Y, w = PANEL_W, h = PANEL_H;
    const by = y0 + h - 80;
    if (snap.isHost) {
      const label = snap.betAmount > 0 ? `BET · ${snap.betAmount}` : 'BET · OFF';
      this.button(ctx, X(x0 + 20), Y(by), U(w - 40), U(30), label, 'bet',
        this.hover === 'bet', U(14), snap.betAmount > 0);
    } else {
      const armed = snap.betAmount > 0;
      const label = !armed ? 'NO BET' : snap.betAccepted ? 'BET ACCEPTED' : 'ACCEPT BET';
      this.button(ctx, X(x0 + 20), Y(by), U(w - 40), U(30), label, 'bet-accept',
        this.hover === 'bet-accept', U(14), snap.betAccepted, !armed);
    }
    ctx.font = `${U(12)}px ${FONT}`;
    if (snap.betError) {
      ctx.fillStyle = '#ff8a76';
      ctx.fillText(snap.betError, X(x0 + 20), Y(by - 16));
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.42)';
      const hint = snap.isHost
        ? 'escrowed bet: cycles 0 / 50 / 100 / 200'
        : snap.betAmount > 0 ? 'accept to join the stakes' : 'the host may set a bet';
      ctx.fillText(hint, X(x0 + 20), Y(by - 14));
    }
  }

  private paintChat(
    ctx: CanvasRenderingContext2D, snap: RoomSnapshot, s: number,
    X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  ): void {
    const x0 = leftPanelX(1), y0 = PANEL_Y, w = PANEL_W, h = PANEL_H;
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${U(19)}px ${FONT}`;
    ctx.fillText('CHAT', X(x0 + 20), Y(y0 + 26));

    const inputH = 34;
    const logY = y0 + 46;
    const logH = h - 46 - inputH - 60;
    this.chatBox = { x: X(x0 + 12), y: Y(logY), w: U(w - 24), h: U(logH) };

    // Wrap every line, then show the tail that fits (auto-scroll to the end).
    const maxW = U(w - 48);
    ctx.font = `${U(13)}px ${FONT}`;
    const lines: { text: string; color: string; font: string }[] = [];
    for (const entry of snap.chat) {
      const font = entry.system ? `italic ${U(12)}px ${FONT}` : `${U(13)}px ${FONT}`;
      ctx.font = font;
      const prefix = entry.system ? '' : `${entry.from}: `;
      const words = (prefix + entry.text).split(' ');
      let line = '';
      for (const word of words) {
        const next = line ? line + ' ' + word : word;
        if (ctx.measureText(next).width > maxW && line) {
          lines.push({ text: line, color: entry.system ? 'rgba(255,255,255,0.45)' : '#ffffff', font });
          line = word;
        } else {
          line = next;
        }
      }
      lines.push({ text: line, color: entry.system ? 'rgba(255,255,255,0.45)' : '#ffffff', font });
    }
    const lineH = 18;
    const fits = Math.max(1, Math.floor((logH - 12) / lineH));
    const total = lines.length;
    const maxScroll = Math.max(0, total - fits);
    this.chatScroll = Math.min(this.chatScroll, maxScroll);
    const start = Math.max(0, total - fits - this.chatScroll);
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.chatBox.x, this.chatBox.y, this.chatBox.w, this.chatBox.h);
    ctx.clip();
    for (let i = start; i < Math.min(total, start + fits); i++) {
      ctx.font = lines[i].font;
      ctx.fillStyle = lines[i].color;
      ctx.fillText(lines[i].text, X(x0 + 20), Y(logY + 10 + (i - start) * lineH));
    }
    ctx.restore();
    if (maxScroll > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.fillRect(this.chatBox.x + this.chatBox.w - U(4), this.chatBox.y, U(4), U(logH));
      const knobH = Math.max(U(24), U(logH) * (fits / total));
      const knobY = this.chatBox.y + (U(logH) - knobH) * (1 - this.chatScroll / maxScroll);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(this.chatBox.x + this.chatBox.w - U(4), knobY, U(4), knobH);
    }

    // Input row.
    const iy = y0 + h - 82;
    const sendW = 90;
    const bw = w - 44 - sendW - 10;
    const bx = X(x0 + 22);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(bx, Y(iy), U(bw), U(inputH));
    ctx.strokeStyle = this.focusChat ? cssColor(this.accent, 0.85) : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = Math.max(1, s);
    ctx.strokeRect(bx, Y(iy), U(bw), U(inputH));
    ctx.font = `${U(14)}px ${FONT}`;
    ctx.fillStyle = this.chatText ? cssColor(this.accentText) : 'rgba(255,255,255,0.4)';
    const shown = this.chatText || 'type a message…';
    ctx.fillText(shown, bx + U(8), Y(iy + inputH / 2));
    if (this.focusChat && this.caretOn) {
      ctx.fillStyle = cssColor(this.accentText);
      const tw = ctx.measureText(shown).width;
      ctx.fillRect(bx + U(8) + (this.chatText ? tw : 0) + U(2), Y(iy + inputH / 2 - 8), Math.max(1, s), U(16));
    }
    this.regions.push({ id: 'chat', x: bx, y: Y(iy), w: U(bw), h: U(inputH) });
    this.button(ctx, X(x0 + 22 + bw + 10), Y(iy), U(sendW), U(inputH), 'SEND', 'send',
      this.hover === 'send', U(14));

    // Microphone toggle + meter.
    const micY = y0 + h - 40;
    const micOn = this.snap?.micOn ?? this.hooks.micOn();
    this.button(ctx, X(x0 + 22), Y(micY - 14), U(200), U(28),
      micOn ? 'MIC ON' : 'MIC OFF', 'mic', this.hover === 'mic', U(14), micOn);
    const level = Math.max(0, Math.min(1, this.hooks.micLevel()));
    const meterX = x0 + 234;
    const meterW = w - 44 - 212;
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(X(meterX), Y(micY - 8), U(meterW), U(6));
    let bars = 0;
    if (micOn) {
      const rnd = (i: number): number => Math.abs(Math.sin(i * 12.9898 + level * 78.233));
      bars = Math.min(meterW, level * meterW * (0.6 + rnd(Math.floor(level * 100)) * 0.8));
    }
    ctx.fillStyle = level > 0.65 ? '#ff8a76' : cssColor(this.accent);
    ctx.fillRect(X(meterX), Y(micY - 8), U(bars), U(6));
    ctx.font = `${U(11)}px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText(micOn ? 'voice is live (WebRTC)' : 'tap to talk', X(meterX), Y(micY + 12));
  }

  /** Team dropdown (host, or your own row): floats over everything. */
  private paintTeamDropdown(
    ctx: CanvasRenderingContext2D, snap: RoomSnapshot, s: number,
    X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  ): void {
    const index = this.openTeam!;
    const anchor = this.regions.find((r) => r.id === 'team:' + index);
    if (!anchor) {
      this.openTeam = null;
      return;
    }
    const options: RosterOption[] = [
      { value: 'auto', label: 'auto' },
      ...teamOptions(snap.teams),
    ];
    const rowH = Math.max(U(26), anchor.h);
    const pad = U(4);
    const height = optionListHeight(options.length, rowH, pad);
    let y = anchor.y + anchor.h + U(4);
    if (y + height > this.logical.h) y = Math.max(0, anchor.y - height - U(4));
    const rects = paintOptionList({
      ctx, x: anchor.x, y, w: anchor.w, h: height, options,
      value: snap.players[index]?.team || 'auto',
      hoverPrefix: `opt:team:${index}:`, hover: this.hover,
      rowH, padding: pad, fontPx: U(13), font: FONT,
      accent: this.accent, accentText: this.accentText, lineWidth: U(1),
    });
    rects.forEach((r) => {
      this.regions.push({ id: `opt:team:${index}:${r.value}`, x: r.x, y: r.y, w: r.w, h: r.h });
    });
  }


  private button(
    ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
    label: string, id: string, hovered: boolean, size: number, emphasis = false,
    disabled = false, open = false,
  ): void {
    ctx.fillStyle = disabled
      ? 'rgba(10,14,22,0.45)'
      : emphasis
        ? cssColor(this.accent, 0.2)
        : open
          ? cssColor(this.accent, 0.16)
          : hovered ? cssColor(this.accent, 0.16) : 'rgba(10,14,22,0.72)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = emphasis ? cssColor(this.accent, 0.8) : open ? cssColor(this.accent, 0.6)
      : cssColor(this.accent, 0.24);
    ctx.lineWidth = Math.max(1, size / 16);
    ctx.strokeRect(x, y, w, h);
    ctx.font = `700 ${Math.round(size)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = disabled ? 'rgba(255,255,255,0.3)' : cssColor(this.accentText);
    ctx.fillText(label, x + w / 2, y + h / 2 + 1);
    ctx.textAlign = 'left';
    // Disabled controls keep their look but are not clickable.
    if (!disabled) this.regions.push({ id, x, y, w, h });
  }

  // ---------------------------------------------------------------- input
  pointer(kind: 'move' | 'down' | 'up', x: number, y: number, cssW: number, cssH: number): boolean {
    const lx = x * (this.logical.w / Math.max(1, cssW));
    const ly = y * (this.logical.h / Math.max(1, cssH));
    const hit = this.hit(lx, ly);
    const id = hit?.id ?? null;
    if (kind === 'move') {
      if (id !== this.hover) {
        this.hover = id;
        this.bump();
      }
      return !!id;
    }
    if (kind === 'down') {
      this.pressed = id;
      if (!id) {
        // Clicking outside the input blurs it (and closes an open dropdown).
        if (this.focusChat || this.openTeam !== null) {
          this.focusChat = false;
          this.openTeam = null;
          this.bump();
        }
        return false;
      }
      this.bump();
      return true;
    }
    const pressed = this.pressed;
    this.pressed = null;
    if (!id || id !== pressed) return !!id;
    if (id === FS_REGION) {
      void toggleFullscreen().then(() => this.bump());
      return true;
    }
    if (id === VR_REGION) {
      void clickVrToggle().then(() => this.bump());
      return true;
    }
    if (id === 'back' || id === 'crumb:0') {
      this.hooks.back();
      return true;
    }
    if (id === 'play') {
      this.hooks.play();
      return true;
    }
    if (id === 'send') {
      if (this.chatText.trim()) {
        this.hooks.sendChat(this.chatText);
        this.chatText = '';
        this.chatScroll = 0;
      }
      this.bump();
      return true;
    }
    if (id === 'mic') {
      this.hooks.toggleMic();
      return true;
    }
    if (id === 'bet') {
      this.hooks.cycleBet();
      return true;
    }
    if (id === 'bet-accept') {
      this.hooks.toggleBetAccept();
      return true;
    }
    if (id === 'chat') {
      this.focusChat = true;
      this.bump();
      return true;
    }
    if (id.startsWith('filter:')) {
      const team = id.slice('filter:'.length);
      this.teamFilter = team === 'all' ? null : team;
      this.bump();
      return true;
    }
    if (id.startsWith('team:')) {
      const index = Number(id.slice(5));
      // Only the host (any row) and the guest itself may pick a team.
      if (!this.snap?.isHost && index !== this.snap?.meIndex) return true;
      this.openTeam = this.openTeam === index ? null : index;
      this.bump();
      return true;
    }
    if (id.startsWith('opt:team:')) {
      const rest = id.slice('opt:team:'.length);
      const split = rest.indexOf(':');
      const index = Number(rest.slice(0, split));
      const team = rest.slice(split + 1);
      this.openTeam = null;
      this.hooks.setTeam(index, team === 'auto' ? '' : team);
      this.bump();
      return true;
    }
    return true;
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
    const box = this.chatBox;
    if (lx < box.x || lx > box.x + box.w || ly < box.y || ly > box.y + box.h) return false;
    this.chatScroll = Math.max(0, this.chatScroll + (deltaY > 0 ? -3 : 3));
    this.bump();
    return true;
  }

  key(e: KeyboardEvent): boolean {
    if (this.focusChat) {
      if (e.key === 'Escape') {
        this.focusChat = false;
        this.bump();
        return true;
      }
      if (e.key === 'Enter') {
        if (this.chatText.trim()) {
          this.hooks.sendChat(this.chatText);
          this.chatText = '';
          this.chatScroll = 0;
        }
        this.bump();
        return true;
      }
      if (e.key === 'Backspace') {
        this.chatText = this.chatText.slice(0, -1);
        this.bump();
        return true;
      }
      if (e.key.length === 1 && this.chatText.length < 200 && !e.ctrlKey && !e.metaKey) {
        this.chatText += e.key;
        this.bump();
        return true;
      }
      return false;
    }
    if (e.key === 'Escape') {
      this.hooks.back();
      return true;
    }
    if (e.key === 'Enter' && this.snap?.isHost) {
      this.hooks.play();
      return true;
    }
    return false;
  }

  private hit(x: number, y: number): Region | null {
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const r = this.regions[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
    }
    return null;
  }
}
