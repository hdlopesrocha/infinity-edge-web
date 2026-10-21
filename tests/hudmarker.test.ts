// DOM HUD markers: the PNG is used as an alpha mask and filled with the
// marker's live team colour, so enemy icons follow the enemy-colour option
// (red by default in hard CTF) instead of showing the texture's white art.
import { describe, expect, it } from 'vitest';
import {
  cssUrl, markerBorderStyle, markerColor, markerIcon, markerIconStyle, markerStyle, oppositeColor,
} from '../src/game/hudmarker';

const OVER = 'assets/textures/_over.png';
const ENEMY: [number, number, number] = [1, 0, 0];
const PLAYER: [number, number, number] = [64 / 255, 224 / 255, 208 / 255];

describe('DOM HUD marker icons', () => {
  it('uses _over.png at 48x48 for on-screen ships, the object icon otherwise', () => {
    expect(markerIcon(
      { over: true, iconUrl: 'assets/textures/Fighter1_icon.png', w: 32, h: 40 },
      OVER,
    )).toEqual({ url: OVER, w: 48, h: 48 });
    expect(markerIcon(
      { over: false, iconUrl: 'assets/textures/Base_icon.png', w: 32, h: 32 },
      OVER,
    )).toEqual({ url: 'assets/textures/Base_icon.png', w: 32, h: 32 });
    expect(markerIcon({ over: false, iconUrl: null, w: 32, h: 32 }, OVER)).toBeNull();
  });

  it('fills the mask with the marker team colour, not the texture colours', () => {
    const url = 'assets/textures/Fighter1_icon.png';
    const enemy = markerIconStyle(
      { over: false, iconUrl: url, w: 32, h: 32, color: ENEMY },
      OVER,
    );
    expect(enemy).toContain('width:32px');
    expect(enemy).toContain('height:32px');
    expect(enemy).toContain('background-color:rgb(255,0,0)');
    expect(enemy).toContain(`mask-image:${cssUrl(url)}`);
    expect(enemy).toContain(`-webkit-mask-image:${cssUrl(url)}`);
    expect(enemy).toContain('mask-repeat:no-repeat');
    expect(enemy).toContain('mask-position:center');
    expect(enemy).toContain('mask-size:100% 100%');

    const friend = markerIconStyle(
      { over: true, iconUrl: url, w: 32, h: 32, color: PLAYER },
      OVER,
    );
    expect(friend).toContain('width:48px');
    expect(friend).toContain('height:48px');
    expect(friend).toContain('background-color:rgb(64,224,208)');
    expect(friend).toContain(`mask-image:${cssUrl(OVER)}`);
  });

  it('keeps the marker position and team-coloured glow', () => {
    expect(markerStyle({ x: 100, y: 50, color: ENEMY })).toBe(
      'left:100px;top:50px;transform:translate(-50%,-50%);filter:drop-shadow(0 0 3px rgb(255,0,0));',
    );
  });

  it('rounds channels like the GL HUD and quotes awkward URLs', () => {
    expect(markerColor([1, 0.5, 0])).toBe('rgb(255,127,0)');
    expect(oppositeColor(ENEMY)).toEqual([0, 1, 1]);
    expect(cssUrl('assets/a"b\\c.png')).toBe('url("assets/a\\"b\\\\c.png")');
  });

  it('draws an alpha-following inset border only for enemy markers', () => {
    const enemy = {
      over: false, iconUrl: 'assets/textures/Fighter1_icon.png',
      w: 32, h: 40, color: ENEMY, enemy: true,
    };
    const style = markerBorderStyle(enemy, OVER);
    expect(style).toContain('background-color:rgb(0,255,255)');
    expect(style).toContain('mask-composite:exclude');
    expect(style).toContain('-webkit-mask-composite:xor');
    expect(style).toContain('calc(100% - 2px) calc(100% - 2px)');
    expect(style).toContain(`mask-image:${cssUrl(enemy.iconUrl)},${cssUrl(enemy.iconUrl)}`);
    expect(markerBorderStyle({ ...enemy, enemy: false }, OVER)).toBe('');
    expect(markerBorderStyle({ ...enemy, iconUrl: null }, OVER)).toBe('');
  });
});
