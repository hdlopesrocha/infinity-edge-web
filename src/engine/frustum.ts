// View-frustum extraction + tests (BoundingFrustum port).
// Scratch-plane API: no per-frame allocation in the culling path.

import type { mat4 } from './math';
import { vec3 } from './math';

export type FrustumPlanes = Float32Array; // 6 x [a,b,c,d]

export function createFrustum(): FrustumPlanes {
  return new Float32Array(24);
}

export function extractFrustum(vp: mat4, out: FrustumPlanes): FrustumPlanes {
  const m = vp as unknown as Float32Array;
  const rows = [
    [m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]],
    [m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]],
    [m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]],
    [m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]],
    [m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]],
    [m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]],
  ];
  for (let i = 0; i < 6; i++) {
    const p = rows[i];
    const len = Math.hypot(p[0], p[1], p[2]) || 1;
    out[i * 4] = p[0] / len;
    out[i * 4 + 1] = p[1] / len;
    out[i * 4 + 2] = p[2] / len;
    out[i * 4 + 3] = p[3] / len;
  }
  return out;
}

export function sphereVisible(f: FrustumPlanes, cx: number, cy: number, cz: number, radius: number): boolean {
  for (let i = 0; i < 6; i++) {
    if (f[i * 4] * cx + f[i * 4 + 1] * cy + f[i * 4 + 2] * cz + f[i * 4 + 3] < -radius) return false;
  }
  return true;
}

export function boxVisible(
  f: FrustumPlanes,
  minx: number, miny: number, minz: number,
  maxx: number, maxy: number, maxz: number,
): boolean {
  for (let i = 0; i < 6; i++) {
    const a = f[i * 4], b = f[i * 4 + 1], c = f[i * 4 + 2], d = f[i * 4 + 3];
    const px = a >= 0 ? maxx : minx;
    const py = b >= 0 ? maxy : miny;
    const pz = c >= 0 ? maxz : minz;
    if (a * px + b * py + c * pz + d < 0) return false;
  }
  return true;
}

/** Ray vs sphere: nearest distance or null (OcTree.RaySelect primitive). */
export function raySphere(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  cx: number, cy: number, cz: number, r: number,
): number | null {
  const ocx = cx - ox, ocy = cy - oy, ocz = cz - oz;
  const tca = ocx * dx + ocy * dy + ocz * dz;
  const d2 = ocx * ocx + ocy * ocy + ocz * ocz - tca * tca;
  if (d2 > r * r) return null;
  const thc = Math.sqrt(Math.max(0, r * r - d2));
  const t = tca - thc;
  return t >= 0 ? t : null;
}

/** Ray vs AABB slab test, nearest t or null. */
export function rayBox(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  minx: number, miny: number, minz: number, maxx: number, maxy: number, maxz: number,
): number | null {
  let tmin = 0, tmax = Infinity;
  const o = [ox, oy, oz], d = [dx, dy, dz], mn = [minx, miny, minz], mx = [maxx, maxy, maxz];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) {
      if (o[i] < mn[i] || o[i] > mx[i]) return null;
    } else {
      let t1 = (mn[i] - o[i]) / d[i];
      let t2 = (mx[i] - o[i]) / d[i];
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

/** Sphere-sphere intersection. */
export function spheresIntersect(
  ax: number, ay: number, az: number, ar: number,
  bx: number, by: number, bz: number, br: number,
): boolean {
  const dx = ax - bx, dy = ay - by, dz = az - bz;
  const rr = ar + br;
  return dx * dx + dy * dy + dz * dz <= rr * rr;
}

/** Sphere contains / disjoint / intersects classification for boxes. */
export function sphereContainsBox(
  cx: number, cy: number, cz: number, r: number,
  minx: number, miny: number, minz: number, maxx: number, maxy: number, maxz: number,
): 'contains' | 'disjoint' | 'intersects' {
  // farthest corner inside -> contains; nearest point outside -> disjoint
  let maxD2 = 0;
  for (const x of [minx, maxx]) {
    for (const y of [miny, maxy]) {
      for (const z of [minz, maxz]) {
        const dx = x - cx, dy = y - cy, dz = z - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > maxD2) maxD2 = d2;
      }
    }
  }
  if (maxD2 <= r * r) return 'contains';
  const nx = Math.max(minx, Math.min(cx, maxx));
  const ny = Math.max(miny, Math.min(cy, maxy));
  const nz = Math.max(minz, Math.min(cz, maxz));
  const dx = nx - cx, dy = ny - cy, dz = nz - cz;
  if (dx * dx + dy * dy + dz * dz > r * r) return 'disjoint';
  return 'intersects';
}

export { vec3 };
