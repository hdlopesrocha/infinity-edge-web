// Shared roster UI: the team select chip and its option list.
//
// Extracted from the single-player briefing roster so the multiplayer waiting
// room paints its players list with exactly the same control (a value chip with
// a caret that opens a modal list). Both MenuUi (briefing) and RoomUi (waiting
// room) call these, so the two lists cannot drift apart.
//
// The painters take device-pixel rectangles and the caller registers the
// returned hit regions with its own ids, so each UI keeps its own input model.

import type { Rgb } from '../colors';
import { teamDisplayName } from '../team';
import { cssColor, readableAccent } from './theme';

export interface RosterOption {
  value: string;
  label: string;
}

/** Team ids -> display options (`team1` -> `Team 1`). */
export function teamOptions(teams: readonly string[]): RosterOption[] {
  return teams.map((team) => ({ value: team, label: teamDisplayName(team) }));
}

/** Label of `value` in an option list (falls back to the raw value). */
export function optionLabel(options: readonly RosterOption[], value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

export interface ChipPaint {
  ctx: CanvasRenderingContext2D;
  /** Device-pixel rectangle. */
  x: number; y: number; w: number; h: number;
  text: string;
  hovered: boolean;
  accent: Rgb;
  accentText: Rgb;
  /** Stroke width in device pixels. */
  lineWidth: number;
  fontPx: number;
  font: string;
  /** Draw the ▾ caret (default true). */
  caret?: boolean;
}

/** Paint a select chip. Register `{x,y,w,h}` as the clickable region. */
export function paintChip(p: ChipPaint): void {
  const ctx = p.ctx;
  ctx.fillStyle = p.hovered ? cssColor(p.accent, 0.2) : 'rgba(10,14,22,0.72)';
  ctx.fillRect(p.x, p.y, p.w, p.h);
  ctx.strokeStyle = cssColor(p.accent, p.hovered ? 0.55 : 0.3);
  ctx.lineWidth = Math.max(1, p.lineWidth);
  ctx.strokeRect(p.x, p.y, p.w, p.h);
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${p.fontPx}px ${p.font}`;
  ctx.fillStyle = cssColor(p.accentText);
  ctx.textAlign = 'left';
  ctx.fillText(p.text, p.x + p.fontPx * 0.6, p.y + p.h / 2 + 1);
  if (p.caret !== false) {
    ctx.textAlign = 'right';
    ctx.fillText('▾', p.x + p.w - p.fontPx * 0.6, p.y + p.h / 2 + 1);
  }
  ctx.restore();
}

export interface OptionListPaint {
  ctx: CanvasRenderingContext2D;
  /** Top-left of the list (device pixels). */
  x: number; y: number;
  w: number;
  /** Total height (see {@link optionListHeight}). */
  h: number;
  options: readonly RosterOption[];
  value: string;
  /** Hovered region id prefix (e.g. `dropdown:` or `opt:team:0:`). */
  hoverPrefix?: string;
  hover: string | null;
  rowH: number;
  padding: number;
  fontPx: number;
  font: string;
  accent: Rgb;
  accentText: Rgb;
  lineWidth: number;
}

/** Height a list of `count` options needs. */
export function optionListHeight(count: number, rowH: number, padding: number): number {
  return count * rowH + padding * 2;
}

/** Paint the option list. Returns each option's clickable rectangle, in order. */
export function paintOptionList(p: OptionListPaint): { value: string; x: number; y: number; w: number; h: number }[] {
  const ctx = p.ctx;
  ctx.fillStyle = 'rgba(6,10,16,0.97)';
  ctx.strokeStyle = cssColor(p.accent, 0.5);
  ctx.lineWidth = Math.max(1, p.lineWidth);
  ctx.fillRect(p.x, p.y, p.w, p.h);
  ctx.strokeRect(p.x, p.y, p.w, p.h);
  const out: { value: string; x: number; y: number; w: number; h: number }[] = [];
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  p.options.forEach((opt, i) => {
    const oy = p.y + p.padding + i * p.rowH;
    if (p.hover === (p.hoverPrefix ?? '') + i) {
      ctx.fillStyle = cssColor(p.accent, 0.16);
      ctx.fillRect(p.x + 2, oy, p.w - 4, p.rowH - 2);
    }
    ctx.font = `${p.fontPx}px ${p.font}`;
    ctx.fillStyle = opt.value === p.value ? cssColor(p.accentText) : '#ffffff';
    ctx.fillText(opt.label, p.x + p.padding + 6, oy + p.rowH / 2);
    out.push({ value: opt.value, x: p.x, y: oy, w: p.w, h: p.rowH });
  });
  ctx.restore();
  return out;
}

// ---------------------------------------------------- roster list component
//
// One shared "players & bots" list, painted by both the single-player briefing
// (MenuUi) and the multiplayer waiting room (RoomUi): a team filter, then one
// row per entry with the name in its team colour, optional badges, an optional
// AI chip and a team chip, and an optional remove control.

/** A clickable rectangle the caller registers with its own id. */
export interface UiRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One player or bot shown by the shared roster list. */
export interface RosterEntry {
  id: string;
  name: string;
  /** Team id; '' = auto (the level default). */
  team: string;
  teamOptions: readonly RosterOption[];
  /** Bot brain id + options (omit for a player). */
  ai?: string;
  aiOptions?: readonly RosterOption[];
  /** Show the × remove control (bots). */
  removable?: boolean;
  /** Small badges after the name (HOST, MIC, YOU…). */
  badges?: readonly string[];
  /** Draw the TEAM chip (default true). */
  showTeam?: boolean;
}

export interface RosterRowPaint {
  ctx: CanvasRenderingContext2D;
  /** Device-pixel rectangle of the row. */
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
  entry: RosterEntry;
  hover: string | null;
  accent: Rgb;
  accentText: Rgb;
  font: string;
  fontPx: number;
  /** Team colour tinting the name, the stripe and the TEAM chip. */
  teamRgb: Rgb;
  /** Region ids for the clickable parts (omit a part to hide it). */
  ids: { team?: string; ai?: string; remove?: string };
  /** Chip width in design px (default 122). */
  chipW?: number;
  /** Chip label prefixes (defaults "TEAM: " / "AI: "). */
  teamPrefix?: string;
  aiPrefix?: string;
  /** Tint the row background (the current player's row). */
  highlight?: boolean;
}

/** Paint one roster row; returns the clickable parts to register. */
export function paintRosterRow(p: RosterRowPaint): UiRect[] {
  const { ctx, entry, scale } = p;
  const rects: UiRect[] = [];
  const midY = p.y + p.h / 2;
  const chipW = (p.chipW ?? 122) * scale;
  const chipH = Math.max(24 * scale, p.h - 8 * scale);
  const gap = 8 * scale;
  const removeW = 24 * scale;
  const labelFont = p.fontPx;
  const chipFont = Math.max(12 * scale, p.fontPx - 2 * scale);

  if (p.highlight) {
    ctx.fillStyle = cssColor(p.accent, 0.1);
    ctx.fillRect(p.x - 10 * scale, p.y, p.w + 14 * scale, p.h);
  }
  // A team-coloured stripe down the row's left edge.
  ctx.fillStyle = cssColor(p.teamRgb, 0.9);
  ctx.fillRect(p.x - 10 * scale, p.y, 3 * scale, p.h);

  let right = p.x + p.w;
  if (entry.removable && p.ids.remove) {
    const rx = right - removeW;
    const hovered = p.hover === p.ids.remove;
    ctx.fillStyle = hovered ? 'rgba(130,36,28,0.6)' : 'rgba(70,18,18,0.42)';
    ctx.fillRect(rx, p.y, removeW, p.h);
    ctx.strokeStyle = 'rgba(255,122,82,0.5)';
    ctx.lineWidth = Math.max(1, scale);
    ctx.strokeRect(rx, p.y, removeW, p.h);
    ctx.font = `700 ${15 * scale}px ${p.font}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffb0a0';
    ctx.fillText('×', rx + removeW / 2, midY + 1);
    ctx.textAlign = 'left';
    rects.push({ id: p.ids.remove, x: rx, y: p.y, w: removeW, h: p.h });
    right -= removeW + gap;
  }
  if (entry.showTeam !== false) {
    // Read-only rows (a room's bots) paint the chip without a hit region.
    const id = p.ids.team;
    const cx = right - chipW;
    paintChip({
      ctx, x: cx, y: midY - chipH / 2, w: chipW, h: chipH,
      text: (p.teamPrefix ?? 'TEAM: ') + optionLabel(entry.teamOptions, entry.team || 'auto'),
      hovered: id !== undefined && p.hover === id,
      accent: p.teamRgb, accentText: readableAccent(p.teamRgb), lineWidth: scale,
      fontPx: chipFont, font: p.font, caret: id !== undefined,
    });
    if (id !== undefined) rects.push({ id, x: cx, y: midY - chipH / 2, w: chipW, h: chipH });
    right -= chipW + gap;
  }
  if (entry.ai !== undefined) {
    const id = p.ids.ai;
    const cx = right - chipW;
    paintChip({
      ctx, x: cx, y: midY - chipH / 2, w: chipW, h: chipH,
      text: (p.aiPrefix ?? 'AI: ') + optionLabel(entry.aiOptions ?? [], entry.ai),
      hovered: id !== undefined && p.hover === id,
      accent: p.accent, accentText: p.accentText, lineWidth: scale,
      fontPx: chipFont, font: p.font, caret: id !== undefined,
    });
    if (id !== undefined) rects.push({ id, x: cx, y: midY - chipH / 2, w: chipW, h: chipH });
    right -= chipW + gap;
  }
  void right;

  // Name + badges on the left.
  ctx.font = `700 ${labelFont}px ${p.font}`;
  ctx.fillStyle = cssColor(readableAccent(p.teamRgb));
  ctx.fillText(entry.name, p.x, midY + 1);
  let bx = p.x + ctx.measureText(entry.name).width + 8 * scale;
  for (const badge of entry.badges ?? []) {
    ctx.font = `700 ${10 * scale}px ${p.font}`;
    const bw = ctx.measureText(badge).width + 12 * scale;
    ctx.fillStyle = cssColor(p.teamRgb, 0.85);
    ctx.fillRect(bx, midY - 8 * scale, bw, 16 * scale);
    ctx.fillStyle = '#0a0e16';
    ctx.fillText(badge, bx + 6 * scale, midY + 1);
    bx += bw + 6 * scale;
  }
  return rects;
}

export interface TeamFilterPaint {
  ctx: CanvasRenderingContext2D;
  /** Device-pixel top-left of the chip row. */
  x: number;
  y: number;
  scale: number;
  hover: string | null;
  accent: Rgb;
  font: string;
  /** Team ids present (the ALL chip is added automatically). */
  teams: readonly string[];
  /** Active team id, or null for ALL. */
  active: string | null;
  /** Region id prefix, e.g. `filter:` or `roster-filter:`. */
  idPrefix: string;
  /** Team colour lookup. */
  colorOf: (team: string) => Rgb;
  height?: number;
  fontPx?: number;
}

/** Paint the ALL + per-team filter chips; returns their clickable rectangles. */
export function paintTeamFilter(p: TeamFilterPaint): UiRect[] {
  const rects: UiRect[] = [];
  const h = (p.height ?? 20) * p.scale;
  const fontPx = (p.fontPx ?? 11) * p.scale;
  let x = p.x;
  const chip = (id: string, label: string, color: Rgb, active: boolean): void => {
    p.ctx.font = `700 ${fontPx}px ${p.font}`;
    const w = p.ctx.measureText(label).width + 18 * p.scale;
    p.ctx.fillStyle = active ? cssColor(color, 0.3) : 'rgba(10,14,22,0.72)';
    p.ctx.fillRect(x, p.y, w, h);
    p.ctx.strokeStyle = cssColor(color, active ? 0.9 : 0.35);
    p.ctx.lineWidth = Math.max(1, p.scale);
    p.ctx.strokeRect(x, p.y, w, h);
    p.ctx.fillStyle = active ? cssColor(color) : 'rgba(255,255,255,0.7)';
    p.ctx.textAlign = 'center';
    p.ctx.fillText(label, x + w / 2, p.y + h / 2 + 1);
    p.ctx.textAlign = 'left';
    rects.push({ id, x, y: p.y, w, h });
    x += w + 6 * p.scale;
  };
  chip(p.idPrefix + 'all', 'ALL', p.accent, p.active === null);
  for (const t of p.teams) chip(p.idPrefix + t, teamDisplayName(t), p.colorOf(t), p.active === t);
  return rects;
}
