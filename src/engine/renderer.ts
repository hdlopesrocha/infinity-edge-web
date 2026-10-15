// Renderer host: canvas, GL context, camera, programs, scene target + post
// chain, stable loop.

import { Camera } from './camera';
import { Draw } from './draw';
import { createFrustum, extractFrustum } from './frustum';
import type { FrustumPlanes } from './frustum';
import type { CullStats } from './octree';
import { initGL, resizeGL, watchContextLoss } from './gl';
import { clearTextureCache } from './texture';
import type { TexEntry } from './texture';
import { clearModelCache } from './model';
import { mat4, vec3 } from './math';
import { createNoiseTexture } from './noise';
import type { NoiseTexture } from './noise';
import { Post } from './post';

export interface RenderStats {
  fps: number;
  draws: number;
  culled: number;
}

export interface RenderOptions {
  /** Per-object motion blur driven by the velocity buffer. */
  motionBlur: boolean;
  /** Lens-flare strength sampled from the rendered bright pass (0 = off). */
  flare: number;
  flareTex: TexEntry | null;
}

// Motion-blur exposure: how much world motion one frame integrates. A fixed
// *time* (like a real camera shutter) keeps the streak identical at any fps.
const MOTION_BLUR_EXPOSURE_S = 1 / 60;

export class Renderer {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  draw: Draw;
  /** Offscreen scene target + motion-blur / lens-flare post chain. */
  post: Post;
  /** Tileable 3D Perlin field used by the smoke and the flare plume. */
  noise: NoiseTexture;
  camera = new Camera();
  frustum: FrustumPlanes = createFrustum();
  stats: RenderStats = { fps: 0, draws: 0, culled: 0 };
  renderOptions: RenderOptions = { motionBlur: false, flare: 0.9, flareTex: null };
  /** Reusable counter for hierarchical culling (no per-frame allocation). */
  readonly cullStats: CullStats = { culled: 0 };
  onFrame: ((dtMs: number) => void) | null = null;
  onStats: ((s: RenderStats) => void) | null = null;
  onRebuilt: (() => void) | null = null;
  private raf = 0;
  private last = 0;
  private running = false;
  private frames = 0;
  private fpsT = 0;
  private unwatch: (() => void) | null = null;
  private resizeObs: ResizeObserver | null = null;
  private lastViewProj = mat4.create();
  private hasPrevViewProj = false;
  private startTime = performance.now();
  /** Last frame's delta, used to keep the motion-blur exposure time-constant. */
  private frameDtMs = 1000 / 60;
  /** Previous frame's camera position (camera-locked geometry velocity). */
  readonly prevCameraPos = vec3.create();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = initGL(canvas);
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;
    this.draw = new Draw(gl);
    this.post = new Post(gl);
    this.noise = createNoiseTexture(gl);
    this.draw.bindNoise(this.noise.tex);
    resizeGL(canvas, gl);
    this.post.resize(canvas.width, canvas.height);
    this.draw.bindSceneDepth(this.post.depthTex);
    this.unwatch = watchContextLoss(
      canvas,
      () => this.handleLost(),
      () => this.handleRestored(),
    );
    this.resizeObs = new ResizeObserver(() => {
      if (resizeGL(canvas, gl)) {
        this.camera.setAspect(canvas.clientWidth / Math.max(1, canvas.clientHeight));
        this.syncTargets();
      }
    });
    this.resizeObs.observe(canvas);
    this.camera.setAspect(canvas.clientWidth / Math.max(1, canvas.clientHeight));
    this.camera.updateMatrices();
  }

  /** (Re)size the scene/post targets and re-bind the depth copy. */
  private syncTargets(): void {
    this.post.resize(this.canvas.width, this.canvas.height);
    this.draw.bindSceneDepth(this.post.depthTex);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  private handleLost(): void {
    cancelAnimationFrame(this.raf);
    this.running = false;
  }

  private handleRestored(): void {
    // Every GPU object from the lost context is invalid: rebuild the draw
    // programs, the post targets and the noise field, then drop the
    // texture/model caches before the scenes re-upload.
    this.draw = new Draw(this.gl);
    this.post = new Post(this.gl);
    this.noise = createNoiseTexture(this.gl);
    this.draw.bindNoise(this.noise.tex);
    this.syncTargets();
    clearTextureCache();
    clearModelCache();
    this.onRebuilt?.();
    if (!this.running) this.start();
  }

  beginFrame(): void {
    const gl = this.gl;
    if (resizeGL(this.canvas, gl)) {
      this.camera.setAspect(this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight));
      this.syncTargets();
    }
    this.stats.draws = 0;
    this.stats.culled = 0;
    this.cullStats.culled = 0;
    extractFrustum(this.camera.viewProj, this.frustum);
    // Velocity for the motion-blur stage: each object is drawn against the
    // previous frame's view-projection (sky/walls included, so the blur follows
    // the camera too).
    this.draw.prevViewProj = this.hasPrevViewProj ? this.lastViewProj : this.camera.viewProj;
    this.draw.farPlane = this.camera.far;
    this.draw.setTime((performance.now() - this.startTime) / 1000);
    this.post.begin();
    this.draw.onBlitDepth = () => this.post.blitDepth();
  }

  /** Composite the scene target onto the canvas (call after the scene draw). */
  endFrame(): void {
    mat4.copy(this.lastViewProj, this.camera.viewProj);
    vec3.copy(this.prevCameraPos, this.camera.position);
    this.hasPrevViewProj = true;
    // The velocity buffer holds one frame of screen motion, so scale it to a
    // fixed exposure *time* (1/60 s) instead of a fixed fraction of a frame:
    // the streak then looks the same at 30, 60 or 120 fps.
    const dtS = Math.max(this.frameDtMs, 1) / 1000;
    const shutter = Math.min(2, Math.max(0.25, MOTION_BLUR_EXPOSURE_S / dtS));
    this.post.present({
      motionBlur: this.renderOptions.motionBlur,
      flare: this.renderOptions.flare,
      flareTex: this.renderOptions.flareTex,
      shutter,
      maxBlur: 0.08,
    });
  }

  trackDraws(n = 1): void {
    this.stats.draws += n;
  }

  trackCulled(n = 1): void {
    this.stats.culled += n;
  }

  /** Read after the frame: objects the octree rejected this frame. */
  get culledThisFrame(): number {
    return this.cullStats.culled;
  }

  camPos(): vec3 {
    return this.camera.position;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      let dt = now - this.last;
      this.last = now;
      if (dt > 100) dt = 100;
      if (dt > 0) {
        this.frameDtMs = dt;
        this.onFrame?.(dt);
        this.frames++;
        this.fpsT += dt / 1000;
        if (this.fpsT >= 0.5) {
          this.stats.fps = Math.round(this.frames / this.fpsT);
          this.frames = 0;
          this.fpsT = 0;
          this.onStats?.({ ...this.stats });
        }
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose(): void {
    this.stop();
    this.unwatch?.();
    this.resizeObs?.disconnect();
  }
}
