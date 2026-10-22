// Radial team-base layout: even spacing, UP-perpendicular plane, correct radius
// and deterministic ordering.
import { describe, expect, it } from 'vitest';
import { BASE_RADIUS_FRACTION, radialBasePosition } from '../src/game/basearrangement';

const SIZE = 2048;
const RADIUS = BASE_RADIUS_FRACTION * (SIZE / 2); // 0.37 * half-size

/** Plan-view angle (XZ plane) of a base position, in [0, 2π). */
function planAngle(p: [number, number, number]): number {
  const a = Math.atan2(p[2], p[0]);
  return a < 0 ? a + Math.PI * 2 : a;
}

/** Smallest absolute angular distance between two angles. */
function angleDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % (Math.PI * 2);
  return Math.min(d, Math.PI * 2 - d);
}

function planRadius(p: [number, number, number]): number {
  return Math.hypot(p[0], p[2]);
}

describe('radialBasePosition', () => {
  it('places two bases on opposite sides of the arena centre', () => {
    const a = radialBasePosition(0, 2, SIZE);
    const b = radialBasePosition(1, 2, SIZE);
    // Antiparallel in the ground plane: the two offsets cancel out.
    expect(a[0] + b[0]).toBeCloseTo(0, 6);
    expect(a[2] + b[2]).toBeCloseTo(0, 6);
    // Exactly half a turn apart.
    expect(angleDelta(planAngle(a), planAngle(b))).toBeCloseTo(Math.PI, 6);
  });

  it('spaces three bases 120° apart', () => {
    const p = [0, 1, 2].map((i) => radialBasePosition(i, 3, SIZE));
    expect(angleDelta(planAngle(p[0]), planAngle(p[1]))).toBeCloseTo((2 * Math.PI) / 3, 6);
    expect(angleDelta(planAngle(p[1]), planAngle(p[2]))).toBeCloseTo((2 * Math.PI) / 3, 6);
    expect(angleDelta(planAngle(p[2]), planAngle(p[0]))).toBeCloseTo((2 * Math.PI) / 3, 6);
  });

  it('spaces four bases 90° apart', () => {
    const p = [0, 1, 2, 3].map((i) => radialBasePosition(i, 4, SIZE));
    for (let i = 0; i < p.length; i++) {
      const next = p[(i + 1) % p.length];
      expect(angleDelta(planAngle(p[i]), planAngle(next))).toBeCloseTo(Math.PI / 2, 6);
    }
  });

  it('lies in the UP-perpendicular ground plane with the expected radius', () => {
    for (const count of [2, 3, 4, 6]) {
      for (let i = 0; i < count; i++) {
        const p = radialBasePosition(i, count, SIZE);
        expect(p[1]).toBe(0);
        expect(planRadius(p)).toBeCloseTo(RADIUS, 6);
      }
    }
    expect(RADIUS).toBeCloseTo(0.37 * (SIZE / 2), 6);
  });

  it('is deterministic and ordered by index', () => {
    // Same inputs give the same point, regardless of call count.
    for (const i of [0, 1, 2, 3]) {
      expect(radialBasePosition(i, 4, SIZE)).toEqual(radialBasePosition(i, 4, SIZE));
    }
    // Index 0 starts at angle 0 and the angle grows with the index, so a stable
    // team order maps to a stable, deterministic layout.
    const angles = [0, 1, 2, 3].map((i) => planAngle(radialBasePosition(i, 4, SIZE)));
    expect(angles[0]).toBeCloseTo(0, 6);
    for (let i = 1; i < angles.length; i++) {
      expect(angles[i]).toBeGreaterThan(angles[i - 1]);
    }
  });

  it('scales with the arena size', () => {
    const small = radialBasePosition(0, 2, 1024);
    const large = radialBasePosition(0, 2, 2048);
    expect(planRadius(large)).toBeCloseTo(planRadius(small) * 2, 6);
  });
});
