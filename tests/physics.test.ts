// Physics port: NextPosition integration, clamps, lead-shot aim, life pools.

import { describe, expect, it } from 'vitest';
import { vec3 } from 'gl-matrix';
import { P, clampInside, nextPosition, previewDirection } from '../src/game/physics';
import { Life1, Life3 } from '../src/game/life';
import { getH, getV } from '../src/engine/math';

describe('physics', () => {
  it('integrates accel - friction * vel and clamps to velMax', () => {
    const b = {
      pos: vec3.fromValues(0, 0, 0),
      vel: vec3.create(),
      accel: vec3.fromValues(0, 0, -P.SS1.accelMax),
      multiplier: 1, friction: 1, physics: P.SS1,
    };
    nextPosition(b, 1000);
    expect(vec3.length(b.vel)).toBeCloseTo(P.SS1.velMax, 5);
    expect(b.pos[2]).toBeLessThan(0);
    // A second second keeps the same speed (friction balances the accel).
    const v1 = b.vel[2];
    nextPosition(b, 1000);
    expect(b.vel[2]).toBeCloseTo(v1, 3);
  });

  it('multiplier boosts the speed limit and decays towards 1', () => {
    const b = {
      pos: vec3.create(), vel: vec3.create(),
      accel: vec3.fromValues(0, 0, -P.SS1.accelMax),
      multiplier: 7.5, friction: 1, physics: P.SS1,
    };
    nextPosition(b, 1000);
    expect(vec3.length(b.vel)).toBeCloseTo(P.SS1.velMax * 7.5, 4);
    expect(b.multiplier).toBeCloseTo(7.5 + (1 - 7.5) * 0.2, 6);
    expect(b.multiplier).toBeLessThan(7.5);
  });

  it('does not move a body with zero velocity (vel > 0 guard)', () => {
    const b = {
      pos: vec3.fromValues(1, 2, 3), vel: vec3.create(), accel: vec3.create(),
      multiplier: 1, friction: 1, physics: P.STATIC,
    };
    nextPosition(b, 16);
    expect(Array.from(b.pos)).toEqual([1, 2, 3]);
  });

  it('clamps positions inside the map cube like Map.ClampInside', () => {
    const p = vec3.fromValues(200, -200, 0);
    expect(clampInside(p, 100)).toBe(true);
    expect(Array.from(p)).toEqual([50, -50, 0]);
    const inside = vec3.fromValues(0, 0, 0);
    expect(clampInside(inside, 100)).toBe(false);
  });

  it('aims ahead with the ballistic lead-shot solution', () => {
    const out = vec3.create();
    const from = vec3.fromValues(0, 0, 0);
    const dir = vec3.fromValues(0, 0, 1);
    const target = vec3.fromValues(0, 0, 100); // dead ahead
    const vel = vec3.fromValues(20, 0, 0);     // crossing the line of fire
    previewDirection(out, from, dir, target, vel);
    expect(vec3.length(out)).toBeCloseTo(1, 5);
    expect(out[0]).toBeGreaterThan(0); // leading towards the target's motion
    expect(out[2]).toBeGreaterThan(0);
  });

  it('keeps the current direction when the target is off-axis', () => {
    const out = vec3.create();
    const from = vec3.fromValues(0, 0, 0);
    const dir = vec3.fromValues(0, 0, 1);
    const target = vec3.fromValues(50, 0, 0); // 90 degrees off the nose
    previewDirection(out, from, dir, target, vec3.fromValues(0, 0, 0));
    expect(Array.from(out)).toEqual([0, 0, 1]);
  });

  it('GetH/GetV match the original spherical conversions', () => {
    expect(getH(vec3.fromValues(0, 0, 1))).toBeCloseTo(0, 6);
    expect(getH(vec3.fromValues(1, 0, 0))).toBeCloseTo(Math.PI / 2, 6);
    expect(getV(vec3.fromValues(0, 1, 0))).toBeCloseTo(-Math.PI / 2, 6);
  });
});

describe('life pools', () => {
  const up = vec3.fromValues(0, 1, 0);
  const dir = vec3.fromValues(0, 0, 1);

  it('Life3 applies a front hit to the centre only', () => {
    const life = new Life3(30, 30, 30);
    expect(life.percentage()).toBeCloseTo(1, 6);
    // cross(up, dir) is perpendicular to dir, so the front hit takes the else
    // branch (verbatim) and only the centre pool shrinks.
    life.receiveDamage(10, dir, up, dir);
    expect(life.center).toBeCloseTo(20, 6);
    expect(life.left).toBeCloseTo(30, 6);
    expect(life.right).toBeCloseTo(30, 6);
    expect(life.percentage()).toBeCloseTo(20 / 30, 6);
    expect(life.total()).toBeCloseTo(80, 6);
  });

  it('Life3 applies a side hit to that side and still drains the centre (verbatim quirk)', () => {
    const life = new Life3(30, 30, 30);
    const side = vec3.create();
    vec3.cross(side, up, dir);
    life.receiveDamage(10, side, up, dir);
    expect(life.left).toBeCloseTo(20, 6);
    expect(life.center).toBeCloseTo(20, 6);   // the else branch runs as well
    expect(life.right).toBeCloseTo(30, 6);
  });

  it('Life3 destroys when the centre pool reaches zero', () => {
    const life = new Life3(30, 10, 30);
    let destroyed = 0;
    life.receiveDamage(10, dir, up, dir, () => { destroyed++; });
    expect(destroyed).toBe(1);
  });

  it('Life1 destroys after its pool is exhausted and keeps the negative value', () => {
    const life = new Life1(10);
    let destroyed = 0;
    life.receiveDamage(4, vec3.create(), vec3.create(), vec3.create(), () => { destroyed++; });
    expect(destroyed).toBe(0);
    expect(life.total()).toBeCloseTo(6, 6);
    life.receiveDamage(10, vec3.create(), vec3.create(), vec3.create(), () => { destroyed++; });
    expect(destroyed).toBe(1);
    expect(life.total()).toBeCloseTo(-4, 6);   // not clamped, like the original
    life.restore();
    expect(life.total()).toBeCloseTo(10, 6);
  });
});
