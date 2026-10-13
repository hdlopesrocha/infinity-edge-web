// Draw primitives with BasicEffect-exact state.

import { mat4, vec3 } from './math';
import {
  BB_FRAG, BB_VERT, LIT_FRAG, LIT_VERT, UNLIT_FRAG, UNLIT_VERT,
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
  lightDir = vec3.fromValues(-0.4, 0.8, 0.45);

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.lit = linkProgram(gl, LIT_VERT, LIT_FRAG);
    this.unlit = linkProgram(gl, UNLIT_VERT, UNLIT_FRAG);
    this.bb = linkProgram(gl, BB_VERT, BB_FRAG);
    this.uLit = uniforms(gl, this.lit, ['uWorld', 'uView', 'uProj', 'uWorldInvT', 'uTex', 'uHasTex', 'uDiffuse', 'uEmissive', 'uAmbient', 'uLightDir', 'uLightDiffuse', 'uLightSpec', 'uShininess', 'uCamPos', 'uAlpha']);
    this.uUnlit = uniforms(gl, this.unlit, ['uWorld', 'uView', 'uProj', 'uTex', 'uHasTex', 'uColor', 'uAlpha']);
    this.uBb = uniforms(gl, this.bb, ['uCenter', 'uSize', 'uRight', 'uUp', 'uView', 'uProj', 'uTex', 'uHasTex', 'uColor', 'uAlpha']);
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
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
  }

  setTransparent(): void {
    const gl = this.gl;
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  setNoDepth(): void {
    const gl = this.gl;
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
      gl.uniform3f(U.uLightDiffuse, 1, 1, 1);
      gl.uniform3f(U.uLightSpec, 0.68, 0.85, 1);
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
      const d = opts.diffuse ?? mat?.diffuse ?? [1, 1, 1];
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
    const gl = this.gl;
    gl.useProgram(this.bb);
    const U = this.uBb;
    const v = view as unknown as Float32Array;
    gl.uniform3f(U.uCenter, cx, cy, cz);
    gl.uniform1f(U.uSize, size);
    gl.uniform3f(U.uRight, v[0], v[4], v[8]);
    gl.uniform3f(U.uUp, v[1], v[5], v[9]);
    gl.uniformMatrix4fv(U.uView, false, view as Float32Array);
    gl.uniformMatrix4fv(U.uProj, false, proj as Float32Array);
    const t = tex ?? getFallback(gl);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.uniform1i(U.uTex, 0);
    gl.uniform1i(U.uHasTex, tex ? 1 : 0);
    gl.uniform3f(U.uColor, color[0], color[1], color[2]);
    gl.uniform1f(U.uAlpha, alpha);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
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
    gl.drawArrays(gl.TRIANGLES, 0, q.count);
    gl.bindVertexArray(null);
  }
}
