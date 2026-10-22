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
import { cssColor } from './theme';

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
