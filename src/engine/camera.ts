// Camera verbatim (FOV pi/4, near 0.1, far = options._distance).

import { mat4, quat, vec3, ypr } from './math';

export interface StickState {
  stickX: number;
  stickY: number;
}

export class Camera {
  position = vec3.fromValues(16, 32, 16);
  lookAt = vec3.fromValues(0, 0, 0);
  up = vec3.fromValues(0, 1, 0);
  direction = vec3.fromValues(0, 0, 1);
  side = vec3.fromValues(1, 0, 0);
  fov = Math.PI / 4;
  near = 0.1;
  far = 192;
  aspect = 16 / 9;
  view = mat4.create();
  proj = mat4.create();
  viewProj = mat4.create();
  world = mat4.create();
  /** VR head offset in degrees, applied on top of the chase view. */
  vrYaw = 0;
  vrPitch = 0;
  vrRoll = 0;

  /**
   * Chase base view using the spaceship's own up vector. The head pose (yaw,
   * pitch and roll) is composed on top of this, so the head rotates with the
   * ship instead of being stabilized against a world horizon.
   */
  chaseView(out: mat4): void {
    mat4.lookAt(out, this.position, this.lookAt, this.up);
  }

  /** Fixed menu-background pose (the original orbit's angle-0 position). */
  lookAtPosition(target: vec3): void {
    vec3.set(this.position, target[0], 3, target[2] - 6);
    vec3.set(this.lookAt, target[0], target[1] + 1, target[2]);
    vec3.set(this.up, 0, 1, 0);
    this.updateMatrices();
  }

  setAspect(aspect: number): void {
    this.aspect = aspect;
    this.updateMatrices();
  }

  updateMatrices(): void {
    // The chase camera always uses the ship's up vector, in VR too: the ship's
    // roll must tilt the whole view, so head rotation matches ship rotation.
    mat4.lookAt(this.view, this.position, this.lookAt, this.up);
    // VR: rotate the view around the camera (position untouched) by the head
    // offset from the gyroscope. Applies after lookAt, before the projection.
    if (this.vrYaw !== 0 || this.vrPitch !== 0 || this.vrRoll !== 0) {
      const rad = Math.PI / 180;
      if (this.vrYaw !== 0) mat4.rotate(this.view, this.view, this.vrYaw * rad, this.up);
      if (this.vrPitch !== 0) {
        const right = vec3.fromValues(this.view[0], this.view[4], this.view[8]);
        mat4.rotate(this.view, this.view, this.vrPitch * rad, right);
      }
      // Roll the world around the view axis: the head's roll is relative to
      // the ship's up, so the whole chase view (and the HUD/menu plane) rolls
      // with the spaceship.
      if (this.vrRoll !== 0) mat4.rotateZ(this.view, this.view, this.vrRoll * rad);
    }
    mat4.perspective(this.proj, this.fov, this.aspect, this.near, this.far);
    mat4.multiply(this.viewProj, this.proj, this.view);
    vec3.subtract(this.direction, this.lookAt, this.position);
    vec3.normalize(this.direction, this.direction);
    vec3.cross(this.side, this.direction, this.up);
    if (vec3.length(this.side) < 1e-6) vec3.set(this.side, 1, 0, 0);
    vec3.normalize(this.side, this.side);
  }

  /** CommandLookAtObject verbatim. */
  lookAtObject(
    objPos: vec3, objDir: vec3, objSide: vec3, objRot: quat,
    stick: StickState, invX: boolean, invY: boolean, distance: number,
  ): void {
    const angle = Math.PI / 24;
    const q = quat.create();
    ypr(
      q,
      (invX ? -1 : 1) * stick.stickX * angle,
      (invY ? -1 : 1) * stick.stickY * angle + Math.PI / 16,
      0,
    );
    quat.multiply(q, objRot, q);
    const dir = vec3.fromValues(0, 0, 1);
    vec3.transformQuat(dir, dir, q);
    vec3.normalize(dir, dir);
    vec3.scaleAndAdd(this.position, objPos, dir, -6);
    vec3.scaleAndAdd(this.lookAt, objPos, objDir, distance);
    const side = vec3.create();
    vec3.cross(side, dir, objDir);
    vec3.normalize(side, side);
    const up = vec3.create();
    vec3.cross(up, side, dir);
    vec3.normalize(up, up);
    const d = vec3.dot(up, objSide);
    vec3.scaleAndAdd(up, up, objSide, -2 * d);
    vec3.normalize(up, up);
    vec3.copy(this.up, up);
    this.updateMatrices();
  }


}
