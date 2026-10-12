// Renderer + scene management: persistent WebGL2 context, stable loop,
// two-pass draw (opaque then alpha, like Map.Draw), instanced environment,
// sky-follows-camera (Sky.cs), frustum culling without per-frame allocation.
// Vue owns UI state; this module owns GPU resources and scene state.

import { mat4, quat, vec3 } from 'gl-matrix';
import { Camera } from './camera';
import { createFrustum, distToCamSq, extractFrustum, sphereVisible } from './frustum';
import type { FrustumPlanes } from './frustum';
import { createLitProgram, createUnlitProgram } from './shaders';
import type { LitProgram, UnlitProgram } from './shaders';
import { initGL, resizeGL, watchContextLoss } from './gl';
import { getFallback, loadTexture, loadTextureAny } from './texture';
import type { TexEntry } from './texture';
import { composeMatrix, loadModel } from './model';
import type { GpuModel } from './model';
import { ObType, Octree } from './octree';
import type { SpatialItem } from './octree';

// ---------------------------------------------------------------------------
// Scene description (converted from Level.xml / Background.xml; see
// tools/convert-levels.mjs and src/game/levels.ts).
// ---------------------------------------------------------------------------

export type ObjectKind =
  | 'ship' | 'asteroid' | 'ministar' | 'base' | 'flag'
  | 'ark' | 'addon' | 'bullet' | 'sky' | 'planet';

export interface PlacedObject {
  kind: ObjectKind;
  model: string; // model alias, e.g. "Fighter3"
  team: 'human' | 'alien' | 'ambient';
  pos: [number, number, number];
  name?: string;
  amount?: number; // for random/around scatter
  scatter?: 'random' | 'around' | 'point';
}

export interface SceneDesc {
  key: string;
  sky: string;
  size: number;
  objects: PlacedObject[];
  camera: { mode: 'lookAtObject' | 'lookAtPosition'; target: string | [number, number, number] };
  fogColor?: [number, number, number];
}

export interface RenderStats {
  fps: number;
  draws: number;
  culled: number;
  instances: number;
}

// ---------------------------------------------------------------------------
// Runtime objects
// ---------------------------------------------------------------------------

interface Ship {
  id: number;
  spatial: SpatialItem;
  pos: vec3;
  rot: quat;
  scale: number;
  model: string;
  team: 'human' | 'alien' | 'ambient';
  name: string;
  vel: vec3;
  spin: number;
  alpha: number;
  kind: ObjectKind;
  gpu: GpuModel | null;
  tex: TexEntry | null;
  world: mat4;
  worldInvT: mat4;
}

interface InstChunk {
  center: vec3;
  radius: number;
  matrices: Float32Array; // N*16
  count: number;
  ibo: WebGLBuffer | null;
}

interface InstSet {
  model: string;
  gpu: GpuModel | null;
  tex: TexEntry | null;
  chunks: InstChunk[];
  alpha: number;
  unlit: boolean;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const INST_VERT = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
layout(location=3) in vec4 iM0;
layout(location=4) in vec4 iM1;
layout(location=5) in vec4 iM2;
layout(location=6) in vec4 iM3;
uniform mat4 uView;
uniform mat4 uProj;
out vec3 vN; out vec3 vW; out vec2 vUV;
void main() {
  mat4 W = mat4(iM0, iM1, iM2, iM3);
  vec4 w = W * vec4(aPos, 1.0);
  vW = w.xyz; vN = mat3(W) * aNormal; vUV = aUV;
  gl_Position = uProj * uView * w;
}`;

const INST_FRAG = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vW; in vec2 vUV;
uniform sampler2D uTex; uniform bool uHasTex;
uniform vec3 uDiffuse; uniform vec3 uAmbient; uniform vec3 uLightDir;
uniform vec3 uLightDiffuse; uniform vec3 uCamPos; uniform float uAlpha;
out vec4 oColor;
void main() {
  vec3 base = uDiffuse;
  if (uHasTex) base *= texture(uTex, vUV).rgb;
  vec3 N = normalize(vN);
  float nd = max(dot(N, normalize(uLightDir)), 0.0);
  vec3 col = base * (uAmbient + uLightDiffuse * nd);
  float a = uAlpha;
  if (uHasTex) a *= texture(uTex, vUV).a;
  oColor = vec4(col, a);
}`;

const STAR_VERT = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uView; uniform mat4 uProj;
uniform float uSize;
void main() {
  gl_Position = uProj * uView * vec4(aPos, 1.0);
  float d = max(1.0, length(aPos));
  gl_PointSize = clamp(uSize * 900.0 / d, 1.0, 5.0);
}`;

const STAR_FRAG = `#version 300 es
precision highp float;
uniform vec3 uColor; uniform float uAlpha;
out vec4 oColor;
void main() {
  vec2 c = gl_PointCoord - vec2(0.5);
  float m = smoothstep(0.5, 0.15, length(c));
  oColor = vec4(uColor, uAlpha * m);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(s));
  }
  return s;
}

function link(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('link: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export interface InputState {
  fwd: number; // -1..1 (W/S or arrows)
  strafe: number; // -1..1 (A/D)
  up: number; // -1..1 (R/F or Space/Shift)
  yaw: number; // mouse/ Q/E
  pitch: number;
  fire: boolean;
  nitro: boolean;
}

export const neutralInput: InputState = {
  fwd: 0, strafe: 0, up: 0, yaw: 0, pitch: 0, fire: false, nitro: false,
};

export class Renderer {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  camera = new Camera();
  lit!: LitProgram;
  unlit!: UnlitProgram;
  instProg!: WebGLProgram;
  starProg!: WebGLProgram;
  ships: Ship[] = [];
  sets: InstSet[] = [];
  stars: { vao: WebGLVertexArrayObject | null; vbo: WebGLBuffer | null; count: number } | null = null;
  sky: { gpu: GpuModel | null; tex: TexEntry | null; model: string } = { gpu: null, tex: null, model: 'Sky1' };
  desc: SceneDesc | null = null;
  frustum: FrustumPlanes = createFrustum();
  octree: Octree | null = null;
  stats: RenderStats = { fps: 0, draws: 0, culled: 0, instances: 0 };
  input: InputState = { ...neutralInput };
  playerName = 'HS1';
  time = 0;
  running = false;
  interactive = false; // game routes set true (ship controllable); menus false
  wireframe = false;
  billboards = true;
  motionBlur = false;
  detail = 2;
  lightDir = vec3.fromValues(-0.4, 0.8, 0.45);
  private raf = 0;
  private last = 0;
  private frames = 0;
  private fpsT = 0;
  private unwatch: (() => void) | null = null;
  private resizeObs: ResizeObserver | null = null;
  private culledScratch: Ship[] = [];
  private tmpM = mat4.create();
  private tmpV = vec3.create();
  private nextId = 1;
  onStats: ((s: RenderStats) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = initGL(canvas);
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;
    this.buildPrograms();
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
  }

  private buildPrograms(): void {
    const gl = this.gl;
    this.lit = createLitProgram(gl);
    this.unlit = createUnlitProgram(gl);
    this.instProg = link(gl, compile(gl, gl.VERTEX_SHADER, INST_VERT), compile(gl, gl.FRAGMENT_SHADER, INST_FRAG));
    this.starProg = link(gl, compile(gl, gl.VERTEX_SHADER, STAR_VERT), compile(gl, gl.FRAGMENT_SHADER, STAR_FRAG));
  }

  private handleLost(): void {
    cancelAnimationFrame(this.raf);
    this.running = false;
  }

  private handleRestored(): void {
    this.buildPrograms();
    // Drop GPU handles; they will be re-fetched via loadModel/loadTexture.
    this.ships.forEach((s) => {
      s.gpu = null;
      s.tex = null;
    });
    this.sets.forEach((s) => {
      s.gpu = null;
      s.tex = null;
    });
    this.stars = null;
    if (this.desc) void this.setScene(this.desc);
    if (!this.running) this.start();
  }

  modelUrl(alias: string): string {
    return ('./assets/models/' + alias + '.json').replace('./assets', import.meta.env.BASE_URL + 'assets');
  }

  textureUrl(alias: string): string {
    // TextureConfig aliases map to System/* or Control/* png/jpg; copied under assets/textures.
    return (import.meta.env.BASE_URL + 'assets/textures/' + alias).replace('//assets', '/assets');
  }

  private textureCandidates(alias: string): string[] {
    const b = this.textureUrl(alias);
    return [b + '.png', b + '.jpg'];
  }

  async setScene(desc: SceneDesc): Promise<void> {
    this.desc = desc;
    this.ships = [];
    this.sets = [];
    this.stars = null;
    this.sky = { gpu: null, tex: null, model: desc.sky };
    const half = desc.size / 2;
    this.octree = new Octree(
      vec3.fromValues(-half, -half, -half),
      vec3.fromValues(half, half, half),
    );
    const gl = this.gl;
    // Sky loads async; render proceeds without it.
    void loadModel(gl, this.modelUrl(desc.sky)).then((g) => {
      this.sky.gpu = g;
    });
    void loadTextureAny(gl, this.textureCandidates('_pixel')).then((t) => {
      this.sky.tex = t;
    });

    const rng = mulberry32(desc.key.length * 7919 + desc.size);
    const starPositions: number[] = [];
    for (const o of desc.objects) {
      if (o.kind === 'ministar') {
        const n = Math.min(o.amount ?? 600, 6000);
        for (let i = 0; i < n; i++) {
          starPositions.push(
            (rng() * 2 - 1) * half,
            (rng() * 2 - 1) * half,
            (rng() * 2 - 1) * half,
          );
        }
        continue;
      }
      if (o.kind === 'asteroid' && (o.scatter === 'random' || (o.amount ?? 0) > 8)) {
        this.addInstanced(o, half, rng);
        continue;
      }
      if (o.scatter === 'around') {
        // Original semantics: position="around" spawns ONE ship near the
        // team's base (amount only applies to random scatter).
        const n = Math.min(o.amount ?? 1, 12);
        for (let i = 0; i < n; i++) {
          const p = this.scatterAround(o.pos, half, rng);
          this.addShip({ ...o, pos: p, scatter: 'point' });
        }
        continue;
      }
      this.addShip(o);
    }
    if (starPositions.length) this.buildStars(starPositions);
    // Async model/texture fetch for everything. Converted materials carry
    // their diffuse texture ref (assets/textures/objects/...); prefer it,
    // fall back to the neutral _pixel.
    for (const s of this.ships) {
      void loadModel(gl, this.modelUrl(s.model)).then((g) => {
        s.gpu = g;
        // Widen the culling bounds from real model data (conservative:
        // center stays at the object position, radius covers the mesh).
        if (g.boundingSphere.radius > s.spatial.radius) {
          const rr = g.boundingSphere.radius * s.scale;
          s.spatial.radius = rr;
          for (let k = 0; k < 3; k++) {
            s.spatial.min[k] = s.spatial.center[k] - rr;
            s.spatial.max[k] = s.spatial.center[k] + rr;
          }
        }
        const mt = g.materials[0]?.texture;
        const urls = mt
          ? [import.meta.env.BASE_URL + mt, ...this.textureCandidates('_pixel')]
          : this.textureCandidates('_pixel');
        void loadTextureAny(gl, urls).then((t) => {
          s.tex = t;
        });
      });
      void loadTextureAny(gl, this.textureCandidates('_pixel')).then((t) => {
        if (!s.tex) s.tex = t;
      });
    }
    for (const set of this.sets) {
      void loadModel(gl, this.modelUrl(set.model)).then((g) => {
        set.gpu = g;
      });
      void loadTextureAny(gl, this.textureCandidates('_pixel')).then((t) => {
        set.tex = t;
      });
    }
    this.applyCameraDesc();
  }

  private scatterAround(around: [number, number, number], half: number, rng: () => number): [number, number, number] {
    const r = 60 + rng() * 120;
    const a = rng() * Math.PI * 2;
    const b = (rng() - 0.5) * Math.PI;
    return [
      Math.max(-half, Math.min(half, around[0] + Math.cos(a) * Math.cos(b) * r)),
      Math.max(-half, Math.min(half, around[1] + Math.sin(b) * r)),
      Math.max(-half, Math.min(half, around[2] + Math.sin(a) * Math.cos(b) * r)),
    ];
  }

  private addShip(o: PlacedObject): void {
    const pos = vec3.fromValues(o.pos[0], o.pos[1], o.pos[2]);
    const rot = quat.create();
    quat.fromEuler(rot, 0, Math.random() * 360, 0);
    const scale = o.kind === 'base' ? 1 : o.kind === 'ark' ? 1 : o.kind === 'planet' ? 6 : 1;
    const world = mat4.create();
    composeMatrix(world, pos, rot, scale);
    const r = o.kind === 'base' ? 9 : o.kind === 'ark' ? 8 : 3;
    const spatial: SpatialItem = {
      id: this.nextId++,
      type: o.kind === 'asteroid' || o.kind === 'planet' ? ObType.Environment : ObType.Interactive,
      center: vec3.clone(pos),
      radius: r,
      min: vec3.fromValues(pos[0] - r, pos[1] - r, pos[2] - r),
      max: vec3.fromValues(pos[0] + r, pos[1] + r, pos[2] + r),
    };
    const ship: Ship = {
      id: spatial.id, spatial, pos, rot, scale, model: o.model,
      team: o.team, name: o.name ?? '', vel: vec3.create(),
      spin: o.kind === 'asteroid' || o.kind === 'addon' ? 0.4 + Math.random() * 0.6 : 0,
      alpha: o.kind === 'ark' ? 0.2 : 1, // Ark.cs alpha=0.2
      kind: o.kind, gpu: null, tex: null, world,
      worldInvT: mat4.create(),
    };
    mat4.invert(ship.worldInvT, world);
    mat4.transpose(ship.worldInvT, ship.worldInvT);
    this.ships.push(ship);
    this.octree?.insert(spatial);
  }

  private addInstanced(o: PlacedObject, half: number, rng: () => number): void {
    let set = this.sets.find((s) => s.model === o.model);
    if (!set) {
      set = { model: o.model, gpu: null, tex: null, chunks: [], alpha: 1, unlit: false };
      this.sets.push(set);
    }
    const total = Math.min(o.amount ?? 70, 4000);
    const perChunk = 256;
    let mats: number[] = [];
    let center = vec3.create();
    let count = 0;
    const flush = () => {
      if (!count) return;
      const arr = new Float32Array(mats);
      // chunk bounds
      const c = vec3.clone(center);
      vec3.scale(c, c, 1 / count);
      let radius = 0;
      for (let i = 0; i < count; i++) {
        const dx = arr[i * 16 + 12] - c[0];
        const dy = arr[i * 16 + 13] - c[1];
        const dz = arr[i * 16 + 14] - c[2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 8;
        if (d > radius) radius = d;
      }
      set!.chunks.push({ center: c, radius, matrices: arr, count, ibo: null });
      mats = [];
      center = vec3.create();
      count = 0;
    };
    const m = mat4.create();
    const q = quat.create();
    const p = vec3.create();
    const s = vec3.create();
    for (let i = 0; i < total; i++) {
      p[0] = (rng() * 2 - 1) * half;
      p[1] = (rng() * 2 - 1) * half;
      p[2] = (rng() * 2 - 1) * half;
      quat.fromEuler(q, rng() * 360, rng() * 360, rng() * 360);
      const sc = 2 + rng() * 7;
      vec3.set(s, sc, sc, sc);
      mat4.fromRotationTranslationScale(m, q, p, s);
      mats.push(...(m as unknown as number[]));
      vec3.add(center, center, p);
      count++;
      if (count >= perChunk) flush();
    }
    flush();
  }

  private buildStars(positions: number[]): void {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.stars = { vao, vbo, count: positions.length / 3 };
  }

  private applyCameraDesc(): void {
    if (!this.desc) return;
    const c = this.desc.camera;
    if (c.mode === 'lookAtPosition' && Array.isArray(c.target)) {
      vec3.set(this.camera.lookAt, c.target[0], c.target[1], c.target[2]);
      vec3.set(this.camera.position, 16, 32, 16);
      this.camera.h = 45;
      this.camera.v = 45;
      this.camera.update();
    } else if (c.mode === 'lookAtObject' && typeof c.target === 'string') {
      this.playerName = c.target;
      const t = this.ships.find((s) => s.name === c.target);
      if (t) this.camera.follow(t.pos, 16, 6);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      let dt = (now - this.last) / 1000;
      this.last = now;
      if (dt > 0.1) dt = 0.1;
      if (dt > 0) {
        this.time += dt;
        this.update(dt);
        this.draw();
        this.frames++;
        this.fpsT += dt;
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

  /** Find the player ship (camera target). */
  player(): Ship | undefined {
    return this.ships.find((s) => s.name === this.playerName);
  }

  // -- update (Map.Update + Object3D.NextPosition simplified) ----------------
  private update(dt: number): void {
    const p = this.player();
    if (p && this.interactive) {
      // Port of NextPosition: accel from input, friction, clamp to max speed.
      const accel = 60 * (this.input.nitro ? 7.5 : 1); // LaunchNitro multiplier=7.5
      const maxV = 40 * (this.input.nitro ? 3 : 1);
      const dir = vec3.create();
      this.camera.direction(dir);
      const side = vec3.create();
      this.camera.side(side, dir);
      const a = vec3.create();
      vec3.scaleAndAdd(a, a, dir, this.input.fwd * accel);
      vec3.scaleAndAdd(a, a, side, this.input.strafe * accel);
      a[1] += this.input.up * accel;
      // friction
      vec3.scaleAndAdd(p.vel, p.vel, a, dt);
      vec3.scale(p.vel, p.vel, 1 - Math.min(0.9, 1.6 * dt));
      const sp = vec3.length(p.vel);
      if (sp > maxV) vec3.scale(p.vel, p.vel, maxV / sp);
      vec3.scaleAndAdd(p.pos, p.pos, p.vel, dt);
      // Face velocity like SpaceShip auto-yaw.
      if (sp > 1) {
        const yaw = Math.atan2(p.vel[0], p.vel[2]);
        quat.fromEuler(p.rot, 0, (yaw * 180) / Math.PI, 0);
      }
      composeMatrix(p.world, p.pos, p.rot, p.scale);
      mat4.invert(p.worldInvT, p.world);
      mat4.transpose(p.worldInvT, p.worldInvT);
      vec3.copy(p.spatial.center, p.pos);
      p.spatial.min[0] = p.pos[0] - p.spatial.radius;
      p.spatial.min[1] = p.pos[1] - p.spatial.radius;
      p.spatial.min[2] = p.pos[2] - p.spatial.radius;
      p.spatial.max[0] = p.pos[0] + p.spatial.radius;
      p.spatial.max[1] = p.pos[1] + p.spatial.radius;
      p.spatial.max[2] = p.pos[2] + p.spatial.radius;
      this.camera.follow(p.pos, 16, 6);
    } else {
      // Menu background drift: slow orbit around the lookAt point.
      this.camera.h = (this.camera.h + dt * 4) % 360;
      const t = this.camera.lookAt;
      const dist = 42;
      const h = (this.camera.h * Math.PI) / 180;
      const v = (this.camera.v * Math.PI) / 180;
      this.camera.position[0] = t[0] + Math.sin(h) * Math.cos(v) * dist;
      this.camera.position[1] = t[1] + Math.sin(v) * dist * 0.6 + 10;
      this.camera.position[2] = t[2] + Math.cos(h) * Math.cos(v) * dist;
      this.camera.update();
      // Gentle idle spin for pickups/debris.
      for (const s of this.ships) {
        if (s.spin !== 0) {
          const e = quat.create();
          quat.fromEuler(e, 0, dt * 20 * s.spin, 0);
          quat.multiply(s.rot, e, s.rot);
          composeMatrix(s.world, s.pos, s.rot, s.scale);
          mat4.invert(s.worldInvT, s.world);
          mat4.transpose(s.worldInvT, s.worldInvT);
        }
      }
    }
  }

  // -- draw (two passes like Map.Draw) ---------------------------------------
  private draw(): void {
    const gl = this.gl;
    if (resizeGL(this.canvas, gl)) {
      this.camera.setAspect(this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight));
    }
    extractFrustum(this.camera.viewProj, this.frustum);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    let draws = 0;
    let culled = 0;
    let instances = 0;

    // Sky first, no depth write, follows camera (Sky.cs).
    if (this.sky.gpu) {
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      gl.useProgram(this.unlit.prog);
      mat4.copy(this.tmpM, this.camera.view);
      this.tmpM[12] = 0;
      this.tmpM[13] = 0;
      this.tmpM[14] = 0; // rotation-only view
      gl.uniformMatrix4fv(this.unlit.uView, false, this.tmpM as Float32Array);
      gl.uniformMatrix4fv(this.unlit.uProj, false, this.camera.proj as Float32Array);
      const wm = mat4.create();
      mat4.fromTranslation(wm, this.camera.position);
      gl.uniformMatrix4fv(this.unlit.uWorld, false, wm as Float32Array);
      const tex = this.sky.tex ?? getFallback(gl);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex.tex);
      gl.uniform1i(this.unlit.uTex, 0);
      gl.uniform1i(this.unlit.uHasTex, 1);
      gl.uniform3f(this.unlit.uColor, 0.55, 0.6, 0.75);
      gl.uniform1f(this.unlit.uAlpha, 1);
      for (const m of this.sky.gpu.meshes) {
        gl.bindVertexArray(m.vao);
        const type = m.indexCount > 65535 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
        gl.drawElements(gl.TRIANGLES, m.indexCount, type, 0);
        draws++;
      }
      gl.bindVertexArray(null);
      gl.enable(gl.CULL_FACE);
      gl.depthMask(true);
    }

    // Opaque pass: individual ships (cull per object).
    const opaque: Ship[] = [];
    const transparent: Ship[] = [];
    this.culledScratch.length = 0;
    for (const s of this.ships) {
      if (!s.gpu) {
        culled++;
        continue;
      }
      if (!sphereVisible(this.frustum, s.spatial.center, s.spatial.radius)) {
        culled++;
        continue;
      }
      (s.alpha >= 1 ? opaque : transparent).push(s);
    }
    // Far-to-near for transparent (ObjectDistanceComparer).
    transparent.sort(
      (a, b) =>
        distToCamSq(this.camera.position, b.pos) - distToCamSq(this.camera.position, a.pos),
    );

    gl.useProgram(this.lit.prog);
    this.setLitGlobals();
    for (const s of opaque) {
      this.drawShip(s);
      draws++;
      instances++;
    }

    // Instanced environment (chunk-level culling).
    this.drawInstanced(gl, false);
    draws += this.sets.reduce((n, s) => n + s.chunks.length, 0);

    // Stars (always visible, one draw).
    if (this.stars) {
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.starProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.starProg, 'uView'), false, this.camera.view as Float32Array);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.starProg, 'uProj'), false, this.camera.proj as Float32Array);
      gl.uniform1f(gl.getUniformLocation(this.starProg, 'uSize'), 2.2);
      gl.uniform3f(gl.getUniformLocation(this.starProg, 'uColor'), 0.8, 0.85, 1);
      gl.uniform1f(gl.getUniformLocation(this.starProg, 'uAlpha'), 0.9);
      gl.bindVertexArray(this.stars.vao);
      gl.drawArrays(gl.POINTS, 0, this.stars.count);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      draws++;
    }

    // Alpha pass (DepthRead + AlphaBlend like Map.Draw pass 2).
    if (transparent.length) {
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.lit.prog);
      this.setLitGlobals();
      for (const s of transparent) {
        this.drawShip(s);
        draws++;
      }
      gl.disable(gl.BLEND);
      gl.depthMask(true);
    }

    this.stats.draws = draws;
    this.stats.culled = culled;
    this.stats.instances = instances;
  }

  private setLitGlobals(): void {
    const gl = this.gl;
    const L = this.lit;
    gl.uniformMatrix4fv(L.uView, false, this.camera.view as Float32Array);
    gl.uniformMatrix4fv(L.uProj, false, this.camera.proj as Float32Array);
    gl.uniform3f(L.uAmbient, 0.08, 0.08, 0.09);
    vec3.normalize(this.tmpV, this.lightDir);
    gl.uniform3f(L.uLightDir, this.tmpV[0], this.tmpV[1], this.tmpV[2]);
    gl.uniform3f(L.uLightDiffuse, 1, 1, 1);
    gl.uniform3f(L.uLightSpec, 0.68, 0.85, 1); // SpecularColor LightBlue
    gl.uniform3f(L.uCamPos, this.camera.position[0], this.camera.position[1], this.camera.position[2]);
  }

  private drawShip(s: Ship): void {
    const gl = this.gl;
    const L = this.lit;
    gl.uniformMatrix4fv(L.uWorld, false, s.world as Float32Array);
    gl.uniformMatrix4fv(L.uWorldInvT, false, s.worldInvT as Float32Array);
    const tex = s.tex ?? getFallback(gl);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.tex);
    gl.uniform1i(L.uTex, 0);
    gl.uniform1i(L.uHasTex, 1);
    if (this.wireframe) gl.polygonOffset(0, 0);
    for (const m of s.gpu!.meshes) {
      const mat = s.gpu!.materials[m.materialIndex] ?? s.gpu!.materials[0];
      if (mat) {
        gl.uniform3f(L.uDiffuse, mat.diffuse[0], mat.diffuse[1], mat.diffuse[2]);
        gl.uniform3f(L.uEmissive, mat.emissive[0], mat.emissive[1], mat.emissive[2]);
        gl.uniform1f(L.uShininess, Math.max(4, Math.min(64, mat.shininess)));
        gl.uniform1f(L.uAlpha, s.alpha * mat.alpha);
      } else {
        gl.uniform3f(L.uDiffuse, 0.75, 0.78, 0.85);
        gl.uniform3f(L.uEmissive, 0, 0, 0);
        gl.uniform1f(L.uShininess, 32);
        gl.uniform1f(L.uAlpha, s.alpha);
      }
      gl.bindVertexArray(m.vao);
      const type = m.indexCount > 65535 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      if (this.wireframe) {
        // WebGL2 has no wireframe mode; emulate with LINES over triangles is
        // costly — approximate by drawing points? Keep solid (documented).
      }
      gl.drawElements(gl.TRIANGLES, m.indexCount, type, 0);
    }
    gl.bindVertexArray(null);
  }

  private drawInstanced(gl: WebGL2RenderingContext, _transparent: boolean): void {
    if (!this.sets.length) return;
    gl.useProgram(this.instProg);
    const uView = gl.getUniformLocation(this.instProg, 'uView');
    const uProj = gl.getUniformLocation(this.instProg, 'uProj');
    const uTex = gl.getUniformLocation(this.instProg, 'uTex');
    const uHasTex = gl.getUniformLocation(this.instProg, 'uHasTex');
    const uDiffuse = gl.getUniformLocation(this.instProg, 'uDiffuse');
    const uAmbient = gl.getUniformLocation(this.instProg, 'uAmbient');
    const uLightDir = gl.getUniformLocation(this.instProg, 'uLightDir');
    const uLightDiffuse = gl.getUniformLocation(this.instProg, 'uLightDiffuse');
    const uCamPos = gl.getUniformLocation(this.instProg, 'uCamPos');
    const uAlpha = gl.getUniformLocation(this.instProg, 'uAlpha');
    gl.uniformMatrix4fv(uView, false, this.camera.view as Float32Array);
    gl.uniformMatrix4fv(uProj, false, this.camera.proj as Float32Array);
    gl.uniform3f(uAmbient, 0.08, 0.08, 0.09);
    vec3.normalize(this.tmpV, this.lightDir);
    gl.uniform3f(uLightDir, this.tmpV[0], this.tmpV[1], this.tmpV[2]);
    gl.uniform3f(uLightDiffuse, 1, 1, 1);
    gl.uniform3f(uCamPos, this.camera.position[0], this.camera.position[1], this.camera.position[2]);
    for (const set of this.sets) {
      if (!set.gpu) continue;
      const tex = set.tex ?? getFallback(gl);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex.tex);
      gl.uniform1i(uTex, 0);
      gl.uniform1i(uHasTex, 1);
      gl.uniform3f(uDiffuse, 0.6, 0.58, 0.55);
      gl.uniform1f(uAlpha, set.alpha);
      for (const mesh of set.gpu.meshes) {
        for (const ch of set.chunks) {
          if (!sphereVisible(this.frustum, ch.center, ch.radius)) {
            this.stats.culled += ch.count;
            continue;
          }
          // Bind base geometry VAO then add cached instanced matrix buffer.
          gl.bindVertexArray(mesh.vao);
          if (!ch.ibo) {
            ch.ibo = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, ch.ibo);
            gl.bufferData(gl.ARRAY_BUFFER, ch.matrices, gl.STATIC_DRAW);
          } else {
            gl.bindBuffer(gl.ARRAY_BUFFER, ch.ibo);
          }
          const stride = 64;
          for (let k = 0; k < 4; k++) {
            gl.enableVertexAttribArray(3 + k);
            gl.vertexAttribPointer(3 + k, 4, gl.FLOAT, false, stride, k * 16);
            gl.vertexAttribDivisor(3 + k, 1);
          }
          const type = mesh.indexCount > 65535 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
          gl.drawElementsInstanced(gl.TRIANGLES, mesh.indexCount, type, 0, ch.count);
          for (let k = 0; k < 4; k++) {
            gl.disableVertexAttribArray(3 + k);
            gl.vertexAttribDivisor(3 + k, 0);
          }
          gl.bindVertexArray(null);
        }
      }
    }
  }
}
