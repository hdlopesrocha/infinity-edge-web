// Waiting-room menu, painted into the WebGL frame (like the lobby): the host
// opens it by creating a room, guests land here after joining, and the match
// starts only when the host presses PLAY. It carries the roster with per-player
// team pickers, a chat (text over the data channels) and a microphone toggle
// (voice PCM over the same channels — the capture lives in the room view).

import { nextUiVersion } from '../../engine/overlay';
import type { ScreenUi } from '../../engine/overlay';
import type { RoomSnapshot } from './manager';
import { FS_REGION, paintFullscreenButton, toggleFullscreen } from '../ui/fullscreen';

const FONT = "'DejaVu Sans','Segoe UI',Verdana,sans-serif";
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
  private focusChat = false;
  private chatText = '';
  private chatScroll = 0;
  private chatBox = { x: 0, y: 0, w: 0, h: 0 };

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

  // -------------------------------------------------------------- painting
  paint(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const snap = this.snap;
    this.logical = { w, h };
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

    // Scrims: the water behind the top/bottom chrome is often bright enough
    // to wash the text out, so fade a dark band in from each edge.
    const top = ctx.createLinearGradient(0, Y(0), 0, Y(96));
    top.addColorStop(0, 'rgba(3, 7, 12, 0.8)');
    top.addColorStop(1, 'rgba(3, 7, 12, 0)');
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, w, Y(96));
    const bottom = ctx.createLinearGradient(0, Y(DH - 70), 0, Y(DH));
    bottom.addColorStop(0, 'rgba(3, 7, 12, 0)');
    bottom.addColorStop(1, 'rgba(3, 7, 12, 0.72)');
    ctx.fillStyle = bottom;
    ctx.fillRect(0, Math.max(0, Y(DH - 70)), w, Math.max(0, h - Y(DH - 70)));

    // Title + subtitle (room identity, player count, phase).
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${U(30)}px ${FONT}`;
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = U(8);
    ctx.fillText(snap.title || snap.level, X(DW / 2), Y(30));
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(127,232,216,0.9)';
    ctx.fillRect(X(DW / 2 - 90), Y(50), U(180), U(2));
    ctx.font = `600 ${U(15)}px ${FONT}`;
    const subtitle = `${snap.players.length}/${snap.maxPlayers} pilots · room ${snap.roomId.slice(0, 8)} · ${snap.level}`;
    const subW = ctx.measureText(subtitle).width;
    ctx.fillStyle = 'rgba(3, 7, 12, 0.6)';
    ctx.fillRect(X(DW / 2) - subW / 2 - U(12), Y(58), subW + U(24), U(24));
    ctx.fillStyle = 'rgba(168,255,240,0.95)';
    ctx.fillText(subtitle, X(DW / 2), Y(70));
    ctx.textAlign = 'left';

    this.paintPlayers(ctx, snap, s, X, Y, U);
    this.paintChat(ctx, snap, s, X, Y, U);

    // Status line, bottom centre.
    ctx.textAlign = 'center';
    ctx.font = `${U(14)}px ${FONT}`;
    ctx.fillStyle = snap.phase === 'playing' ? '#ffd479' : 'rgba(255,255,255,0.8)';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = U(5);
    const status = snap.phase === 'playing'
      ? 'match starting…'
      : snap.isHost
        ? 'waiting for players — PLAY starts the match for everyone'
        : 'waiting for the host to start the match…';
    const statusW = ctx.measureText(status).width;
    ctx.fillStyle = 'rgba(3, 7, 12, 0.55)';
    ctx.fillRect(X(DW / 2) - statusW / 2 - U(10), Y(DH - 38), statusW + U(20), U(20));
    ctx.fillStyle = snap.phase === 'playing' ? '#ffd479' : 'rgba(255,255,255,0.9)';
    ctx.fillText(status, X(DW / 2), Y(DH - 26));
    ctx.shadowBlur = 0;
    ctx.textAlign = 'left';

    // Corners: leave/close, PLAY (host only).
    this.button(ctx, X(0), Y(DH - 54), U(160), U(48), snap.isHost ? 'close room' : 'leave room',
      'back', this.hover === 'back', U(15));
    if (snap.isHost) {
      this.button(ctx, X(DW - 160), Y(DH - 54), U(160), U(48),
        snap.phase === 'playing' ? 'starting…' : 'PLAY', 'play', this.hover === 'play', U(18), true);
    }

    // Fullscreen toggle, top-right (the menu/lobby chrome, from boot on).
    {
      const size = U(44);
      const fx = X(DW - 60);
      const fy = Y(12);
      paintFullscreenButton(ctx, fx, fy, size, s, this.hover === FS_REGION);
      this.regions.push({ id: FS_REGION, x: fx, y: fy, w: size, h: size });
    }

    if (this.openTeam !== null) this.paintTeamDropdown(ctx, snap, s, X, Y, U);
  }

  private paintPlayers(
    ctx: CanvasRenderingContext2D, snap: RoomSnapshot, s: number,
    X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  ): void {
    const x0 = 50, y0 = 104, w = 560, h = 512;
    this.panel(ctx, X(x0), Y(y0), U(w), U(h), s);
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${U(19)}px ${FONT}`;
    ctx.fillText('PLAYERS', X(x0 + 20), Y(y0 + 26));
    const rowH = 44;
    let y = y0 + 52;
    snap.players.forEach((player, i) => {
      const me = i === snap.meIndex;
      const canPick = snap.isHost || me;
      if (me) {
        ctx.fillStyle = 'rgba(127,232,216,0.10)';
        ctx.fillRect(X(x0 + 12), Y(y - 4), U(w - 24), U(rowH - 6));
      }
      ctx.font = `700 ${U(15)}px ${FONT}`;
      ctx.fillStyle = me ? '#7fe8d8' : '#ffffff';
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
      if (player.host) badge('HOST', 'rgba(127,232,216,0.9)');
      if (player.mic) badge('MIC', 'rgba(255,212,121,0.95)');
      // Team picker on the right.
      const tw = 150;
      const bx = x0 + w - tw - 22;
      const label = player.team || 'auto';
      this.button(ctx, X(bx), Y(y - 6), U(tw), U(28), label, 'team:' + i,
        this.hover === 'team:' + i, U(13), false, !canPick, this.openTeam === i);
      y += rowH;
    });
    // Fill the empty slots so the room size is visible.
    for (let i = snap.players.length; i < snap.maxPlayers && i < snap.players.length + 6; i++) {
      ctx.font = `${U(13)}px ${FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fillText('waiting for a pilot…', X(x0 + 22), Y(y + 6));
      y += rowH;
    }
    ctx.font = `${U(12)}px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText(snap.isHost
      ? 'pick a team for every pilot (auto = level default)'
      : 'your team can be changed on your own row', X(x0 + 20), Y(y0 + h - 20));
  }

  private paintChat(
    ctx: CanvasRenderingContext2D, snap: RoomSnapshot, s: number,
    X: (x: number) => number, Y: (y: number) => number, U: (u: number) => number,
  ): void {
    const x0 = 670, y0 = 104, w = 560, h = 512;
    this.panel(ctx, X(x0), Y(y0), U(w), U(h), s);
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
    ctx.strokeStyle = this.focusChat ? 'rgba(127,232,216,0.85)' : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = Math.max(1, s);
    ctx.strokeRect(bx, Y(iy), U(bw), U(inputH));
    ctx.font = `${U(14)}px ${FONT}`;
    ctx.fillStyle = this.chatText ? '#ffffff' : 'rgba(255,255,255,0.4)';
    const shown = this.chatText || 'type a message…';
    ctx.fillText(shown, bx + U(8), Y(iy + inputH / 2));
    if (this.focusChat && this.caretOn) {
      ctx.fillStyle = '#7fe8d8';
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
    ctx.fillStyle = level > 0.65 ? '#ff8a76' : '#7fe8d8';
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
    const options = ['auto', ...snap.teams];
    const rowH = Math.max(U(26), anchor.h);
    const height = options.length * rowH + U(8);
    let y = anchor.y + anchor.h + U(4);
    if (y + height > this.logical.h) y = Math.max(0, anchor.y - height - U(4));
    ctx.fillStyle = 'rgba(6,10,16,0.94)';
    ctx.strokeStyle = 'rgba(127,232,216,0.5)';
    ctx.lineWidth = Math.max(1, U(1));
    ctx.fillRect(anchor.x, y, anchor.w, height);
    ctx.strokeRect(anchor.x, y, anchor.w, height);
    options.forEach((option, i) => {
      const oy = y + U(4) + i * rowH;
      const rid = `opt:team:${index}:${option}`;
      if (this.hover === rid) {
        ctx.fillStyle = 'rgba(127,232,216,0.16)';
        ctx.fillRect(anchor.x + U(2), oy, anchor.w - U(4), rowH - U(2));
      }
      const current = (snap.players[index]?.team || 'auto') === option;
      ctx.font = `700 ${U(13)}px ${FONT}`;
      ctx.fillStyle = current ? '#7fe8d8' : '#ffffff';
      ctx.fillText(option, anchor.x + U(10), oy + rowH / 2);
      this.regions.push({ id: rid, x: anchor.x, y: oy, w: anchor.w, h: rowH });
    });
  }

  private panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, s: number): void {
    ctx.fillStyle = 'rgba(8,12,20,0.64)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = Math.max(1, s);
    ctx.strokeRect(x, y, w, h);
  }

  private button(
    ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
    label: string, id: string, hovered: boolean, size: number, accent = false,
    disabled = false, open = false,
  ): void {
    ctx.fillStyle = disabled
      ? 'rgba(10,14,22,0.45)'
      : accent
        ? 'rgba(127,232,216,0.2)'
        : open
          ? 'rgba(127,232,216,0.16)'
          : hovered ? 'rgba(255,255,255,0.16)' : 'rgba(10,14,22,0.72)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = accent ? 'rgba(127,232,216,0.8)' : open ? 'rgba(127,232,216,0.6)'
      : 'rgba(255,255,255,0.16)';
    ctx.lineWidth = Math.max(1, size / 16);
    ctx.strokeRect(x, y, w, h);
    ctx.font = `700 ${Math.round(size)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = disabled ? 'rgba(255,255,255,0.3)' : accent ? '#7fe8d8' : '#ffffff';
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
    if (id === 'back') {
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
    if (id === 'chat') {
      this.focusChat = true;
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
