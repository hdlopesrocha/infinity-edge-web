// Physics helpers: port of Object3D.NextPosition + SpaceObject.Move/BulletHit.
// Sphere-only collisions, no rigid bodies — matches the original.

import { vec3 } from 'gl-matrix';

export interface Body {
  pos: vec3;
  vel: vec3;
  accel: vec3;
  friction: number; // per-second damping factor base
  maxSpeed: number;
  multiplier: number; // nitro multiplier, lerps back to 1
  radius: number;
}

/** Advance one body (Object3D.NextPosition: vel += (a*mult - friction*v) dt). */
export function nextPosition(b: Body, dtMs: number): void {
  const dt = dtMs / 1000;
  const m = b.multiplier;
  // accel*multiplier - friction*velocity
  const ax = b.accel[0] * m - b.friction * b.vel[0];
  const ay = b.accel[1] * m - b.friction * b.vel[1];
  const az = b.accel[2] * m - b.friction * b.vel[2];
  b.vel[0] += ax * dt;
  b.vel[1] += ay * dt;
  b.vel[2] += az * dt;
  const cap = b.maxSpeed * m;
  const sp = vec3.length(b.vel);
  if (sp > cap && sp > 0) vec3.scale(b.vel, b.vel, cap / sp);
  b.pos[0] += b.vel[0] * dt;
  b.pos[1] += b.vel[1] * dt;
  b.pos[2] += b.vel[2] * dt;
  // multiplier lerps back to 1 (LaunchNitro sets 7.5).
  if (b.multiplier > 1) b.multiplier = Math.max(1, b.multiplier - dt * 2);
}

/** Sphere-sphere hit test (BulletHit narrow phase). */
export function spheresHit(aPos: vec3, aR: number, bPos: vec3, bR: number): boolean {
  const dx = aPos[0] - bPos[0];
  const dy = aPos[1] - bPos[1];
  const dz = aPos[2] - bPos[2];
  const rr = aR + bR;
  return dx * dx + dy * dy + dz * dz <= rr * rr;
}

/** Intercept direction for homing/AI lead (PreviewDirection quadratic). */
export function interceptDirection(
  out: vec3,
  from: vec3,
  target: vec3,
  targetVel: vec3,
  shotSpeed: number,
): boolean {
  const dx = target[0] - from[0];
  const dy = target[1] - from[1];
  const dz = target[2] - from[2];
  const tvx = targetVel[0];
  const tvy = targetVel[1];
  const tvz = targetVel[2];
  const a = tvx * tvx + tvy * tvy + tvz * tvz - shotSpeed * shotSpeed;
  const b = 2 * (dx * tvx + dy * tvy + dz * tvz);
  const c = dx * dx + dy * dy + dz * dz;
  let t = 0;
  if (Math.abs(a) < 1e-6) {
    t = c / Math.max(1e-6, -b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return false;
    const sq = Math.sqrt(disc);
    const t1 = (-b + sq) / (2 * a);
    const t2 = (-b - sq) / (2 * a);
    t = Math.min(t1 > 0 ? t1 : Infinity, t2 > 0 ? t2 : Infinity);
    if (!isFinite(t)) return false;
  }
  out[0] = dx + tvx * t;
  out[1] = dy + tvy * t;
  out[2] = dz + tvz * t;
  vec3.normalize(out, out);
  return true;
}

/** Keep a position inside the cubic world (+-size/2, Map.PositionInside). */
export function clampInside(pos: vec3, size: number): boolean {
  const h = size / 2;
  let clamped = false;
  for (let i = 0; i < 3; i++) {
    if (pos[i] < -h) {
      pos[i] = -h;
      clamped = true;
    } else if (pos[i] > h) {
      pos[i] = h;
      clamped = true;
    }
  }
  return clamped;
}
