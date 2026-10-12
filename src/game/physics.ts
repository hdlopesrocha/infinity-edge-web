// Physics presets (Physics.cs verbatim) + NextPosition integration +
// intercept solver (PreviewDirection) + cubic clamp.

import { ObKind } from '../engine/octree';
import { vec3 } from '../engine/math';

export class Physics {
  constructor(
    public accelMax: number,
    public velMax: number,
    public maxAngular: number,
    public reSpawns: boolean,
    public collector: boolean,
    public objectType: ObKind,
  ) {}
}

export const P = {
  SSTT: new Physics(128, 32, 0.1, false, true, ObKind.Interactive),
  SS1: new Physics(128, 64, 0.05, false, true, ObKind.Interactive),
  SS1R: new Physics(128, 64, 0.05, true, true, ObKind.Interactive),
  FRAG: new Physics(0, 30, 0, false, false, ObKind.Uncollidable),
  STATIC: new Physics(0, 0, 0, false, false, ObKind.Environment),
  ISTATIC: new Physics(0, 0, 0, false, false, ObKind.Interactive),
  BULLET: new Physics(1024, 256, 0, false, false, ObKind.Uncollidable),
  MISSILE: new Physics(512, 1024, 0.1, false, false, ObKind.Uncollidable),
  EMPTY: new Physics(0, 0, 0, false, false, ObKind.Uncollidable),
};

export interface BodyState {
  pos: vec3;
  vel: vec3;
  accel: vec3;
  multiplier: number;
  friction: number; // model._friction (1)
  physics: Physics;
}

/** Object3D.NextPosition verbatim (dt in ms). */
export function nextPosition(b: BodyState, dtMs: number): void {
  const dt = dtMs / 1000;
  const m = b.multiplier;
  const ax = b.accel[0] * m - b.friction * b.vel[0];
  const ay = b.accel[1] * m - b.friction * b.vel[1];
  const az = b.accel[2] * m - b.friction * b.vel[2];
  b.vel[0] += ax * dt;
  b.vel[1] += ay * dt;
  b.vel[2] += az * dt;
  const cap = b.physics.velMax * m;
  const sp = vec3.length(b.vel);
  if (sp > cap && sp > 0) vec3.scale(b.vel, b.vel, cap / sp);
  if (sp > 0) {
    b.pos[0] += b.vel[0] * dt;
    b.pos[1] += b.vel[1] * dt;
    b.pos[2] += b.vel[2] * dt;
  }
  b.multiplier = b.multiplier + (1 - b.multiplier) * 0.2; // Lerp(m,1,.2)
}

/**
 * PreviewDirection intercept solver verbatim (uses BULLET.velMax=256 even
 * for missiles; gate dot>0.985 decides lead vs straight).
 */
export function previewDirection(
  out: vec3,
  fromPos: vec3,
  fromDir: vec3,
  targetPos: vec3,
  targetVel: vec3,
): vec3 {
  const tx = targetPos[0] - fromPos[0];
  const ty = targetPos[1] - fromPos[1];
  const tz = targetPos[2] - fromPos[2];
  const tl = Math.hypot(tx, ty, tz) || 1;
  const dot = (tx * fromDir[0] + ty * fromDir[1] + tz * fromDir[2]) / tl;
  if (dot > 0.985) {
    const tv2 = vec3.squaredLength(targetVel);
    const a = tv2 - P.BULLET.velMax * P.BULLET.velMax;
    const b = 2 * (targetVel[0] * tx + targetVel[1] * ty + targetVel[2] * tz);
    const c = tx * tx + ty * ty + tz * tz;
    const p = -b / (2 * a);
    const disc = b * b - 4 * a * c;
    const q = Math.sqrt(Math.max(0, disc)) / (2 * a);
    const t1 = p - q;
    const t2 = p + q;
    const t = t1 > t2 && t2 > 0 ? t2 : t1;
    out[0] = tx + targetVel[0] * t;
    out[1] = ty + targetVel[1] * t;
    out[2] = tz + targetVel[2] * t;
    vec3.normalize(out, out);
    return out;
  }
  return vec3.copy(out, fromDir);
}

/** Keep inside cubic world (Map.PositionInside semantics). */
export function clampInside(pos: vec3, size: number): boolean {
  const h = size / 2;
  let clamped = false;
  for (let i = 0; i < 3; i++) {
    if (pos[i] < -h) { pos[i] = -h; clamped = true; }
    else if (pos[i] > h) { pos[i] = h; clamped = true; }
  }
  return clamped;
}
