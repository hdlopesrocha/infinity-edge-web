import { describe, expect, it } from 'vitest';
import { mat4, quat, vec3 } from 'gl-matrix';
import { Camera } from '../src/engine/camera';
import { ypr } from '../src/engine/math';

/** The world up as the camera sees it (what tilts the horizon in view space). */
function upInView(cam: Camera): vec3 {
  return directionInView(cam.view, vec3.fromValues(0, 1, 0));
}

/** The ship up as the camera sees it (must stay the view's up basis). */
function shipUpInView(cam: Camera): vec3 {
  return directionInView(cam.view, cam.up);
}

/** Rotate a direction by the view rotation (ignoring the camera translation). */
function directionInView(m: mat4, v: vec3): vec3 {
  return vec3.fromValues(
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
  );
}

function rolledCamera(): Camera {
  const cam = new Camera();
  cam.position = vec3.fromValues(0, 0, 0);
  cam.lookAt = vec3.fromValues(0, 0, -10);
  cam.up = vec3.fromValues(0.5, Math.sqrt(3) / 2, 0); // rolled ship up
  return cam;
}

describe('VR chase view follows the spaceship', () => {
  it('uses the ship up vector, so the ship roll tilts the view', () => {
    const cam = rolledCamera();
    cam.updateMatrices();
    const shipUp = shipUpInView(cam);
    expect(shipUp[0]).toBeCloseTo(0, 5);
    expect(shipUp[1]).toBeCloseTo(1, 5);
    expect(shipUp[2]).toBeCloseTo(0, 5);
    // The world horizon is correspondingly rolled in view space.
    const worldUp = upInView(cam);
    expect(worldUp[0]).toBeCloseTo(-0.5, 5);
    expect(worldUp[1]).toBeCloseTo(Math.sqrt(3) / 2, 5);
  });

  it('chaseView exposes the same ship-up base for the XR eye composition', () => {
    const cam = rolledCamera();
    const out = mat4.create();
    cam.chaseView(out);
    const shipUp = directionInView(out, cam.up);
    expect(shipUp[0]).toBeCloseTo(0, 5);
    expect(shipUp[1]).toBeCloseTo(1, 5);
    expect(shipUp[2]).toBeCloseTo(0, 5);
  });

  it('keeps the ship roll in the real chase camera, not a world horizon', () => {
    const q = quat.create();
    ypr(q, 30 * Math.PI / 180, 15 * Math.PI / 180, 60 * Math.PI / 180);
    const dir = vec3.transformQuat(vec3.create(), vec3.fromValues(0, 0, 1), q);
    const side = vec3.transformQuat(vec3.create(), vec3.fromValues(1, 0, 0), q);
    const shipUp = vec3.transformQuat(vec3.create(), vec3.fromValues(0, 1, 0), q);
    const cam = new Camera();
    cam.lookAtObject(
      vec3.fromValues(0, 0, 0), dir, side, q,
      { stickX: 0, stickY: 0 }, false, false, 20,
    );
    // The ship up stays vertical in view space (no x roll) even though the
    // ship is rolled 60 degrees; the world horizon is tilted instead.
    const shipUpView = directionInView(cam.view, shipUp);
    expect(shipUpView[0]).toBeCloseTo(0, 4);
    expect(shipUpView[1]).toBeGreaterThan(0.9);
    const worldUpView = directionInView(cam.view, vec3.fromValues(0, 1, 0));
    expect(Math.abs(worldUpView[0])).toBeGreaterThan(0.1);
  });

  it('applies the gyro roll around the view axis relative to the ship up', () => {
    const cam = rolledCamera();
    cam.vrRoll = 30;
    cam.updateMatrices();
    const shipUp = shipUpInView(cam);
    // A rightward head roll leaves the ship up leaning left in view space.
    expect(shipUp[0]).toBeCloseTo(-Math.sin(Math.PI / 6), 5);
    expect(shipUp[1]).toBeCloseTo(Math.cos(Math.PI / 6), 5);
  });

  it('does not produce NaN for a valid ship-up view', () => {
    const cam = rolledCamera();
    cam.lookAt = vec3.fromValues(0, 10, 0);
    cam.up = vec3.fromValues(0, 0, -1); // perpendicular to the new view
    const out = mat4.create();
    cam.chaseView(out);
    for (let i = 0; i < 16; i++) expect(Number.isFinite(out[i])).toBe(true);
  });

  it('composes yaw before roll, keeping roll around the ship view axis', () => {
    const cam = rolledCamera();
    cam.vrYaw = 90;
    cam.updateMatrices();
    // Yaw alone does not change the ship-up basis.
    const shipUp = shipUpInView(cam);
    expect(shipUp[0]).toBeCloseTo(0, 5);
    expect(shipUp[1]).toBeCloseTo(1, 5);
  });
});
