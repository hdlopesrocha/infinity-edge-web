// UI focus veil geometry: the flat menu content island and the projection of
// the world-space VR panel/HUD rectangle into an eye's UV.
import { describe, expect, it } from 'vitest';
import { mat4 } from 'gl-matrix';
import { contentFocusRect, FOCUS_H, FOCUS_W, FOCUS_X, FOCUS_Y } from '../src/game/ui/layout';
import { projectedPlaneRect } from '../src/engine/vrpanel';

describe('contentFocusRect', () => {
  it('maps the content-panel strip through the 16:9 design scale', () => {
    expect(FOCUS_X).toBe(200);
    expect(FOCUS_Y).toBe(104);
    expect(FOCUS_W).toBe(1040);
    expect(FOCUS_H).toBe(512);
    const r = contentFocusRect(1600, 900);
    expect(r).toEqual({ x: 250, y: 130, w: 1300, h: 640 });
  });

  it('follows the letterbox offset on a wider canvas', () => {
    const r = contentFocusRect(2000, 720);
    // 1280x720 design is centred with 360 px bars on each side.
    expect(r).toEqual({ x: 560, y: 104, w: 1040, h: 512 });
    expect(r.x + r.w / 2).toBeCloseTo(1080, 5);
  });
});

describe('projectedPlaneRect', () => {
  it('projects a centred world rectangle to the middle half of the view', () => {
    const view = mat4.create();
    const proj = mat4.ortho(mat4.create(), -2, 2, -2, 2, -1, 1);
    const r = projectedPlaneRect(
      view, proj, new Float32Array([0, 0, 0]), new Float32Array([1, 0, 0]),
      new Float32Array([0, 1, 0]), 1, 1,
    )!;
    expect(r.x).toBeCloseTo(0.25, 6);
    expect(r.y).toBeCloseTo(0.25, 6);
    expect(r.w).toBeCloseTo(0.5, 6);
    expect(r.h).toBeCloseTo(0.5, 6);
  });

  it('uses the panel basis so an off-centre panel moves in UV', () => {
    const view = mat4.create();
    const proj = mat4.ortho(mat4.create(), -2, 2, -2, 2, -1, 1);
    const r = projectedPlaneRect(
      view, proj, new Float32Array([0.5, 0, 0]), new Float32Array([1, 0, 0]),
      new Float32Array([0, 1, 0]), 0.5, 0.5,
    )!;
    expect(r.x).toBeCloseTo(0.5, 6);
    expect(r.w).toBeCloseTo(0.25, 6);
    expect(r.y).toBeCloseTo(0.375, 6);
    expect(r.h).toBeCloseTo(0.25, 6);
  });

  it('returns null when the panel is behind the perspective eye', () => {
    const view = mat4.create();
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    expect(projectedPlaneRect(
      view, proj, new Float32Array([0, 0, 4]), new Float32Array([1, 0, 0]),
      new Float32Array([0, 1, 0]), 1, 1,
    )).toBeNull();
  });
});
