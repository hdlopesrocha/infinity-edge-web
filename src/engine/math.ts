// Math helpers: port of IE3D_API/Maths.cs + quaternion conventions.
// World: Y-up, forward +Z (Object3D: Direction = quat * UnitZ).
// XNA CreateFromYawPitchRoll(yaw,pitch,roll) == quat(yaw) * quat(pitch) * quat(roll).

import { mat4, quat, vec3 } from 'gl-matrix';

export { mat4, quat, vec3 };

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Yaw of a direction: atan2(x, z) — faces +Z at yaw 0. */
export function getH(d: vec3): number {
  return Math.atan2(d[0], d[2]);
}

/** Pitch of a direction: asin(-y/len). */
export function getV(d: vec3): number {
  const l = vec3.length(d) || 1;
  return Math.asin(clamp(-d[1] / l, -1, 1));
}

/** XNA Quaternion.CreateFromYawPitchRoll (radians). gl-matrix fromEuler takes degrees. */
export function ypr(out: quat, yaw: number, pitch: number, roll: number): quat {
  const d = 180 / Math.PI;
  return quat.fromEuler(out, pitch * d, yaw * d, roll * d);
}

/** Rotate current facing toward a desired direction, capped by maxAngle (AIPoint). */
export function steerToward(
  rot: quat,
  currentDir: vec3,
  desiredDir: vec3,
  side: vec3,
  maxAngle: number,
): boolean {
  const t = vec3.create();
  vec3.normalize(t, desiredDir);
  const o = vec3.create();
  vec3.normalize(o, currentDir);
  const dot = clamp(vec3.dot(t, o), -1, 1);
  const angle = Math.acos(dot);
  if (angle > 0.0001) {
    const ortho = vec3.create();
    vec3.cross(ortho, o, t);
    if (vec3.length(ortho) < 1e-9) vec3.copy(ortho, side);
    vec3.normalize(ortho, ortho);
    const step = quat.create();
    quat.setAxisAngle(step, ortho, Math.min(angle, maxAngle));
    quat.normalize(step, step);
    quat.multiply(rot, step, rot);
    quat.normalize(rot, rot);
    return true;
  }
  return false;
}

export function dirFromQuat(out: vec3, q: quat): vec3 {
  return vec3.transformQuat(out, vec3.fromValues(0, 0, 1), q);
}

export function sideFromQuat(out: vec3, q: quat): vec3 {
  return vec3.transformQuat(out, vec3.fromValues(1, 0, 0), q);
}

export function upFromQuat(out: vec3, q: quat): vec3 {
  return vec3.transformQuat(out, vec3.fromValues(0, 1, 0), q);
}

/** "x|y|z" -> vec3 (Maths.StringToVector3). null -> zero. */
export function stringToVec3(s: string | null): vec3 {
  if (!s) return vec3.create();
  const p = s.split('|').map(Number);
  return vec3.fromValues(p[0] || 0, p[1] || 0, p[2] || 0);
}

/** "x|y|z|w" -> quat (Maths.StringToQuaternion). null -> identity. */
export function stringToQuat(s: string | null): quat {
  if (!s) return quat.create();
  const p = s.split('|').map(Number);
  return quat.fromValues(p[0] || 0, p[1] || 0, p[2] || 0, p[3] === undefined ? 1 : p[3]);
}

/** "r|g|b" ints 0..255 -> [r,g,b] 0..1 (Maths.StringToColor). */
export function stringToColor(s: string | null): [number, number, number] {
  if (!s) return [1, 1, 1];
  const p = s.split('|').map(Number);
  return [(p[0] || 0) / 255, (p[1] || 0) / 255, (p[2] || 0) / 255];
}

/** Deterministic RNG (mulberry32) for level scatter. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random integer in [lo, hi) — mirrors Maths._random.Next(lo, hi). */
export function randInt(r: () => number, lo: number, hi: number): number {
  return lo + Math.floor(r() * (hi - lo));
}

/** compose world matrix: XNA (R * S * T, row-major) == T * S * R column-major. */
export function compose(out: mat4, pos: vec3, rot: quat, scale: number): mat4 {
  const s = vec3.fromValues(scale, scale, scale);
  return mat4.fromRotationTranslationScale(out, rot, pos, s);
}
