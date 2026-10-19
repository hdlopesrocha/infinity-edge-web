import { describe, expect, it } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { Camera } from '../src/engine/camera';

/** The world up as the camera sees it (what tilts the horizon in view space). */
function upInView(cam: Camera): vec3 {
  return vec3.transformMat4(vec3.create(), vec3.fromValues(0, 1, 0), cam.view);
}

function levelCamera(): Camera {
  const cam = new Camera();
  cam.position = vec3.fromValues(0, 0, 0);
  cam.lookAt = vec3.fromValues(0, 0, -10);
  cam.up = vec3.fromValues(0.5, Math.sqrt(3) / 2, 0); // rolled ship up
  return cam;
}

describe('VR level horizon', () => {
  it('levelView ignores the ship roll (headset up wins)', () => {
    const cam = levelCamera();
    const out = mat4.create();
    cam.levelView(out);
    const up = vec3.transformMat4(vec3.create(), vec3.fromValues(0, 1, 0), out);
    expect(up[0]).toBeCloseTo(0, 5);
    expect(up[1]).toBeCloseTo(1, 5);
    expect(up[2]).toBeCloseTo(0, 5);
    // Still looking down -Z.
    expect(out[2]).toBeCloseTo(0, 5);
    expect(out[6]).toBeCloseTo(0, 5);
    expect(out[10]).toBeCloseTo(1, 5);   // row 2 is the camera's backward (+Z)
  });

  it('keeps the horizon level in sensor VR despite a rolled chase up', () => {
    const cam = levelCamera();
    cam.vrActive = true;
    cam.updateMatrices();
    const up = upInView(cam);
    expect(up[0]).toBeCloseTo(0, 5);
    expect(up[1]).toBeCloseTo(1, 5);
  });

  it('applies the gyro roll around the view axis (horizon follows the head)', () => {
    const cam = levelCamera();
    cam.vrActive = true;
    cam.vrRoll = 30;
    cam.updateMatrices();
    const up = upInView(cam);
    // A rightward head roll leaves the world up leaning left in view space.
    expect(up[0]).toBeCloseTo(-Math.sin(Math.PI / 6), 5);
    expect(up[1]).toBeCloseTo(Math.cos(Math.PI / 6), 5);
  });

  it('returns to the ship up outside VR', () => {
    const cam = levelCamera();
    cam.vrActive = false;
    cam.updateMatrices();
    const up = upInView(cam);
    expect(up[0]).toBeCloseTo(-0.5, 5); // the rolled chase up is back
  });

  it('does not produce NaN when looking straight up', () => {
    const cam = levelCamera();
    cam.lookAt = vec3.fromValues(0, 10, 0);
    cam.up = vec3.fromValues(0, 0, -1);
    const out = mat4.create();
    cam.levelView(out);
    for (let i = 0; i < 16; i++) expect(Number.isFinite(out[i])).toBe(true);
  });

  it('composes yaw before roll, keeping the roll only around the view axis', () => {
    const cam = levelCamera();
    cam.vrActive = true;
    cam.vrYaw = 90;
    cam.updateMatrices();
    // Yaw alone keeps the horizon level.
    const up = upInView(cam);
    expect(up[0]).toBeCloseTo(0, 5);
    expect(up[1]).toBeCloseTo(1, 5);
  });
});
