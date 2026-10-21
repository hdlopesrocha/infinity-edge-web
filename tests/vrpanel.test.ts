import { describe, expect, it } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import {
  DWELL_MS, GazePointer, PANEL_H, PANEL_W, cyclopsView, hitPanel, panelBasis,
  planeFitScale, withClipRect,
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

describe('planeFitScale', () => {
  const proj = (fovDeg: number): Float32Array => mat4.perspective(
    mat4.create(), fovDeg * Math.PI / 180, 1, 0.1, 100,
  ) as Float32Array;

  it('shrinks a too-wide menu panel to leave a focus-frame margin', () => {
    // 90-degree eye: 8 units at 3 units would project to +-1.33 NDC. The fit
    // keeps the edge at 0.86 NDC and leaves 7% of the half-view each side.
    const s = planeFitScale([proj(90)], 8, 4.5, 3, 0.86);
    expect(s).toBeCloseTo(5.16 / 8, 5);
    expect((8 * s / 2 / 3)).toBeCloseTo(0.86, 5);
  });

  it('leaves a panel that already fits untouched', () => {
    const s = planeFitScale([proj(120)], 8, 4.5, 3, 0.86);
    expect(s).toBe(1);
  });

  it('shrinks harder on a narrow eye FOV', () => {
    const s = planeFitScale([proj(60)], 8, 4.5, 3, 0.86);
    expect(s).toBeCloseTo(2 * 3 * 0.86 * Math.tan(Math.PI / 6) / 8, 5);
    expect(s).toBeLessThan(0.4);
  });

  it('reserves the margin on the tighter side of an asymmetric eye', () => {
    // Off-axis projection: the NDC centre is shifted +0.2, so the left edge
    // reaches the viewport sooner. The fit must use the smaller margin.
    const p = mat4.frustum(
      mat4.create(), -0.08, 0.12, -0.1, 0.1, 0.1, 100,
    ) as Float32Array;
    const s = planeFitScale([p], 8, 4.5, 3, 0.86);
    expect(s).toBeCloseTo((2 * 3 * (0.86 - 0.2)) / 8, 5);
  });

  it('uses the most restrictive eye and ignores bad matrices', () => {
    const bad = new Float32Array(16);
    const s = planeFitScale([bad, proj(90), proj(70)], 8, 4.5, 3, 0.86);
    const narrow = 2 * 3 * 0.86 * Math.tan(35 * Math.PI / 180) / 8;
    expect(s).toBeCloseTo(narrow, 5);
  });

  it('returns the identity for degenerate inputs', () => {
    expect(planeFitScale([], 8, 4.5, 3)).toBe(1);
    expect(planeFitScale([proj(90)], 0, 4.5, 3)).toBe(1);
    expect(planeFitScale([proj(90)], 8, 4.5, 0)).toBe(1);
  });

  it('keeps the apparent rectangle when distance and world size halve together', () => {
    // The VR menu now sits at half the distance with half the world size. The
    // fitted scale must be identical, so the screen-space focus rect and blur
    // feather remain calibrated.
    expect(planeFitScale([proj(90)], 4, 2.25, 1.5, 0.86))
      .toBeCloseTo(planeFitScale([proj(90)], 8, 4.5, 3, 0.86), 10);
    expect(planeFitScale([proj(120)], 4, 2.25, 1.5, 0.86))
      .toBeCloseTo(planeFitScale([proj(120)], 8, 4.5, 3, 0.86), 10);
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

describe('cyclopsView', () => {
  it('sits at the midpoint of the composed eye positions', () => {
    // Same composition as the eye loop (inverse eye view * chase); the inverse
    // of the resulting view is where the eye actually renders.
    const chase = mat4.create();
    const left = mat4.fromTranslation(mat4.create(), [0.03, 0, 5]);
    const right = mat4.fromTranslation(mat4.create(), [-0.03, 0, 5]);
    const c = cyclopsView([left, right], 0, chase);
    expect(c.center[0]).toBeCloseTo(0, 5);
    expect(c.center[2]).toBeCloseTo(5, 5);
    // The returned view maps the rendered head centre to the origin.
    const p = vec3.transformMat4(vec3.create(), c.center, c.view);
    expect(p[0]).toBeCloseTo(0, 5);
    expect(p[1]).toBeCloseTo(0, 5);
    expect(p[2]).toBeCloseTo(0, 5);
    expect(c.view[14]).toBeCloseTo(-5, 5);
  });

  it('uses the composed chase view, not the raw room pose', () => {
    // The chase composition moves the rendered eye away from the raw pose.
    const chase = mat4.fromTranslation(mat4.create(), [0, 0, 4]);
    const eye = mat4.fromTranslation(mat4.create(), [0, 0, 5]);
    const raw = cyclopsView([eye, eye], 0, mat4.create());
    const composed = cyclopsView([eye, eye], 0, chase);
    expect(composed.center[2]).not.toBeCloseTo(raw.center[2], 5);
    expect(composed.center[2]).toBeCloseTo(1, 5);
  });
});

describe('withClipRect', () => {
  function fakeGl(): { gl: WebGL2RenderingContext; calls: string[] } {
    const calls: string[] = [];
    const gl = {
      SCISSOR_TEST: 3089,
      enable: (cap: number) => calls.push('enable:' + cap),
      disable: (cap: number) => calls.push('disable:' + cap),
      scissor: (x: number, y: number, w: number, h: number) => calls.push(`scissor:${x},${y},${w},${h}`),
      viewport: (x: number, y: number, w: number, h: number) => calls.push(`viewport:${x},${y},${w},${h}`),
    } as unknown as WebGL2RenderingContext;
    return { gl, calls };
  }

  it('clips the eye rectangle and always clears the scissor afterwards', () => {
    const { gl, calls } = fakeGl();
    withClipRect(gl, { x: 10, y: 0, w: 100, h: 80 }, () => calls.push('draw'));
    expect(calls).toEqual([
      'enable:3089',
      'scissor:10,0,100,80',
      'viewport:10,0,100,80',
      'draw',
      'disable:3089',
    ]);
  });

  it('clears the scissor even when the overlay draw throws', () => {
    const { gl, calls } = fakeGl();
    expect(() => withClipRect(gl, { x: 0, y: 0, w: 1, h: 1 }, () => {
      throw new Error('boom');
    })).toThrow('boom');
    expect(calls[calls.length - 1]).toBe('disable:3089');
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

  it('keeps dwelling while the head rotates inside the same target', () => {
    let target = 'button:a';
    const { ui } = fakeUi();
    ui.gazeTarget = () => target;
    const g = new GazePointer(ui);
    g.update({ x: 400, y: 450 }, 16);   // enter
    g.update({ x: 440, y: 450 }, 16);   // arm
    for (let i = 0; i < 60; i++) g.update({ x: 440, y: 450 }, 16); // ~1 s
    const before = g.progress;
    expect(before).toBeGreaterThan(0.4);
    // 100 px is far beyond the old reset box, but it is still the same button.
    g.update({ x: 540, y: 450 }, 16);
    expect(g.progress).toBeGreaterThan(before);
    // The 2 s timer is not restarted by that rotation.
    let fired = false;
    for (let i = 0; i < 120 && !fired; i++) fired = g.update({ x: 540, y: 450 }, 16);
    expect(fired).toBe(true);
  });

  it('restarts the dwell when the crosshair acquires another target', () => {
    let target = 'button:a';
    const { ui } = fakeUi();
    ui.gazeTarget = () => target;
    const g = new GazePointer(ui);
    g.update({ x: 400, y: 450 }, 16);
    g.update({ x: 440, y: 450 }, 16);
    for (let i = 0; i < 60; i++) g.update({ x: 440, y: 450 }, 16);
    expect(g.progress).toBeGreaterThan(0.4);
    target = 'button:b';
    expect(g.update({ x: 520, y: 450 }, 16)).toBe(false);
    expect(g.progress).toBe(0);
  });

  it('does not accumulate dwell while the crosshair is off a target', () => {
    let target: string | null = null;
    const { ui, calls } = fakeUi();
    ui.gazeTarget = () => target;
    const g = new GazePointer(ui);
    g.update({ x: 400, y: 450 }, 16);
    g.update({ x: 440, y: 450 }, 16);
    for (let i = 0; i < 300; i++) expect(g.update({ x: 440, y: 450 }, 16)).toBe(false);
    expect(g.progress).toBe(0);
    expect(calls.filter((c) => c[0] === 'down')).toHaveLength(0);
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

  it('uses the default dwell time it advertises', () => {
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

  it('honours a configured dwell time and can change it live', () => {
    const { ui } = fakeUi();
    const g = new GazePointer(ui, PANEL_W, PANEL_H, 500);
    g.update({ x: 0, y: 0 }, 16);      // enter
    g.update({ x: 100, y: 0 }, 16);    // arm
    for (let i = 0; i < 30; i++) expect(g.update({ x: 100, y: 0 }, 16)).toBe(false); // 480 ms
    expect(g.update({ x: 100, y: 0 }, 16)).toBe(false); // 496 ms
    expect(g.update({ x: 100, y: 0 }, 16)).toBe(true);  // 512 ms
    // Changing the setting resets a partial dwell and applies immediately.
    const h = new GazePointer(ui);
    h.update({ x: 0, y: 0 }, 16);
    h.update({ x: 100, y: 0 }, 16);
    for (let i = 0; i < 20; i++) h.update({ x: 100, y: 0 }, 16);
    expect(h.progress).toBeGreaterThan(0);
    h.setDwellMs(500);
    expect(h.progress).toBe(0);
    for (let i = 0; i < 30; i++) expect(h.update({ x: 100, y: 0 }, 16)).toBe(false);
    expect(h.update({ x: 100, y: 0 }, 16)).toBe(false); // 496 ms
    expect(h.update({ x: 100, y: 0 }, 16)).toBe(true);  // 512 ms
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
