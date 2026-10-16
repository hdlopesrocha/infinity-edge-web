// Motion-blur conventions — the single source of truth for the whole chain.
// The GLSL in engine/shaders.ts mirrors these functions exactly; tests/motion
// pins the contract down.
//
// ---------------------------------------------------------------------------
// MOTION VECTORS
//
// A vertex's motion vector is the difference between its *screen* positions in
// two consecutively rendered frames, each projected independently:
//
//   currentClip  = proj      * view      * world      * p
//   previousClip = prevProj  * prevView  * prevWorld  * p
//   currentUV    = ndcToUV(currentClip.xy  / currentClip.w)
//   previousUV   = ndcToUV(previousClip.xy / previousClip.w)
//   velocityUV   = currentUV - previousUV
//
// with ndcToUV(n) = n * 0.5 + 0.5, i.e. WebGL NDC [-1, 1] mapped to UV [0, 1]
// with +Y up in both spaces (the render targets and the samplers agree, so no
// Y flip is needed anywhere).
//
// Matrices are never subtracted and the delta time never enters the vector:
// the velocity is *displacement in UV per rendered frame*. Direction is the
// direction the content moves on screen; length is its screen displacement.
//
// Points at or behind the eye plane have no valid projection. Their w is
// clamped to MIN_CLIP_W so the divide stays finite and the interpolated vector
// stays bounded — such triangles are clipped away, so this only prevents
// infinities from leaking into visible fragments of partially clipped ones.
//
// ---------------------------------------------------------------------------
// EXPOSURE (trailing shutter)
//
// The velocity buffer measures the interval between the two frames that were
// actually rendered. The exposure is expressed in seconds and converted to a
// fraction of that measured interval:
//
//   shutter = clamp(exposureSeconds / frameSeconds, min, max)
//
// shutter = 1 means the exposure covers exactly the rendered frame interval.
// The shutter *closes on the displayed frame* (trailing exposure), so the
// integration segment runs backwards along the velocity:
//
//   uv(t) = uv + velocityUV * shutter * t,   t in [-1, 0]
//
// t = 0 is the displayed frame, t = -1 is the start of the exposure. Sampling
// the scene backwards means a streak always trails behind the motion; the
// direction can never come out reversed as long as this one formula is used.
//
// ---------------------------------------------------------------------------
// DEPTH COMPATIBILITY
//
// A tap is only accepted when its view-space depth is within a relative
// tolerance of the centre pixel's, which stops a streak from smearing one
// surface across another (a ship in front of the arena wall, a rock passing a
// station). The depth copy is taken from the opaque pass only, so transparent
// effects (glows, smoke) are compared against whatever opaque surface is
// behind them — see the limitations note in engine/post.ts.

/** NDC -> UV scale (NDC spans 2 units, UV spans 1). */
export const NDC_TO_UV_SCALE = 0.5;
/** NDC -> UV bias (NDC [-1, 1] -> UV [0, 1]). */
export const NDC_TO_UV_BIAS = 0.5;
/** Smallest clip w used for the perspective divide (see the note above). */
export const MIN_CLIP_W = 1e-4;

/** WebGL NDC -> UV (both +Y up). */
export function ndcToUV(x: number, y: number): [number, number] {
  return [x * NDC_TO_UV_SCALE + NDC_TO_UV_BIAS, y * NDC_TO_UV_SCALE + NDC_TO_UV_BIAS];
}

/** Clip space -> UV with the guarded, independent perspective divide. */
export function clipToUV(clip: readonly number[]): [number, number] {
  const w = Math.max(clip[3], MIN_CLIP_W);
  return ndcToUV(clip[0] / w, clip[1] / w);
}

/** velocityUV = currentUV - previousUV, in UV per rendered frame. */
export function velocityUV(currentClip: readonly number[], previousClip: readonly number[]): [number, number] {
  const c = clipToUV(currentClip);
  const p = clipToUV(previousClip);
  return [c[0] - p[0], c[1] - p[1]];
}

/** Shutter length as a fraction of the measured frame interval. */
export function exposureShutter(
  exposureSeconds: number,
  frameSeconds: number,
  min = 0.35,
  max = 200,
): number {
  const frame = Math.max(frameSeconds, 1e-4);
  return Math.min(max, Math.max(min, exposureSeconds / frame));
}

/**
 * One sample of the trailing exposure segment, in UV.
 * `t` must be in [-1, 0]: 0 = the displayed frame, -1 = exposure start.
 */
export function exposureSample(
  uv: [number, number],
  velocity: [number, number],
  shutter: number,
  t: number,
): [number, number] {
  return [uv[0] + velocity[0] * shutter * t, uv[1] + velocity[1] * shutter * t];
}

/** True when two view-space depths belong to the same surface. */
export function depthCompatible(depth: number, reference: number, tolerance: number): boolean {
  const scale = Math.max(depth, reference);
  return Math.abs(depth - reference) <= tolerance * scale + 1e-4;
}

/** Perspective window depth [0,1] -> view-space distance. */
export function linearizeDepth(windowDepth: number, near: number, far: number): number {
  const ndc = windowDepth * 2 - 1;
  return (2 * near * far) / (far + near - ndc * (far - near));
}

/** Tunables for the motion-blur stage (see the conventions above). */
export interface MotionBlurConfig {
  /** Exposure duration in seconds. Default: 1.5 x the nominal 1/60 s frame. */
  exposureSeconds: number;
  /** Hard cap on the streak length, in UV units. */
  maxRadiusUV: number;
  /** Integration samples along the exposure segment. */
  samples: number;
  /** Gain applied at rest (1 = plain exposure). */
  gainAtRest: number;
  /** Extra gain per unit of (camera speed / max speed). */
  gainPerSpeed: number;
  /** Upper bound for the speed gain. */
  gainMax: number;
  /** Relative depth tolerance for accepting a tap. */
  depthTolerance: number;
}

export const MOTION_BLUR: MotionBlurConfig = {
  // Long exposure: the streak is this many seconds of screen motion, so at
  // 60 fps it is ~300 frames of movement -- everything moving on screen
  // smears to the radius cap below.
  exposureSeconds: 5.0,
  // Cap: a third of the screen. This is what the streaks actually reach.
  maxRadiusUV: 0.35,
  samples: 32,
  gainAtRest: 1,
  gainPerSpeed: 1,
  gainMax: 2,
  depthTolerance: 0.05,
};
