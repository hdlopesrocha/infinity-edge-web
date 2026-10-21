// Player-colour UI accents: the WebGL chrome and DOM CSS both read the same
// selected colour, so changing it in Options cannot leave hard-coded teal
// controls behind.
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PLAYER_COLOR, hexToRgb, rgbToHsv } from '../src/game/colors';
import { store } from '../src/game/store';
import {
  cssColor, accentMoved, currentAccentText, currentPlayerAccent, readableAccent,
} from '../src/game/ui/theme';

const original = store.options.playerColor;

afterEach(() => {
  store.options.playerColor = original;
});

describe('player-colour UI theme', () => {
  it('follows the live player colour option', () => {
    store.options.playerColor = '#ff8000';
    expect(currentPlayerAccent()).toEqual(hexToRgb('#ff8000'));
    expect(cssColor(currentPlayerAccent())).toBe('rgb(255,128,0)');
    expect(currentAccentText()).toEqual(readableAccent(hexToRgb('#ff8000')));
  });

  it('rounds channels and supports translucent fills', () => {
    expect(cssColor([1, 0.5, 0])).toBe('rgb(255,127,0)');
    expect(cssColor([0, 1, 0], 0.25)).toBe('rgba(0,255,0,0.25)');
  });

  it('only repaints menus when the live accent moved visibly', () => {
    expect(accentMoved([0.2, 0.4, 0.6], [0.21, 0.4, 0.6])).toBe(false);
    expect(accentMoved([0.2, 0.4, 0.6], [0.4, 0.4, 0.6])).toBe(true);
  });

  it('lifts dark player colours for legible text without changing their hue', () => {
    const dark = hexToRgb('#400000');
    const lifted = readableAccent(dark);
    expect(rgbToHsv(lifted)[2]).toBeGreaterThanOrEqual(0.62);
    expect(rgbToHsv(lifted)[0]).toBeCloseTo(rgbToHsv(dark)[0], 5);
    const base = hexToRgb(DEFAULT_PLAYER_COLOR);
    const unchanged = readableAccent(base);
    expect(unchanged[0]).toBeCloseTo(base[0], 6);
    expect(unchanged[1]).toBeCloseTo(base[1], 6);
    expect(unchanged[2]).toBeCloseTo(base[2], 6);
  });
});
