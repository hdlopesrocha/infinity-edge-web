// Draw primitives with BasicEffect-exact state + the web rendering additions:
// per-object velocity for motion blur, volumetric flare/glow geometry and the
// noise-driven smoke batch.

import { mat4, vec3 } from './math';
import {
  BBQ_FRAG, BBQ_VERT, GLOW_FRAG, GLOW_VERT, LIT_FRAG, LIT_VERT, PLUME_FRAG, PLUME_VERT,
  SMOKE_FRAG, SMOKE_VERT, UNLIT_FRAG, UNLIT_VERT, linkProgram, uniforms,
} from './shaders';
import { getFallback } from './texture';
import type { TexEntry } from './texture';
import type { GpuModel } from './model';

export interface LitOpts {
  alpha: number;
  emissive: [number, number, number];
  diffuse?: [number, number, number] | null;
  light: boolean;
  /** Previous frame's world matrix (motion-blur velocity); defaults to world. */
  prevWorld?: mat4 | null;
}

export interface QuadMesh {
  vao: WebGLVertexArrayObject | null;
  count: number;
}

/** Simple pos/normal/uv mesh used by the flare plume and glow shells. */
interface Mesh3D {
  vao: WebGLVertexArrayObject | null;
  count: number;
}

const IDENTITY = mat4.create();

function createMesh3D(
  gl: WebGL2RenderingContext,
  positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint16Array,
): Mesh3D {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  const nbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, nbo);
  gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
  const uvbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, uvbo);
  gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, count: indices.length };
}

/** Unit cone along +Y, apex at the origin: flare plume (uv.y = 0 at base). */
function buildPlumeMesh(gl: WebGL2RenderingContext, segments = 14): Mesh3D {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const cx = Math.cos(a), cz = Math.sin(a);
    // base ring
    pos.push(cx * 0.5, 0, cz * 0.5);
    nor.push(cx, 0.35, cz);
    uv.push(i / segments, 0);
    // tip ring (slightly open so the cone has volume from the side)
    pos.push(cx * 0.06, 1, cz * 0.06);
    nor.push(cx, 0.9, cz);
    uv.push(i / segments, 1);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, c, b, b, c, d);
  }
  return createMesh3D(gl, new Float32Array(pos), new Float32Array(nor), new Float32Array(uv), new Uint16Array(idx));
}

/** Unit sphere (radius 1) for the additive glow shells. */
function buildGlowMesh(gl: WebGL2RenderingContext, rings = 8, segments = 12): Mesh3D {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let y = 0; y <= rings; y++) {
    const v = y / rings;
    const phi = v * Math.PI;
    for (let x = 0; x <= segments; x++) {
      const u = x / segments;
      const theta = u * Math.PI * 2;
      const nx = Math.sin(phi) * Math.cos(theta);
      const ny = Math.cos(phi);
      const nz = Math.sin(phi) * Math.sin(theta);
      pos.push(nx, ny, nz);
      nor.push(nx, ny, nz);
      uv.push(u, v);
    }
  }
  for (let y = 0; y < rings; y++) {
    for (let x = 0; x < segments; x++) {
      const a = y * (segments + 1) + x;
      const b = a + segments + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return createMesh3D(gl, new Float32Array(pos), new Float32Array(nor), new Float32Array(uv), new Uint16Array(idx));
}

export class Draw {
  gl: WebGL2RenderingContext;
  lit: WebGLProgram;
  unlit: WebGLProgram;
  uLit: Record<string, WebGLUniformLocation | null>;
  uUnlit: Record<string, WebGLUniformLocation | null>;
  quadVao: WebGLVertexArrayObject | null = null;
  private invT = mat4.create();
  /** Previous frame's view-projection, for per-object velocity. */
  prevViewProj: mat4 = mat4.create();
  /** Set each frame by the Post owner: copies the opaque depth for soft smoke. */
  onBlitDepth: (() => void) | null = null;
  noiseTex: WebGLTexture | null = null;
  depthTex: WebGLTexture | null = null;
  private time = 0;
  // Model3D.Draw copies `camera._basicEffect.DirectionalLight0` into every
  // model effect each frame. Camera._basicEffect is a plain `new BasicEffect`
  // (never EnableDefaultLighting'ed), so the runtime light is the BasicEffect
  // default: Enabled, DiffuseColor One, Direction Vector3.Down. The shader
  // receives -DirLight0Direction (XNA: dot(N, -DirLight0Direction)).
  lightDir = vec3.fromValues(0, 1, 0);
  // Batched billboard state (Draws.DrawBillBoard is one quad per call; the
  // 10k miniStar + 1k cloud billboards are merged per texture instead).
  private bbq: WebGLProgram;
  private uBbq: Record<string, WebGLUniformLocation | null>;
  private bbqVao: WebGLVertexArrayObject | null = null;
  private bbqVbo: WebGLBuffer | null = null;
  private bbqVerts: number[] = [];
  private bbqTex: TexEntry | null = null;
  // Smoke batch (Perlin density + soft depth + velocity).
  private smokeProg: WebGLProgram;
  private uSmoke: Record<string, WebGLUniformLocation | null>;
  private smokeVao: WebGLVertexArrayObject | null = null;
  private smokeVbo: WebGLBuffer | null = null;
  private smokeVerts: number[] = [];
  // Flare geometry.
  private plumeProg: WebGLProgram;
  private uPlume: Record<string, WebGLUniformLocation | null>;
  private glowProg: WebGLProgram;
  private uGlow: Record<string, WebGLUniformLocation | null>;
  plumeMesh: Mesh3D;
  glowMesh: Mesh3D;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.lit = linkProgram(gl, LIT_VERT, LIT_FRAG);
    this.unlit = linkProgram(gl, UNLIT_VERT, UNLIT_FRAG);
    this.uLit = uniforms(gl, this.lit, ['uWorld', 'uView', 'uProj', 'uWorldInvT', 'uPrevWorld', 'uViewProjPrev', 'uTex', 'uHasTex', 'uDiffuse', 'uEmissive', 'uAmbient', 'uLightDir', 'uLightDiffuse', 'uLightSpec', 'uShininess', 'uCamPos', 'uAlpha']);
    this.uUnlit = uniforms(gl, this.unlit, ['uWorld', 'uPrevWorld', 'uViewProjPrev', 'uView', 'uProj', 'uTex', 'uHasTex', 'uColor', 'uAlpha']);
    this.bbq = linkProgram(gl, BBQ_VERT, BBQ_FRAG);
    this.uBbq = uniforms(gl, this.bbq, ['uView', 'uProj', 'uViewProjPrev', 'uTex']);
    {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, 0, gl.DYNAMIC_DRAW);
      // pos(3) prevPos(3) uv(2) color(3) alpha(1)
      const stride = 48;
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 3, gl.FLOAT, false, stride, 32);
      gl.enableVertexAttribArray(4);
      gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 44);
      gl.bindVertexArray(null);
      this.bbqVao = vao;
      this.bbqVbo = vbo;
    }
    this.smokeProg = linkProgram(gl, SMOKE_VERT, SMOKE_FRAG);
    this.uSmoke = uniforms(gl, this.smokeProg, ['uView', 'uProj', 'uViewProjPrev', 'uNoise', 'uDepth', 'uTime', 'uNear', 'uFar', 'uTint', 'uFreq', 'uSoftness', 'uDensity']);
    {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, 0, gl.DYNAMIC_DRAW);
      // pos(3) prevPos(3) uv(2) data(4: seed, age01, alpha, turbulence)
      const stride = 48;
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 32);
      gl.bindVertexArray(null);
      this.smokeVao = vao;
      this.smokeVbo = vbo;
    }
    this.plumeProg = linkProgram(gl, PLUME_VERT, PLUME_FRAG);
    this.uPlume = uniforms(gl, this.plumeProg, ['uWorld', 'uPrevWorld', 'uView', 'uProj', 'uViewProjPrev', 'uNoise', 'uCamPos', 'uColor', 'uTime', 'uIntensity']);
    this.glowProg = linkProgram(gl, GLOW_VERT, GLOW_FRAG);
    this.uGlow = uniforms(gl, this.glowProg, ['uWorld', 'uPrevWorld', 'uView', 'uProj', 'uViewProjPrev', 'uCamPos', 'uColor', 'uIntensity']);
    this.plumeMesh = buildPlumeMesh(gl);
    this.glowMesh = buildGlowMesh(gl);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.quadVao = vao;
  }

  /** Seconds since the renderer started; drives smoke/plume animation. */
  setTime(t: number): void {
    this.time = t;
  }

  timeSeconds(): number {
    return this.time;
  }

  bindNoise(tex: WebGLTexture): void {
    this.noiseTex = tex;
  }

  bindSceneDepth(tex: WebGLTexture | null): void {
    this.depthTex = tex;
  }

  setOpaque(): void {
    const gl = this.gl;
    this.flushBillboards();
    this.flushSmoke();
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
  }

  setTransparent(): void {
    const gl = this.gl;
    this.flushBillboards();
    this.flushSmoke();
    // First transparent pass of the frame: the opaque depth is now complete,
    // copy it so the soft-particle smoke can fade against real geometry.
    if (this.onBlitDepth) {
      const cb = this.onBlitDepth;
      this.onBlitDepth = null;
      cb();
    }
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** Additive pass (flare plumes, glow shells): no depth write, ONE + ONE. */
  setAdditive(): void {
    const gl = this.gl;
    this.flushBillboards();
    this.flushSmoke();
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
  }

  setNoDepth(): void {
    const gl = this.gl;
    this.flushBillboards();
    gl.depthMask(false);
    gl.disable(gl.DEPTH_TEST);
  }

  setDepth(): void {
    const gl = this.gl;
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }

  setCull(mode: 'back' | 'front' | 'none'): void {
    const gl = this.gl;
    if (mode === 'none') gl.disable(gl.CULL_FACE);
    else {
      gl.enable(gl.CULL_FACE);
      gl.cullFace(mode === 'back' ? gl.BACK : gl.FRONT);
    }
  }

  setDepthWrite(on: boolean): void {
    this.gl.depthMask(on);
  }

  drawModel(
    model: GpuModel, tex: TexEntry | null,
    world: mat4, view: mat4, proj: mat4, camPos: vec3, opts: LitOpts,
    texes?: (TexEntry | null)[] | null,
  ): void {
    const gl = this.gl;
    this.flushBillboards();
    this.flushSmoke();
    gl.useProgram(this.lit);
    const U = this.uLit;
    gl.uniformMatrix4fv(U.uView, false, view as Float32Array);
    gl.uniformMatrix4fv(U.uProj, false, proj as Float32Array);
    gl.uniformMatrix4fv(U.uWorld, false, world as Float32Array);
    gl.uniformMatrix4fv(U.uPrevWorld, false, (opts.prevWorld ?? world) as Float32Array);
    gl.uniformMatrix4fv(U.uViewProjPrev, false, this.prevViewProj as Float32Array);
    mat4.invert(this.invT, world);
    mat4.transpose(this.invT, this.invT);
    gl.uniformMatrix4fv(U.uWorldInvT, false, this.invT as Float32Array);
    gl.uniform3f(U.uAmbient, 0.001, 0.001, 0.001);
    vec3.normalize(this.lightDir, this.lightDir);
    gl.uniform3f(U.uLightDir, this.lightDir[0], this.lightDir[1], this.lightDir[2]);
    if (opts.light) {
      // The camera effect's DirLight0DiffuseColor is the BasicEffect default
      // Vector3.One (Model3D.Draw copies it; EnableDefaultLighting is only ever
      // applied to the model meshes' own effects and then overwritten).
      gl.uniform3f(U.uLightDiffuse, 1, 1, 1);
      // SpecularColor = Color.LightBlue (Model3D.Draw), SpecularPower = 1024.
      gl.uniform3f(U.uLightSpec, 0.6784314, 0.8470588, 0.9019608);
    } else {
      gl.uniform3f(U.uLightDiffuse, 0, 0, 0);
      gl.uniform3f(U.uLightSpec, 0, 0, 0);
    }
    gl.uniform3f(U.uCamPos, camPos[0], camPos[1], camPos[2]);
    const fallbackTex = tex ?? getFallback(gl);
    for (const m of model.meshes) {
      const bound = (texes && texes[m.materialIndex]) || fallbackTex;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bound.tex);
      gl.uniform1i(U.uTex, 0);
      gl.uniform1i(U.uHasTex, 1);
      const mat = model.materials[m.materialIndex] ?? model.materials[0];
      // Model3D.LoadModel overrides every mesh part's DiffuseColor to White
      // (only the texture albedo shades the surface); the .xnb material colours
      // are replaced at load time and never reach the draw call.
      const d = opts.diffuse ?? [1, 1, 1];
      gl.uniform3f(U.uDiffuse, d[0], d[1], d[2]);
      gl.uniform3f(U.uEmissive, opts.emissive[0], opts.emissive[1], opts.emissive[2]);
      gl.uniform1f(U.uShininess, 1024);
      gl.uniform1f(U.uAlpha, opts.alpha * (mat?.alpha ?? 1));
      gl.bindVertexArray(m.vao);
      gl.drawElements(gl.TRIANGLES, m.indexCount, m.indexType, 0);
    }
    gl.bindVertexArray(null);
  }

  drawUnlit(
    model: GpuModel, tex: TexEntry | null,
    world: mat4, view: mat4, proj: mat4,
    color: [number, number, number], alpha: number,
    prevWorld?: mat4 | null,
  ): void {
    const gl = this.gl;
    this.flushBillboards();
    this.flushSmoke();
    gl.useProgram(this.unlit);
    const U = this.uUnlit;
    gl.uniformMatrix4fv(U.uView, false, view as Float32Array);
    gl.uniformMatrix4fv(U.uProj, false, proj as Float32Array);
    gl.uniformMatrix4fv(U.uWorld, false, world as Float32Array);
    gl.uniformMatrix4fv(U.uPrevWorld, false, (prevWorld ?? world) as Float32Array);
    gl.uniformMatrix4fv(U.uViewProjPrev, false, this.prevViewProj as Float32Array);
    const t = tex ?? getFallback(gl);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.uniform1i(U.uTex, 0);
    gl.uniform1i(U.uHasTex, tex ? 1 : 0);
    gl.uniform3f(U.uColor, color[0], color[1], color[2]);
    gl.uniform1f(U.uAlpha, alpha);
    for (const m of model.meshes) {
      gl.bindVertexArray(m.vao);
      gl.drawElements(gl.TRIANGLES, m.indexCount, m.indexType, 0);
    }
    gl.bindVertexArray(null);
  }

  drawBillboard(
    tex: TexEntry | null, cx: number, cy: number, cz: number, size: number,
    color: [number, number, number], alpha: number,
    view: mat4, proj: mat4,
  ): void {
    if (alpha <= 0.001 || size <= 0) return;
    if (this.bbqTex !== tex) this.flushBillboards();
    this.bbqTex = tex;
    this.bbqView = view;
    this.bbqProj = proj;
    // Draws.DrawBillBoard corners: center + size * (-up - side), (up - side),
    // (-up + side), (up + side) with UV (1,0), (1,1), (0,0), (0,1).
    const v = view as unknown as Float32Array;
    const sx = v[0], sy = v[4], sz = v[8];
    const ux = v[1], uy = v[5], uz = v[9];
    const s = size;
    const c: [number, number, number][] = [
      [cx + (-ux - sx) * s, cy + (-uy - sy) * s, cz + (-uz - sz) * s],
      [cx + (ux - sx) * s, cy + (uy - sy) * s, cz + (uz - sz) * s],
      [cx + (-ux + sx) * s, cy + (-uy + sy) * s, cz + (-uz + sz) * s],
      [cx + (ux + sx) * s, cy + (uy + sy) * s, cz + (uz + sz) * s],
    ];
    const uv: [number, number][] = [[1, 0], [1, 1], [0, 0], [0, 1]];
    const idx = [0, 1, 2, 1, 3, 2];
    for (const i of idx) {
      this.bbqVerts.push(
        c[i][0], c[i][1], c[i][2],
        this.bbqPrev ? this.bbqPrev[0] : c[i][0], this.bbqPrev ? this.bbqPrev[1] : c[i][1], this.bbqPrev ? this.bbqPrev[2] : c[i][2],
        uv[i][0], uv[i][1], color[0], color[1], color[2], alpha,
      );
    }
  }

  /** Previous-frame centre for the *next* billboard (velocity). */
  private bbqPrev: [number, number, number] | null = null;
  private bbqView: mat4 | null = null;
  private bbqProj: mat4 | null = null;

  setBillboardPrev(cx: number, cy: number, cz: number): void {
    this.bbqPrev = [cx, cy, cz];
  }

  flushBillboards(): void {
    if (!this.bbqVerts.length || !this.bbqView || !this.bbqProj) {
      this.bbqVerts.length = 0;
      this.bbqTex = null;
      return;
    }
    const gl = this.gl;
    gl.useProgram(this.bbq);
    gl.uniformMatrix4fv(this.uBbq.uView, false, this.bbqView as unknown as Float32Array);
    gl.uniformMatrix4fv(this.uBbq.uProj, false, this.bbqProj as unknown as Float32Array);
    gl.uniformMatrix4fv(this.uBbq.uViewProjPrev, false, this.prevViewProj as Float32Array);
    const t = this.bbqTex ?? getFallback(gl);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.uniform1i(this.uBbq.uTex, 0);
    gl.bindVertexArray(this.bbqVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bbqVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.bbqVerts), gl.DYNAMIC_DRAW);
    // Draws.DrawBillBoard temporarily sets RasterizerState.CullNone (the camera
    // basis builds the quad clockwise on screen, so back-face culling hides
    // every star/smoke/cloud/flare); restore the caller's state afterwards.
    const cull = gl.isEnabled(gl.CULL_FACE);
    if (cull) gl.disable(gl.CULL_FACE);
    gl.drawArrays(gl.TRIANGLES, 0, this.bbqVerts.length / 12);
    if (cull) gl.enable(gl.CULL_FACE);
    gl.bindVertexArray(null);
    this.bbqVerts.length = 0;
    this.bbqTex = null;
  }

  // ------------------------------------------------------------------ smoke
  /**
   * Queue one smoke particle: a camera-facing disc whose density is sampled
   * from the 3D Perlin field in the fragment shader (world space + time), so
   * the plume "boils" and drifts instead of being a scrolling sprite.
   * `prev` is the particle centre one frame ago (motion-blur velocity).
   */
  drawSmoke(
    cx: number, cy: number, cz: number,
    prevX: number, prevY: number, prevZ: number,
    size: number, alpha: number, seed: number, age01: number, turbulence: number,
    view: mat4, proj: mat4,
  ): void {
    if (alpha <= 0.003 || size <= 0) return;
    this.smokeView = view;
    this.smokeProj = proj;
    const v = view as unknown as Float32Array;
    const sx = v[0], sy = v[4], sz = v[8];
    const ux = v[1], uy = v[5], uz = v[9];
    const s = size;
    const c: [number, number, number][] = [
      [cx + (-ux - sx) * s, cy + (-uy - sy) * s, cz + (-uz - sz) * s],
      [cx + (ux - sx) * s, cy + (uy - sy) * s, cz + (uz - sz) * s],
      [cx + (-ux + sx) * s, cy + (-uy + sy) * s, cz + (-uz + sz) * s],
      [cx + (ux + sx) * s, cy + (uy + sy) * s, cz + (uz + sz) * s],
    ];
    const uv: [number, number][] = [[0, 0], [0, 1], [1, 0], [1, 1]];
    const idx = [0, 1, 2, 1, 3, 2];
    for (const i of idx) {
      this.smokeVerts.push(
        c[i][0], c[i][1], c[i][2], prevX, prevY, prevZ,
        uv[i][0], uv[i][1], seed, age01, alpha, turbulence,
      );
    }
  }

  private smokeView: mat4 | null = null;
  private smokeProj: mat4 | null = null;

  flushSmoke(): void {
    if (!this.smokeVerts.length || !this.smokeView || !this.smokeProj) {
      this.smokeVerts.length = 0;
      return;
    }
    const gl = this.gl;
    gl.useProgram(this.smokeProg);
    const U = this.uSmoke;
    gl.uniformMatrix4fv(U.uView, false, this.smokeView as unknown as Float32Array);
    gl.uniformMatrix4fv(U.uProj, false, this.smokeProj as unknown as Float32Array);
    gl.uniformMatrix4fv(U.uViewProjPrev, false, this.prevViewProj as Float32Array);
    gl.uniform1f(U.uTime, this.time);
    gl.uniform1f(U.uNear, this.nearPlane);
    gl.uniform1f(U.uFar, this.farPlane);
    gl.uniform3f(U.uTint, this.smokeTint[0], this.smokeTint[1], this.smokeTint[2]);
    gl.uniform1f(U.uFreq, 0.09);
    gl.uniform1f(U.uSoftness, 1.4);
    gl.uniform1f(U.uDensity, this.smokeDensity);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.noiseTex);
    gl.uniform1i(U.uNoise, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    gl.uniform1i(U.uDepth, 2);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this.smokeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.smokeVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.smokeVerts), gl.DYNAMIC_DRAW);
    const cull = gl.isEnabled(gl.CULL_FACE);
    if (cull) gl.disable(gl.CULL_FACE);
    gl.drawArrays(gl.TRIANGLES, 0, this.smokeVerts.length / 12);
    if (cull) gl.enable(gl.CULL_FACE);
    gl.bindVertexArray(null);
    this.smokeVerts.length = 0;
  }

  /** Camera planes + smoke look; set by the renderer once per frame. */
  nearPlane = 0.1;
  farPlane = 192;
  smokeTint: [number, number, number] = [0.86, 0.88, 0.92];
  smokeDensity = 1.3;

  // --------------------------------------------------------- flare geometry
  /** Additive cone plume (engine flare) in the ship's own frame. */
  drawPlume(
    world: mat4, prevWorld: mat4, view: mat4, proj: mat4, camPos: vec3,
    color: [number, number, number], intensity: number,
  ): void {
    if (intensity <= 0.002) return;
    const gl = this.gl;
    this.flushBillboards();
    this.flushSmoke();
    gl.useProgram(this.plumeProg);
    const U = this.uPlume;
    gl.uniformMatrix4fv(U.uWorld, false, world as Float32Array);
    gl.uniformMatrix4fv(U.uPrevWorld, false, prevWorld as Float32Array);
    gl.uniformMatrix4fv(U.uView, false, view as Float32Array);
    gl.uniformMatrix4fv(U.uProj, false, proj as Float32Array);
    gl.uniformMatrix4fv(U.uViewProjPrev, false, this.prevViewProj as Float32Array);
    gl.uniform1f(U.uTime, this.time);
    gl.uniform3f(U.uCamPos, camPos[0], camPos[1], camPos[2]);
    gl.uniform3f(U.uColor, color[0], color[1], color[2]);
    gl.uniform1f(U.uIntensity, intensity);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.noiseTex);
    gl.uniform1i(U.uNoise, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this.plumeMesh.vao);
    gl.drawElements(gl.TRIANGLES, this.plumeMesh.count, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
  }

  /** Additive glow shell (bullets, addons, pickup flash) — real geometry. */
  drawGlow(
    world: mat4, prevWorld: mat4, view: mat4, proj: mat4, camPos: vec3,
    color: [number, number, number], intensity: number,
  ): void {
    if (intensity <= 0.002) return;
    const gl = this.gl;
    this.flushBillboards();
    this.flushSmoke();
    gl.useProgram(this.glowProg);
    const U = this.uGlow;
    gl.uniformMatrix4fv(U.uWorld, false, world as Float32Array);
    gl.uniformMatrix4fv(U.uPrevWorld, false, prevWorld as Float32Array);
    gl.uniformMatrix4fv(U.uView, false, view as Float32Array);
    gl.uniformMatrix4fv(U.uProj, false, proj as Float32Array);
    gl.uniformMatrix4fv(U.uViewProjPrev, false, this.prevViewProj as Float32Array);
    gl.uniform3f(U.uCamPos, camPos[0], camPos[1], camPos[2]);
    gl.uniform3f(U.uColor, color[0], color[1], color[2]);
    gl.uniform1f(U.uIntensity, intensity);
    gl.bindVertexArray(this.glowMesh.vao);
    gl.drawElements(gl.TRIANGLES, this.glowMesh.count, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
  }

  /** TextureSquare verbatim UVs: p1 Zero, p2 +Y, p3 One, p4 +X (× tiling). */
  createQuad(
    c0: [number, number, number], c1: [number, number, number],
    c2: [number, number, number], c3: [number, number, number],
    tiling: number,
  ): QuadMesh {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([...c0, ...c1, ...c2, ...c0, ...c2, ...c3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const nbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, nbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(18), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    const uvbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uvbo);
    const t = tiling;
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0, t, t, t, 0, 0, t, t, 0, t]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return { vao, count: 6 };
  }

  drawQuad(
    q: QuadMesh, tex: TexEntry | null,
    view: mat4, proj: mat4, color: [number, number, number], alpha: number,
  ): void {
    const gl = this.gl;
    this.flushBillboards();
    this.flushSmoke();
    gl.useProgram(this.unlit);
    const U = this.uUnlit;
    gl.uniformMatrix4fv(U.uView, false, view as Float32Array);
    gl.uniformMatrix4fv(U.uProj, false, proj as Float32Array);
    gl.uniformMatrix4fv(U.uWorld, false, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
    gl.uniformMatrix4fv(U.uPrevWorld, false, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
    gl.uniformMatrix4fv(U.uViewProjPrev, false, this.prevViewProj as Float32Array);
    const t = tex ?? getFallback(gl);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.uniform1i(U.uTex, 0);
    gl.uniform1i(U.uHasTex, tex ? 1 : 0);
    gl.uniform3f(U.uColor, color[0], color[1], color[2]);
    gl.uniform1f(U.uAlpha, alpha);
    gl.bindVertexArray(q.vao);
    // Draws.TextureSquare also switches to RasterizerState.CullNone.
    const cull = gl.isEnabled(gl.CULL_FACE);
    if (cull) gl.disable(gl.CULL_FACE);
    gl.drawArrays(gl.TRIANGLES, 0, q.count);
    if (cull) gl.enable(gl.CULL_FACE);
    gl.bindVertexArray(null);
  }
}
