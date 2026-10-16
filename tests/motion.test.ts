// Motion-blur conventions (src/engine/motion.ts): the contract the GLSL
// mirrors. These pin down the maths so a future edit cannot silently flip the
// direction, drop a perspective divide or scale by delta time.

import { describe, expect, it } from 'vitest';
import {
  MOTION_BLUR,
  MIN_CLIP_W,
  clipToUV,
  depthCompatible,
  exposureSample,
  exposureShutter,
  linearizeDepth,
  ndcToUV,
  velocityUV,
} from '../src/engine/motion';

/** Minimal column-major perspective projection (right-handed, GL convention). */
function perspective(fovY: number, aspect: number, near: number, far: number): number[] {
  const f = 1 / Math.tan(fovY / 2);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0];
}

function multiply(a: number[], b: number[]): number[] {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

function transform(m: number[], x: number, y: number, z: number): number[] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
}

const proj = perspective(Math.PI / 4, 4 / 3, 0.1, 192);

describe('motion-vector convention', () => {
  it('maps NDC to UV with +Y up and a 0.5 scale/bias', () => {
    expect(ndcToUV(0, 0)).toEqual([0.5, 0.5]);
    expect(ndcToUV(-1, -1)).toEqual([0, 0]);
    expect(ndcToUV(1, 1)).toEqual([1, 1]);
  });

  it('divides each clip position by its own w', () => {
    // same NDC, different w: the UV must agree, the clip xy differ
    const a = clipToUV([0.2 * 4, -0.1 * 4, 0, 4]);
    const b = clipToUV([0.2 * 40, -0.1 * 40, 0, 40]);
    expect(a[0]).toBeCloseTo(b[0], 6);
    expect(a[1]).toBeCloseTo(b[1], 6);
  });

  it('keeps near-zero and negative w finite (clipped geometry must not leak inf)', () => {
    for (const w of [0, -1e-9, -5]) {
      const uv = clipToUV([1, 1, 0, w]);
      expect(Number.isFinite(uv[0])).toBe(true);
      expect(Number.isFinite(uv[1])).toBe(true);
      expect(Math.abs(uv[0])).toBeLessThanOrEqual(1e4);
    }
    expect(clipToUV([0, 0, 0, -3])).toEqual(clipToUV([0, 0, 0, MIN_CLIP_W]));
  });

  it('is currentUV - previousUV: the direction content moves on screen', () => {
    // A point 10 units ahead of the camera that moved +0.5 units in view X
    // between the two frames: its previous clip x is to the left of its
    // current one, so the velocity points right (+x) with no vertical part.
    const cur = [0, 0, 0, 10];
    const prev = [-0.905, 0, 0, 10];
    const v = velocityUV(cur, prev);
    expect(v[0]).toBeGreaterThan(0);
    expect(v[1]).toBe(0);
    expect(v[0]).toBeCloseTo(0.04525, 4);
  });

  it('reports zero motion when the two frames agree (history reset)', () => {
    const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -10, 1];
    const clip = transform(multiply(proj, view), 1, 2, 0);
    expect(velocityUV(clip, clip)).toEqual([0, 0]);
  });

  it('does not scale with delta time: the same two poses give the same vector', () => {
    const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -10, 1];
    const vp = multiply(proj, view);
    const a = transform(vp, 0, 0, 0);
    const b = transform(vp, 1, 0, 0);
    const once = velocityUV(b, a);
    const twice = velocityUV(b, a); // "another dt" must not change it
    expect(twice).toEqual(once);
  });
});

describe('exposure model', () => {
  it('converts exposure seconds into a fraction of the measured frame', () => {
    expect(exposureShutter(1 / 60, 1 / 60)).toBeCloseTo(1, 6);
    expect(exposureShutter(1 / 60, 1 / 30)).toBeCloseTo(0.5, 6);
    expect(exposureShutter(1 / 60, 1 / 120)).toBeCloseTo(2, 6);
  });

  it('clamps degenerate frame intervals', () => {
    expect(exposureShutter(1 / 60, 0)).toBeLessThanOrEqual(3);
    expect(exposureShutter(1 / 60, 10)).toBeGreaterThanOrEqual(0.35);
  });

  it('uses a trailing exposure: every sample lies behind the pixel', () => {
    const uv: [number, number] = [0.5, 0.5];
    const velocity: [number, number] = [0.1, 0];
    const start = exposureSample(uv, velocity, 1, -1);
    const end = exposureSample(uv, velocity, 1, 0);
    expect(end).toEqual(uv);
    // the start of the exposure is opposite to the direction of motion
    expect(start[0]).toBeLessThan(uv[0]);
    expect(start[0]).toBeCloseTo(uv[0] - 0.1, 9);
  });

  it('ships a documented default of 1.5 x the nominal 1/60 s frame', () => {
    expect(MOTION_BLUR.exposureSeconds).toBeCloseTo(1.5 / 60, 9);
    expect(MOTION_BLUR.samples).toBeGreaterThanOrEqual(2);
    expect(MOTION_BLUR.samples).toBeLessThanOrEqual(32);
    expect(MOTION_BLUR.maxRadiusUV).toBeGreaterThan(0);
  });
});

describe('depth compatibility', () => {
  it('accepts the same surface and rejects a different one', () => {
    expect(depthCompatible(10, 10.1, 0.05)).toBe(true);
    expect(depthCompatible(10, 40, 0.05)).toBe(false);
    expect(depthCompatible(100, 104, 0.05)).toBe(true);
    expect(depthCompatible(100, 120, 0.05)).toBe(false);
  });

  it('linearizes the window depth back to view distance', () => {
    expect(linearizeDepth(0, 0.1, 192)).toBeCloseTo(0.1, 6);   // near plane
    expect(linearizeDepth(1, 0.1, 192)).toBeCloseTo(192, 3);   // far plane
    const mid = linearizeDepth(0.5, 0.1, 192);
    expect(mid).toBeGreaterThan(0.1);
    expect(mid).toBeLessThan(192);
  });
});
