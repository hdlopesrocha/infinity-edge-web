// Scene render targets + post-processing chain.
//
// The 3D scene is drawn into an offscreen target (color + per-object velocity +
// depth) instead of the default framebuffer:
//
//   scene -> [motion blur (velocity)] -> [lens flare from the bright pass] -> canvas
//
// The depth is copied out right before the transparent pass so soft-particle
// smoke can fade against the opaque geometry without a feedback loop, and the
// velocity attachment carries each object's screen-space motion (computed by
// the scene shaders from the previous frame's world/view-projection) so the
// blur is per object, not a screen-space fake.

import { FS_VERT, POST_BLUR_FRAG, POST_BRIGHT_FRAG, POST_COMPOSITE_FRAG, linkProgram, uniforms } from './shaders';
import type { TexEntry } from './texture';

interface Target {
  fbo: WebGLFramebuffer | null;
  tex: WebGLTexture | null;
  w: number;
  h: number;
}

export interface PresentOptions {
  /** 0 disables the lens flare; ~0.6 is the tuned default. */
  flare: number;
  flareTex: TexEntry | null;
  /** Target rectangle for the composite; null = the whole canvas. */
  viewport: { x: number; y: number; w: number; h: number } | null;
  /** Framebuffer the composite writes to; absent/null = the canvas. WebXR passes its base layer. */
  fbo?: WebGLFramebuffer | null;
  /** Zoom-blur radius at the screen edge, in UV (0 = off). */
  zoom: number;
  /** Screen point (UV) the ship is flying toward. */
  zoomCenterX: number;
  zoomCenterY: number;
}

/** Zoom-blur tunables. */
export const ZOOM_BLUR = {
  /** Radius at the screen edge, in UV, at full throttle. */
  maxRadiusUV: 0.12,
  /** Taps along the zoom ray. */
  samples: 10,
};

export class Post {
  gl: WebGL2RenderingContext;
  w = 0;
  h = 0;
  /** Scene colour: the 3D objects only, alpha = coverage (the sky is separate). */
  colorTex: WebGLTexture | null = null;
  /** The sky sphere, drawn on its own so it is never blurred. */
  skyTex: WebGLTexture | null = null;
  skyFbo: WebGLFramebuffer | null = null;
  /** Copy of the scene depth, sampled by the soft-particle smoke. */
  depthTex: WebGLTexture | null = null;
  sceneFbo: WebGLFramebuffer | null = null;
  private depthRb: WebGLTexture | null = null;
  private floatTargets = false;
  /** Per-object motion blur needs a signed velocity target (RG16F). */
  private bright: Target = { fbo: null, tex: null, w: 0, h: 0 };
  private blurA: Target = { fbo: null, tex: null, w: 0, h: 0 };
  private blurB: Target = { fbo: null, tex: null, w: 0, h: 0 };
  private quadVao: WebGLVertexArrayObject | null = null;

  private progBright: WebGLProgram;
  private progBlur: WebGLProgram;
  private progComposite: WebGLProgram;
  private uBright: Record<string, WebGLUniformLocation | null>;
  private uBlur: Record<string, WebGLUniformLocation | null>;
  private uComposite: Record<string, WebGLUniformLocation | null>;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.floatTargets = !!gl.getExtension('EXT_color_buffer_float');
    this.progBright = linkProgram(gl, FS_VERT, POST_BRIGHT_FRAG);
    this.progBlur = linkProgram(gl, FS_VERT, POST_BLUR_FRAG);
    this.progComposite = linkProgram(gl, FS_VERT, POST_COMPOSITE_FRAG);
    this.uBright = uniforms(gl, this.progBright, ['uColor', 'uThreshold']);
    this.uBlur = uniforms(gl, this.progBlur, ['uTex', 'uDir']);
    this.uComposite = uniforms(gl, this.progComposite, ['uSky', 'uSharp', 'uBloom', 'uFlareTex', 'uFlare', 'uExposureKnee', 'uZoomCenter', 'uZoom', 'uZoomSamples']);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.quadVao = vao;
  }

  private makeColor(w: number, h: number, internal: number, format: number, type: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private colorTarget(w: number, h: number): WebGLTexture {
    const gl = this.gl;
    return this.makeColor(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
  }

  resize(w: number, h: number): void {
    if (w === this.w && h === this.h && this.sceneFbo) return;
    const gl = this.gl;
    this.w = w;
    this.h = h;
    const disposeTarget = (t: Target) => {
      if (t.fbo) gl.deleteFramebuffer(t.fbo);
      if (t.tex) gl.deleteTexture(t.tex);
      t.fbo = null;
      t.tex = null;
    };
    disposeTarget(this.bright);
    disposeTarget(this.blurA);
    disposeTarget(this.blurB);
    if (this.sceneFbo) gl.deleteFramebuffer(this.sceneFbo);
    if (this.skyFbo) gl.deleteFramebuffer(this.skyFbo);
    if (this.skyTex) gl.deleteTexture(this.skyTex);
    if (this.colorTex) gl.deleteTexture(this.colorTex);
    if (this.depthTex) gl.deleteTexture(this.depthTex);
    if (this.depthRb) gl.deleteTexture(this.depthRb);
    // The depth-copy FBO references depthTex: keeping it would leave the blit
    // writing into a deleted attachment (broken soft particles + GL errors),
    // so drop it and let depthCopyFbo() rebuild it against the new texture.
    if (this.depthCopyFboCache) gl.deleteFramebuffer(this.depthCopyFboCache);
    this.depthCopyFboCache = null;

    this.colorTex = this.colorTarget(w, h);
    // Sky: the dome is drawn here, untouched by the blur stage. It covers the
    // whole view, so it is cleared once here rather than every frame.
    this.skyTex = this.colorTarget(w, h);
    this.skyFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.skyFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.skyTex, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // Depth: attached to the scene FBO (rendered into) ...
    this.depthRb = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.depthRb);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // ... and copied here each frame before the transparent pass.
    this.depthTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.sceneFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.colorTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depthRb, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Scene framebuffer incomplete: 0x' + status.toString(16));

    const halfW = Math.max(1, w >> 1);
    const halfH = Math.max(1, h >> 1);
    const mk = (t: Target, sw: number, sh: number) => {
      t.w = sw;
      t.h = sh;
      t.tex = this.colorTarget(sw, sh);
      t.fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    };
    mk(this.bright, halfW, halfH);
    mk(this.blurA, halfW, halfH);
    mk(this.blurB, halfW, halfH);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Bind the scene target and clear it (call at the start of a frame). */
  begin(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, this.w, this.h);
    // Colour starts fully transparent: the scene holds the objects and their
    // coverage, and the composite lays them over the sky and their own trail.
    gl.clearColor(0, 0, 0, 0);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  /** Bind the sky target (the dome is drawn here, never blurred). */
  beginSky(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.skyFbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, this.w, this.h);
  }

  /** Back to the scene target after the sky pass (keeps its contents). */
  bindScene(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, this.w, this.h);
  }

  /** Copy the opaque scene depth so soft particles can sample it. */
  blitDepth(): void {
    const gl = this.gl;
    // Resolve the destination FBO first: creating it binds FRAMEBUFFER
    // (read+draw), which would clobber the READ binding below on the very
    // first call and turn the blit into a feedback-loop error.
    const dst = this.depthCopyFbo();
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.sceneFbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst);
    gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, this.w, this.h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    // Restore the scene target as the draw framebuffer: the transparent pass
    // (flares, smoke, shells, walls) must keep rendering into it, otherwise the
    // composite that runs at the end of the frame overwrites it on the canvas.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.sceneFbo);
  }

  private depthCopyFboCache: WebGLFramebuffer | null = null;
  private depthCopyFbo(): WebGLFramebuffer {
    const gl = this.gl;
    if (!this.depthCopyFboCache) {
      this.depthCopyFboCache = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.depthCopyFboCache);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depthTex, 0);
    }
    return this.depthCopyFboCache;
  }

  private blitPass(prog: WebGLProgram, target: Target | null, bind: () => void, w: number, h: number, fbo: WebGLFramebuffer | null = null): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : fbo);
    // drawBuffers is invalid for the default framebuffer (BACK/NONE only).
    if (target) gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    gl.useProgram(prog);
    bind();
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  private bindTex(loc: WebGLUniformLocation | null, unit: number, tex: WebGLTexture | null): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  /** Run the post chain into the default framebuffer. */
  present(opts: PresentOptions): void {
    const gl = this.gl;
    const sharp = this.colorTex;
    // 2. lens flare: bright pass -> small blur chain (from the sharp objects)
    const flare = opts.flareTex ? opts.flare : 0;
    if (flare > 0) {
      this.blitPass(this.progBright, this.bright, () => {
        this.bindTex(this.uBright.uColor, 0, sharp);
        gl.uniform1f(this.uBright.uThreshold, 0.8);
      }, this.bright.w, this.bright.h);
      const dirs: [number, number][] = [[1, 0], [0, 1]];
      let src = this.bright;
      let dst = this.blurA;
      for (let i = 0; i < 2; i++) {
        this.blitPass(this.progBlur, dst, () => {
          this.bindTex(this.uBlur.uTex, 0, src.tex);
          gl.uniform2f(this.uBlur.uDir, dirs[i][0] / dst.w, dirs[i][1] / dst.h);
        }, dst.w, dst.h);
        src = dst;
        dst = dst === this.blurA ? this.blurB : this.blurA;
      }
      // second, wider pass over the result
      this.blitPass(this.progBlur, this.blurB, () => {
        this.bindTex(this.uBlur.uTex, 0, this.blurA.tex);
        gl.uniform2f(this.uBlur.uDir, 2.5 / this.blurB.w, 2.5 / this.blurB.h);
      }, this.blurB.w, this.blurB.h);
    }
    // 2. composite to the canvas: sky + objects
    const bloom = flare > 0 ? this.blurB.tex : this.blurA.tex;
    const vp = opts.viewport;
    this.blitPass(this.progComposite, null, () => {
      this.bindTex(this.uComposite.uSky, 0, this.skyTex);
      this.bindTex(this.uComposite.uSharp, 1, sharp);
      this.bindTex(this.uComposite.uBloom, 2, bloom);
      this.bindTex(this.uComposite.uFlareTex, 3, opts.flareTex ? opts.flareTex.tex : null);
      gl.uniform1f(this.uComposite.uFlare, flare);
      gl.uniform1f(this.uComposite.uExposureKnee, 0.55);
      gl.uniform2f(this.uComposite.uZoomCenter, opts.zoomCenterX, opts.zoomCenterY);
      gl.uniform1f(this.uComposite.uZoom, opts.zoom);
      gl.uniform1i(this.uComposite.uZoomSamples, ZOOM_BLUR.samples);
      if (vp) gl.viewport(vp.x, vp.y, vp.w, vp.h);
    }, vp ? vp.w : gl.drawingBufferWidth, vp ? vp.h : gl.drawingBufferHeight, opts.fbo ?? null);
  }
}
