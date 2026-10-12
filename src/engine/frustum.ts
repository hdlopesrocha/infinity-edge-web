// CPU view-frustum culling, port of BoundingFrustum usage in Map.Draw /
// Model3D.Intersects. Planes extracted from the view-projection matrix each
// frame; objects tested as spheres (broadphase) then boxes (narrow).
// No per-frame allocation: caller passes scratch plane storage.

import { mat4, vec3 } from 'gl-matrix';

export type FrustumPlanes = Float32Array; // 6 x [a,b,c,d], length 24

export function createFrustum(): FrustumPlanes {
  return new Float32Array(24);
}

/** Extract normalized planes from column-major VP matrix (Gribb/Hartmann). */
export function extractFrustum(vp: mat4, out: FrustumPlanes): FrustumPlanes {
  const m = vp as unknown as Float32Array;
  // rows of the matrix
  const planes = [
    [m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]], // left? (actually right/left pair)
    [m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]],
    [m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]],
    [m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]],
    [m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]],
    [m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]],
  ];
  for (let i = 0; i < 6; i++) {
    const p = planes[i];
    const len = Math.hypot(p[0], p[1], p[2]) || 1;
    out[i * 4] = p[0] / len;
    out[i * 4 + 1] = p[1] / len;
    out[i * 4 + 2] = p[2] / len;
    out[i * 4 + 3] = p[3] / len;
  }
  return out;
}

/** Sphere test: true when visible (mirrors Model3D coarse _bsphere test). */
export function sphereVisible(f: FrustumPlanes, c: vec3, radius: number): boolean {
  for (let i = 0; i < 6; i++) {
    const d =
      f[i * 4] * c[0] + f[i * 4 + 1] * c[1] + f[i * 4 + 2] * c[2] + f[i * 4 + 3];
    if (d < -radius) return false;
  }
  return true;
}

/** AABB test (min/max world). True when visible. */
export function boxVisible(
  f: FrustumPlanes,
  min: vec3,
  max: vec3,
): boolean {
  for (let i = 0; i < 6; i++) {
    const a = f[i * 4];
    const b = f[i * 4 + 1];
    const c = f[i * 4 + 2];
    const d = f[i * 4 + 3];
    // positive vertex
    const px = a >= 0 ? max[0] : min[0];
    const py = b >= 0 ? max[1] : min[1];
    const pz = c >= 0 ? max[2] : min[2];
    if (a * px + b * py + c * pz + d < 0) return false;
  }
  return true;
}

/** Distance from camera, for far-to-near sort (ObjectDistanceComparer). */
export function distToCamSq(camPos: vec3, p: vec3): number {
  const dx = p[0] - camPos[0];
  const dy = p[1] - camPos[1];
  const dz = p[2] - camPos[2];
  return dx * dx + dy * dy + dz * dz;
}
