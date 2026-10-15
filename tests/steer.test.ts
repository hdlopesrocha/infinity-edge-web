import { describe, expect, it } from 'vitest';
import { dirFromQuat, quat, steerToward, vec3 } from '../src/engine/math';

// AIPoint steering (the 2013 build's `Quaternion.CreateFromAxisAngle(ortho,
// Clamp(angle, 0, maxAngular)) * rotation`): it must rotate the ship toward the
// target by at most maxAngular per call, and it must be a no-op when aligned.
describe('steerToward', () => {
  it('rotates toward a target', () => {
    const rot = quat.create();
    const dir = dirFromQuat(vec3.create(), rot);
    steerToward(rot, dir, vec3.fromValues(1, 0, 0), vec3.fromValues(1, 0, 0), 0.05);
    const after = dirFromQuat(vec3.create(), rot);
    expect(after[0]).toBeGreaterThan(0.01);
  });

  it('clamps the step to maxAngle', () => {
    const rot = quat.create();
    const dir = dirFromQuat(vec3.create(), rot);
    steerToward(rot, dir, vec3.fromValues(0, 0, -1), vec3.fromValues(1, 0, 0), 0.05);
    const after = dirFromQuat(vec3.create(), rot);
    const dot = after[2];
    expect(dot).toBeGreaterThan(Math.cos(0.06)); // ~0.05 rad step, not a flip
    expect(dot).toBeLessThan(1);
  });

  it('is a no-op when already aligned', () => {
    const rot = quat.create();
    const dir = dirFromQuat(vec3.create(), rot);
    const before = Array.from(rot);
    steerToward(rot, dir, vec3.fromValues(0, 0, 1), vec3.fromValues(1, 0, 0), 0.05);
    expect(Array.from(rot)).toEqual(before);
  });
});
