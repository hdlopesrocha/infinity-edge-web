// Frustum extraction + primitive tests + octree hierarchical culling.

import { describe, expect, it } from 'vitest';
import { mat4 } from 'gl-matrix';
import {
  boxVisible, createFrustum, extractFrustum, frustumContains, rayBox, raySphere, sphereVisible,
} from '../src/engine/frustum';
import { ObKind, OctNode } from '../src/engine/octree';
import type { OctItem } from '../src/engine/octree';

function camera(eye: [number, number, number], at: [number, number, number]): ReturnType<typeof createFrustum> {
  const proj = mat4.create();
  mat4.perspective(proj, Math.PI / 4, 800 / 480, 0.1, 192);
  const view = mat4.create();
  mat4.lookAt(view, eye, at, [0, 1, 0]);
  const vp = mat4.create();
  mat4.multiply(vp, proj, view);
  return extractFrustum(vp, createFrustum());
}

function item(sx: number, sy: number, sz: number, r: number, kind = ObKind.Environment): OctItem & { name: string } {
  return {
    _octNode: null, kind, active: true, sx, sy, sz, sradius: r,
    name: `${sx},${sy},${sz}`,
  };
}

describe('frustum', () => {
  const f = camera([0, 0, 10], [0, 0, 0]);

  it('keeps objects inside the view volume', () => {
    expect(sphereVisible(f, 0, 0, 0, 1)).toBe(true);
    expect(sphereVisible(f, 0, 3, 0, 0.5)).toBe(true);
  });

  it('rejects objects behind the camera and outside the sides', () => {
    expect(sphereVisible(f, 0, 0, 60, 1)).toBe(false);       // behind
    expect(sphereVisible(f, 200, 0, 0, 1)).toBe(false);      // far right
    expect(sphereVisible(f, 0, 200, 0, 1)).toBe(false);      // far above
  });

  it('rejects objects past the far plane but keeps touching ones', () => {
    expect(sphereVisible(f, 0, 0, -191, 0.5)).toBe(false);   // beyond far (192)
    expect(sphereVisible(f, 0, 0, -180, 1)).toBe(true);      // just inside
  });

  it('does not clip objects whose sphere still intersects a plane', () => {
    // Centre outside the box but the sphere reaches back inside: must stay
    // visible, otherwise objects pop at the screen edges (culling contract).
    const outside = item(200, 0, 0, 0);
    expect(sphereVisible(f, 200, 0, 0, 0)).toBe(false);
    expect(sphereVisible(f, 200, 0, 0, 500)).toBe(true);
    void outside;
  });

  it('tests boxes against the same planes', () => {
    expect(boxVisible(f, -1, -1, -1, 1, 1, 1)).toBe(true);
    expect(boxVisible(f, 100, 100, 100, 101, 101, 101)).toBe(false);
  });

  it('frustumContains ignores the far plane (MyFrustumContains)', () => {
    expect(frustumContains(f, 0, 0, -400)).toBe(true);
    expect(frustumContains(f, 0, 0, 60)).toBe(false);
  });

  it('ray/sphere and ray/box return the near hit', () => {
    expect(raySphere(0, 0, 10, 0, 0, -1, 0, 0, 0, 1)).toBeCloseTo(9, 5);
    expect(raySphere(0, 0, 10, 0, 0, -1, 50, 0, 0, 1)).toBeNull();
    expect(rayBox(0, 0, 10, 0, 0, -1, -1, -1, -1, 1, 1, 1)).toBeCloseTo(9, 5);
    expect(rayBox(0, 0, 10, 1, 0, 0, -1, -1, -1, 1, 1, 1)).toBeNull();
  });
});

describe('octree culling', () => {
  function build(): { root: OctNode; items: OctItem[] } {
    const root = new OctNode(2048);
    const items: OctItem[] = [];
    // A grid of asteroids around the origin spanning both view directions.
    for (let i = 0; i < 500; i++) {
      const z = -400 + (i % 7) * 120;
      const a = item((i % 25) * 60 - 720, Math.floor(i / 25) * 60 - 600, z, 4);
      root.insert(a);
      items.push(a);
    }
    return { root, items };
  }

  it('selects only the objects inside the frustum', () => {
    const { root, items } = build();
    const f = camera([0, 0, 10], [0, 0, 0]);
    const out: OctItem[] = [];
    const stats = { culled: 0 };
    root.frustumSelect(f, out, stats);
    for (const o of out) expect(sphereVisible(f, o.sx, o.sy, o.sz, o.sradius)).toBe(true);
    expect(out.length + stats.culled).toBe(items.length);
    expect(stats.culled).toBeGreaterThan(0);
  });

  it('reports the same visibility without the stats counter', () => {
    const { root } = build();
    const f = camera([0, 0, 10], [0, 0, 0]);
    const withStats: OctItem[] = [];
    root.frustumSelect(f, withStats, { culled: 0 });
    const without: OctItem[] = [];
    root.frustumSelect(f, without);
    expect(without.length).toBe(withStats.length);
  });

  it('keeps large maps correct when the camera turns around', () => {
    const { root } = build();
    const forward = camera([0, 0, 10], [0, 0, 0]);
    const backward = camera([0, 0, -10], [0, 0, 400]);
    const a: OctItem[] = [];
    const b: OctItem[] = [];
    root.frustumSelect(forward, a);
    root.frustumSelect(backward, b);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    // Every selected object really is inside the volume it was tested against:
    // culling must never clip a sphere that still touches the screen edges.
    for (const o of a) expect(sphereVisible(forward, o.sx, o.sy, o.sz, o.sradius)).toBe(true);
    for (const o of b) expect(sphereVisible(backward, o.sx, o.sy, o.sz, o.sradius)).toBe(true);
  });

  it('honours _active only for uncollidable items (verbatim quirk)', () => {
    const root = new OctNode(2048);
    const off = item(0, 0, 0, 1, ObKind.Uncollidable);
    off.active = false;
    root.insert(off);
    const out: OctItem[] = [];
    const stats = { culled: 0 };
    root.frustumSelect(camera([0, 0, 10], [0, 0, 0]), out, stats);
    expect(out).toHaveLength(0);
    // Rejected-but-inactive items are not counted as culled either.
    expect(stats.culled).toBe(0);

    // Environment/interactive objects are removed from the tree by
    // Map.RemoveObject (which also clears _active), exactly like the original
    // OcTree.FrustumSelect which tests only uncollidable objects for _active.
    const env = item(0, 0, 0, 1, ObKind.Environment);
    env.active = false;
    root.insert(env);
    const out2: OctItem[] = [];
    root.frustumSelect(camera([0, 0, 10], [0, 0, 0]), out2);
    expect(out2).toContain(env);
    root.remove(env);
    const out3: OctItem[] = [];
    root.frustumSelect(camera([0, 0, 10], [0, 0, 0]), out3);
    expect(out3).toHaveLength(0);
  });

  it('inserts, refreshes and removes without losing objects', () => {
    const root = new OctNode(2048);
    const a = item(0, 0, 0, 2);
    root.insert(a);
    expect(a._octNode).not.toBeNull();
    a.sx = 500;
    root.refresh(a);
    const out: OctItem[] = [];
    root.frustumSelect(camera([500, 0, 20], [500, 0, 0]), out);
    expect(out).toContain(a);
    root.remove(a);
    expect(a._octNode).toBeNull();
    const after: OctItem[] = [];
    root.frustumSelect(camera([500, 0, 20], [500, 0, 0]), after);
    expect(after).not.toContain(a);
  });
});
