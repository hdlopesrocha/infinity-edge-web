// Camera port of IE3D_API/Camera.cs.
// - Perspective FOV pi/4, near 0.1, far = options._distance (default 2048-ish).
// - Orbit state (h/v angles + lookAt), clamped like Camera.Update.
// - view/proj matrices + BoundingFrustum equivalent via frustum.ts.
// Uses gl-matrix (column-major); world convention kept: Y-up, +Z forward.

import { mat4, vec3 } from 'gl-matrix';

export type CameraMode = 'lookAtObject' | 'lookAtPosition' | 'orbit';

export class Camera {
  position = vec3.fromValues(16, 32, 16);
  lookAt = vec3.fromValues(0, 0, 0);
  up = vec3.fromValues(0, 1, 0);
  /** horizontal orbit angle degrees, vertical angle degrees (Camera._h/_v). */
  h = 45;
  v = 45;
  fov = Math.PI / 4;
  near = 0.1;
  far = 4096;
  aspect = 16 / 9;
  mode: CameraMode = 'lookAtObject';

  view = mat4.create();
  proj = mat4.create();
  viewProj = mat4.create();
  /** world matrix for attached effects (mirrors camera._world). */
  world = mat4.create();

  orbitDistance = 48;

  constructor() {
    this.update(16 / 9);
  }

  setAspect(aspect: number): void {
    this.aspect = aspect;
    this.update(aspect);
  }

  /** Chase a target position (GameInstance camera follows HS1). */
  follow(target: vec3, dist = 14, height = 5): void {
    // Place camera behind+above target relative to current orbit angles.
    const h = (this.h * Math.PI) / 180;
    const v = Math.max(5, Math.min(85, this.v));
    const vr = (v * Math.PI) / 180;
    const cp = Math.cos(vr) * dist;
    this.position[0] = target[0] - Math.sin(h) * cp;
    this.position[1] = target[1] + Math.sin(vr) * dist * 0.5 + height * 0.4;
    this.position[2] = target[2] - Math.cos(h) * cp;
    vec3.copy(this.lookAt, target);
    this.update(this.aspect);
  }

  orbit(dh: number, dv: number): void {
    this.h = ((this.h + dh) % 360 + 360) % 360;
    this.v = Math.max(1, Math.min(179, this.v + dv));
    this.update(this.aspect);
  }

  update(aspect?: number): void {
    if (aspect !== undefined) this.aspect = aspect;
    // Clamp like Camera.Update.
    if (this.v < 1) this.v = 1;
    if (this.v > 179) this.v = 179;
    this.h = ((this.h % 360) + 360) % 360;
    mat4.lookAt(this.view, this.position, this.lookAt, this.up);
    mat4.perspective(this.proj, this.fov, this.aspect, this.near, this.far);
    mat4.multiply(this.viewProj, this.proj, this.view);
    mat4.identity(this.world);
  }

  /** Direction/ side vectors (Object3D uses UnitZ*quat etc.; here view-derived). */
  direction(out: vec3): vec3 {
    vec3.subtract(out, this.lookAt, this.position);
    return vec3.normalize(out, out);
  }

  side(out: vec3, dir?: vec3): vec3 {
    const d = dir ?? vec3.subtract(vec3.create(), this.lookAt, this.position);
    vec3.cross(out, d, this.up);
    return vec3.normalize(out, out);
  }
}
