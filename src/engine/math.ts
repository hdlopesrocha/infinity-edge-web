// Math: GetH/GetV verbatim (GetV = acos(y) - pi/2), YPR, parsers.

import { mat4, quat, vec3 } from 'gl-matrix';

export { mat4, quat, vec3 };

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export function getH(d: vec3): number {
  return Math.atan2(d[0], d[2]);
}

export function getV(d: vec3): number {
  return Math.acos(clamp(d[1] / (vec3.length(d) || 1), -1, 1)) - Math.PI / 2;
}

export function ypr(out: quat, yaw: number, pitch: number, roll: number): quat {
  const d = 180 / Math.PI;
  return quat.fromEuler(out, pitch * d, yaw * d, roll * d);
}

/** AIPoint steering (angle unclamped acos, verbatim; guarded only post-hoc). */
export function steerToward(
  rot: quat, currentDir: vec3, desiredDir: vec3, side: vec3, maxAngle: number,
): void {
  const t = vec3.create();
  vec3.normalize(t, desiredDir);
  const o = vec3.create();
  vec3.normalize(o, currentDir);
  let dot = vec3.dot(t, o);
  if (dot > 1 || dot < -1) dot = clamp(dot, -1, 1); // float-error guard (else NaN)
  const angle = Math.acos(dot);
  if (angle > 0.0001) {
    const ortho = vec3.create();
    vec3.cross(ortho, o, t);
    // |cross(o, t)| = sin(angle), so it collapses to float noise when the target
    // sits dead ahead or dead astern. The original only guarded the exact zero,
    // which left the ill-conditioned band (a target right behind) rotating about
    // a random axis: the turn stalls and the ship/missile flies off. Fall back
    // to a well-conditioned perpendicular axis (the ship's side) instead.
    if (vec3.length(ortho) < 0.05) {
      vec3.copy(ortho, side);
      const along = vec3.dot(ortho, o);
      vec3.scaleAndAdd(ortho, ortho, o, -along);
      if (vec3.length(ortho) < 1e-6) vec3.set(ortho, 0, 1, 0);
    }
    vec3.normalize(ortho, ortho);
    const step = quat.create();
    quat.setAxisAngle(step, ortho, Math.min(angle, maxAngle));
    quat.normalize(step, step);
    quat.multiply(rot, step, rot);
    quat.normalize(rot, rot);
  }
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

/** StringToVector3: null->zero, comma->THROW (verbatim). */
export function stringToVec3(s: string | null): vec3 {
  if (!s) return vec3.create();
  if (s.includes(',')) throw new Error('FormatException');
  const p = s.split('|').map(Number);
  return vec3.fromValues(p[0] || 0, p[1] || 0, p[2] || 0);
}

export function stringToVec2(s: string | null): [number, number] {
  if (!s) return [0, 0];
  const p = s.split('|').map(Number);
  return [p[0] || 0, p[1] || 0];
}

/** StringToColor: 3 comps RGB, 4 comps RGBA (0-255). */
export function stringToColor(s: string | null): [number, number, number, number] {
  if (!s) return [1, 1, 1, 1];
  const p = s.split('|').map(Number);
  if (p.length === 3) return [(p[0] || 0) / 255, (p[1] || 0) / 255, (p[2] || 0) / 255, 1];
  return [(p[0] || 0) / 255, (p[1] || 0) / 255, (p[2] || 0) / 255, (p[3] ?? 255) / 255];
}

export function stringToQuat(s: string | null): quat {
  if (!s) return quat.create();
  const p = s.split('|').map(Number);
  return quat.fromValues(p[0] || 0, p[1] || 0, p[2] || 0, p[3] === undefined ? 1 : p[3]);
}

export function compose(out: mat4, pos: vec3, rot: quat, scale: number): mat4 {
  return mat4.fromRotationTranslationScale(out, rot, pos, vec3.fromValues(scale, scale, scale));
}
