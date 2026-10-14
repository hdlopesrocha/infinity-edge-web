// Draw primitives with BasicEffect-exact state.

import { mat4, vec3 } from './math';
import {
  BB_FRAG, BB_VERT, BBQ_FRAG, BBQ_VERT, LIT_FRAG, LIT_VERT, UNLIT_FRAG, UNLIT_VERT,
  linkProgram, uniforms,
} from './shaders';
import { getFallback } from './texture';
import type { TexEntry } from './texture';
import type { GpuModel } from './model';

export interface LitOpts {
  alpha: number;
  emissive: [number, number, number];
  diffuse?: [number, number, number] | null;
  light: boolean;
}

export interface QuadMesh {
  vao: WebGLVertexArrayObject | null;
  count: number;
}

export class Draw {
  gl: WebGL2RenderingContext;
  lit: WebGLProgram;
  unlit: WebGLProgram;
  bb: WebGLProgram;
  uLit: Record<string, WebGLUniformLocation | null>;
  uUnlit: Record<string, WebGLUniformLocation | null>;
  uBb: Record<string, WebGLUniformLocation | null>;
  quadVao: WebGLVertexArrayObject | null = null;
  private invT = mat4.create();
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

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.lit = linkProgram(gl, LIT_VERT, LIT_FRAG);
    this.unlit = linkProgram(gl, UNLIT_VERT, UNLIT_FRAG);
    this.bb = linkProgram(gl, BB_VERT, BB_FRAG);
    this.uLit = uniforms(gl, this.lit, ['uWorld', 'uView', 'uProj', 'uWorldInvT', 'uTex', 'uHasTex', 'uDiffuse', 'uEmissive', 'uAmbient', 'uLightDir', 'uLightDiffuse', 'uLightSpec', 'uShininess', 'uCamPos', 'uAlpha']);
    this.uUnlit = uniforms(gl, this.unlit, ['uWorld', 'uView', 'uProj', 'uTex', 'uHasTex', 'uColor', 'uAlpha']);
    this.uBb = uniforms(gl, this.bb, ['uCenter', 'uSize', 'uRight', 'uUp', 'uView', 'uProj', 'uTex', 'uHasTex', 'uColor', 'uAlpha']);
    this.bbq = linkProgram(gl, BBQ_VERT, BBQ_FRAG);
    this.uBbq = uniforms(gl, this.bbq, ['uView', 'uProj', 'uTex']);
    {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, 0, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 36, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 36, 12);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 36, 20);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 36, 32);
      gl.bindVertexArray(null);
      this.bbqVao = vao;
      this.bbqVbo = vbo;
    }
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

  setOpaque(): void {
    const gl = this.gl;
    this.flushBillboards();
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
  }

  setTransparent(): void {
    const gl = this.gl;
    this.flushBillboards();
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
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
    gl.useProgram(this.lit);
    const U = this.uLit;
    gl.uniformMatrix4fv(U.uView, false, view as Float32Array);
    gl.uniformMatrix4fv(U.uProj, false, proj as Float32Array);
    gl.uniformMatrix4fv(U.uWorld, false, world as Float32Array);
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
  ): void {
    const gl = this.gl;
    this.flushBillboards();
    gl.useProgram(this.unlit);
    const U = this.uUnlit;
    gl.uniformMatrix4fv(U.uView, false, view as Float32Array);
    gl.uniformMatrix4fv(U.uProj, false, proj as Float32Array);
    gl.uniformMatrix4fv(U.uWorld, false, world as Float32Array);
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
      this.bbqVerts.push(c[i][0], c[i][1], c[i][2], uv[i][0], uv[i][1], color[0], color[1], color[2], alpha);
    }
  }

  private bbqView: mat4 | null = null;
  private bbqProj: mat4 | null = null;

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
    gl.drawArrays(gl.TRIANGLES, 0, this.bbqVerts.length / 9);
    if (cull) gl.enable(gl.CULL_FACE);
    gl.bindVertexArray(null);
    this.bbqVerts.length = 0;
    this.bbqTex = null;
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
    gl.useProgram(this.unlit);
    const U = this.uUnlit;
    gl.uniformMatrix4fv(U.uView, false, view as Float32Array);
    gl.uniformMatrix4fv(U.uProj, false, proj as Float32Array);
    gl.uniformMatrix4fv(U.uWorld, false, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
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
