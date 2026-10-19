import { describe, expect, it } from 'vitest';
import { vec3 } from 'gl-matrix';
import {
  DWELL_MS, GazePointer, PANEL_H, PANEL_W, hitPanel, panelBasis,
} from '../src/engine/vrpanel';
import type { ScreenUi } from '../src/engine/overlay';

type Call = ['move' | 'down' | 'up', number, number, number, number];

function fakeUi(withPointer = true): { ui: ScreenUi; calls: Call[] } {
  const calls: Call[] = [];
  const ui: ScreenUi = {
    version: 1,
    paint: () => undefined,
  };
  if (withPointer) {
    ui.pointer = (kind, x, y, w, h) => {
      calls.push([kind, x, y, w, h]);
      return true;
    };
  }
  return { ui, calls };
}

const close = (a: ArrayLike<number>, b: ArrayLike<number>): void => {
  expect(a[0]).toBeCloseTo(b[0], 5);
  expect(a[1]).toBeCloseTo(b[1], 5);
  expect(a[2]).toBeCloseTo(b[2], 5);
};

describe('panelBasis', () => {
  it('places a camera-facing panel at the requested distance', () => {
    const b = panelBasis(vec3.fromValues(0, 0, 0), vec3.fromValues(0, 0, -1), 6);
    close(b.center, [0, 0, -6]);
    close(b.right, [1, 0, 0]);
    close(b.up, [0, 1, 0]);
    close(b.normal, [0, 0, 1]);
    expect(vec3.dot(b.right, b.up)).toBeCloseTo(0, 6);
    expect(vec3.length(b.right)).toBeCloseTo(1, 6);
    expect(vec3.length(b.up)).toBeCloseTo(1, 6);
  });

  it('turns the basis with a sideways view', () => {
    const b = panelBasis(vec3.fromValues(2, 3, 4), vec3.fromValues(1, 0, 0), 5);
    close(b.center, [7, 3, 4]);
    close(b.right, [0, 0, 1]);
    close(b.up, [0, 1, 0]);
    // Still camera-facing: the normal points back at the camera.
    expect(vec3.dot(b.normal, vec3.fromValues(1, 0, 0))).toBeCloseTo(-1, 6);
  });

  it('survives a degenerate camera direction (straight up)', () => {
    const b = panelBasis(vec3.fromValues(0, 0, 0), vec3.fromValues(0, 1, 0), 4);
    close(b.center, [0, 4, 0]);
    close(b.right, [1, 0, 0]);
    close(b.up, [0, 0, 1]);
    expect(Number.isFinite(b.up[0]) && Number.isFinite(b.up[1]) && Number.isFinite(b.up[2])).toBe(true);
  });
});

describe('hitPanel', () => {
  const basis = panelBasis(vec3.fromValues(0, 0, 0), vec3.fromValues(0, 0, -1), 6);
  const W = 8;
  const H = 4.5;

  it('maps a centre gaze to the middle of the UI', () => {
    const hit = hitPanel(vec3.fromValues(0, 0, 0), vec3.fromValues(0, 0, -1), basis, W, H);
    expect(hit).not.toBeNull();
    expect(hit!.x).toBeCloseTo(PANEL_W / 2, 5);
    expect(hit!.y).toBeCloseTo(PANEL_H / 2, 5);
    expect(hit!.distance).toBeCloseTo(6, 5);
    close(hit!.point, [0, 0, -6]);
  });

  it('maps left/right and up/down to UI pixels', () => {
    const left = hitPanel(vec3.fromValues(0, 0, 0), vec3.fromValues(-0.1, 0, -1), basis, W, H)!;
    const right = hitPanel(vec3.fromValues(0, 0, 0), vec3.fromValues(0.1, 0, -1), basis, W, H)!;
    const up = hitPanel(vec3.fromValues(0, 0, 0), vec3.fromValues(0, 0.1, -1), basis, W, H)!;
    expect(left.x).toBeLessThan(PANEL_W / 2);
    expect(right.x).toBeGreaterThan(PANEL_W / 2);
    expect(up.y).toBeLessThan(PANEL_H / 2);   // smaller y = higher on screen
    expect(left.y).toBeCloseTo(PANEL_H / 2, 5);
    expect(right.u).toBeGreaterThan(0);
    expect(up.v).toBeGreaterThan(0);
  });

  it('rejects rays outside the panel rectangle', () => {
    expect(hitPanel(vec3.fromValues(0, 0, 0), vec3.fromValues(1, 0, -1), basis, W, H)).toBeNull();
    expect(hitPanel(vec3.fromValues(0, 0, 0), vec3.fromValues(0, 1, -1), basis, W, H)).toBeNull();
  });

  it('rejects rays pointing away or parallel to the panel', () => {
    expect(hitPanel(vec3.fromValues(0, 0, 0), vec3.fromValues(0, 0, 1), basis, W, H)).toBeNull();
    expect(hitPanel(vec3.fromValues(0, 0, 0), vec3.fromValues(1, 0, 0), basis, W, H)).toBeNull();
  });

  it('honours the UI size passed in (panel gutter)', () => {
    const hit = hitPanel(vec3.fromValues(0, 0, 0), vec3.fromValues(0, 0, -1), basis, W, H, 800, 450)!;
    expect(hit.x).toBeCloseTo(400, 5);
    expect(hit.y).toBeCloseTo(225, 5);
  });
});

describe('GazePointer', () => {
  it('hovers and dwells into a click on the same spot', () => {
    const { ui, calls } = fakeUi();
    const g = new GazePointer(ui);
    expect(g.hover).toBeNull();
    // First hit only enters the panel; a deliberate move arms the dwell.
    expect(g.update({ x: 100, y: 120 }, 16)).toBe(false);
    expect(calls[0]).toEqual(['move', 100, 120, PANEL_W, PANEL_H]);
    g.update({ x: 140, y: 120 }, 16);
    let fired = false;
    for (let i = 0; i < 300 && !fired; i++) fired = g.update({ x: 140, y: 120 }, 16);
    expect(fired).toBe(true);
    const downs = calls.filter((c) => c[0] === 'down');
    const ups = calls.filter((c) => c[0] === 'up');
    expect(downs).toHaveLength(1);
    expect(ups).toHaveLength(1);
    expect(downs[0][1]).toBe(140);
    expect(downs[0][2]).toBe(120);
    expect(g.progress).toBe(0);
  });

  it('does not re-click while the gaze stays put after a click', () => {
    const { ui, calls } = fakeUi();
    const g = new GazePointer(ui);
    g.update({ x: 50, y: 50 }, 16);
    g.update({ x: 90, y: 50 }, 16);
    for (let i = 0; i < 300 && !g.update({ x: 90, y: 50 }, 16); i++) { /* dwell */ }
    const downs = calls.filter((c) => c[0] === 'down').length;
    expect(downs).toBe(1);
    for (let i = 0; i < 300; i++) expect(g.update({ x: 90, y: 50 }, 16)).toBe(false);
    expect(calls.filter((c) => c[0] === 'down')).toHaveLength(downs);
  });

  it('resets the dwell when the gaze moves past the slop', () => {
    const { ui } = fakeUi();
    const g = new GazePointer(ui);
    g.update({ x: 100, y: 100 }, 16);   // enter
    g.update({ x: 100, y: 100 }, 16);   // (no move yet: still disarmed)
    g.update({ x: 140, y: 100 }, 16);   // deliberate move: arms
    // 0.8 s on one spot...
    for (let i = 0; i < 50; i++) g.update({ x: 140, y: 100 }, 16);
    expect(g.progress).toBeGreaterThan(0.3);
    // ...then a deliberate move restarts the timer.
    g.update({ x: 200, y: 100 }, 16);
    expect(g.progress).toBeLessThan(0.05);
  });

  it('clears the hover when the gaze leaves the panel', () => {
    const { ui, calls } = fakeUi();
    const g = new GazePointer(ui);
    g.update({ x: 10, y: 10 }, 16);
    g.update(null, 16);
    expect(calls.some((c) => c[0] === 'move' && c[1] === -1 && c[2] === -1)).toBe(true);
    expect(g.hover).toBeNull();
    // Repeated misses do not spam the UI.
    const before = calls.length;
    g.update(null, 16);
    g.update(null, 16);
    expect(calls.length).toBe(before);
  });

  it('clicks immediately on a trigger at the current hover', () => {
    const { ui, calls } = fakeUi();
    const g = new GazePointer(ui);
    expect(g.click()).toBe(false);   // nothing hovered yet
    g.update({ x: 320, y: 240 }, 16);
    expect(g.click()).toBe(true);
    expect(calls.filter((c) => c[0] === 'down')).toHaveLength(1);
    expect(calls.filter((c) => c[0] === 'up')).toHaveLength(1);
    expect(g.progress).toBe(0);
  });

  it('reset clears the hover and the dwell state', () => {
    const { ui, calls } = fakeUi();
    const g = new GazePointer(ui);
    for (let i = 0; i < 30; i++) g.update({ x: 10, y: 20 }, 16);
    g.reset();
    expect(g.hover).toBeNull();
    expect(g.progress).toBe(0);
    expect(calls[calls.length - 1]).toEqual(['move', -1, -1, PANEL_W, PANEL_H]);
  });

  it('works with a ScreenUi that has no pointer handler', () => {
    const { ui } = fakeUi(false);
    const g = new GazePointer(ui);
    expect(() => {
      g.update({ x: 1, y: 2 }, 16);
      g.click();
      g.reset();
    }).not.toThrow();
    expect(g.size).toEqual({ w: PANEL_W, h: PANEL_H });
  });

  it('uses the dwell constant it advertises', () => {
    const { ui } = fakeUi();
    const g = new GazePointer(ui);
    g.update({ x: 0, y: 0 }, 10);      // enter
    g.update({ x: 100, y: 0 }, 10);    // arm
    // One ms short of the dwell must not click.
    const steps = Math.floor((DWELL_MS - 1) / 10);
    for (let i = 0; i < steps; i++) expect(g.update({ x: 100, y: 0 }, 10)).toBe(false);
    expect(g.progress).toBeLessThan(1);
    expect(g.update({ x: 100, y: 0 }, 10)).toBe(true);
  });

  it('needs a move before dwelling on a freshly shown screen', () => {
    const { ui, calls } = fakeUi();
    const g = new GazePointer(ui);
    // Stare at the same spot from the moment the screen appears: no click.
    for (let i = 0; i < 400; i++) expect(g.update({ x: 200, y: 200 }, 16)).toBe(false);
    expect(calls.filter((c) => c[0] === 'down')).toHaveLength(0);
    expect(g.progress).toBe(0);
    // A deliberate move arms it, and then the dwell works.
    g.update({ x: 260, y: 200 }, 16);
    let fired = false;
    for (let i = 0; i < 300 && !fired; i++) fired = g.update({ x: 260, y: 200 }, 16);
    expect(fired).toBe(true);
  });
});
