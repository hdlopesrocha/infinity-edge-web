// Renderer host: canvas, GL context, camera, programs, stable loop.

import { Camera } from './camera';
import { Draw } from './draw';
import { createFrustum, extractFrustum } from './frustum';
import type { FrustumPlanes } from './frustum';
import type { CullStats } from './octree';
import { initGL, resizeGL, watchContextLoss } from './gl';
import { vec3 } from './math';

export interface RenderStats {
  fps: number;
  draws: number;
  culled: number;
}

export class Renderer {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  draw: Draw;
  camera = new Camera();
  frustum: FrustumPlanes = createFrustum();
  stats: RenderStats = { fps: 0, draws: 0, culled: 0 };
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

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = initGL(canvas);
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;
    this.draw = new Draw(gl);
    this.unwatch = watchContextLoss(
      canvas,
      () => this.handleLost(),
      () => this.handleRestored(),
    );
    resizeGL(canvas, gl);
    this.resizeObs = new ResizeObserver(() => {
      if (resizeGL(canvas, gl)) {
        this.camera.setAspect(canvas.clientWidth / Math.max(1, canvas.clientHeight));
      }
    });
    this.resizeObs.observe(canvas);
    this.camera.setAspect(canvas.clientWidth / Math.max(1, canvas.clientHeight));
    this.camera.updateMatrices();
  }

  private handleLost(): void {
    cancelAnimationFrame(this.raf);
    this.running = false;
  }

  private handleRestored(): void {
    this.draw = new Draw(this.gl);
    this.onRebuilt?.();
    if (!this.running) this.start();
  }

  beginFrame(): void {
    const gl = this.gl;
    if (resizeGL(this.canvas, gl)) {
      this.camera.setAspect(this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight));
    }
    this.stats.draws = 0;
    this.stats.culled = 0;
    this.cullStats.culled = 0;
    extractFrustum(this.camera.viewProj, this.frustum);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
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
