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

import { mat4 } from './math';
import { FS_VERT, POST_BLUR_FRAG, POST_BRIGHT_FRAG, POST_COMPOSITE_FRAG, POST_MB_FRAG, POST_VELOCITY_DEBUG_FRAG, linkProgram, uniforms } from './shaders';
import type { TexEntry } from './texture';

interface Target {
  fbo: WebGLFramebuffer | null;
  tex: WebGLTexture | null;
  w: number;
  h: number;
}

export interface PresentOptions {
  motionBlur: boolean;
  /** 0 disables the lens flare; ~0.6 is the tuned default. */
  flare: number;
  flareTex: TexEntry | null;
  /** Exposure / rendered frame interval (1 = exactly one frame of motion). */
  shutter: number;
  /** Maximum blur length in UV units per frame. */
  maxBlur: number;
  /** Inverse of this frame's view-projection (depth -> world). */
  invViewProj: mat4;
  /** Previous frame's view-projection (world -> previous screen). */
  viewProjPrev: mat4;
  /** Integration samples along the exposure segment. */
  samples: number;
  /** Relative view-depth tolerance for accepting a tap. */
  depthTolerance: number;
  /** Camera near/far, used to linearize the depth copy. */
  near: number;
  far: number;
  /** Render the velocity buffer instead of the scene (debug view). */
  debugVelocity: boolean;
  /** Visual gain for the debug view. */
  debugScale: number;
}

export class Post {
  gl: WebGL2RenderingContext;
  w = 0;
  h = 0;
  /** Scene colour: the 3D objects only, alpha = coverage (the sky is separate). */
  colorTex: WebGLTexture | null = null;
  /** The sky sphere, drawn on its own so it is never blurred. */
  skyTex: WebGLTexture | null = null;
  skyFbo: WebGLFramebuffer | null = null;
  /** Screen-space velocity in UV/frame (RG16F when float targets are available). */
  velocityTex: WebGLTexture | null = null;
  /** Copy of the scene depth, sampled by the soft-particle smoke. */
  depthTex: WebGLTexture | null = null;
  sceneFbo: WebGLFramebuffer | null = null;
  private depthRb: WebGLTexture | null = null;
  private floatTargets = false;
  /** Per-object motion blur needs a signed velocity target (RG16F). */
  private mbSupported = false;
  private bright: Target = { fbo: null, tex: null, w: 0, h: 0 };
  private blurA: Target = { fbo: null, tex: null, w: 0, h: 0 };
  private blurB: Target = { fbo: null, tex: null, w: 0, h: 0 };
  private mbColor: Target = { fbo: null, tex: null, w: 0, h: 0 };
  private quadVao: WebGLVertexArrayObject | null = null;

  private progMb: WebGLProgram;
  private progBright: WebGLProgram;
  private progBlur: WebGLProgram;
  private progComposite: WebGLProgram;
  private progVelDebug: WebGLProgram;
  private uMb: Record<string, WebGLUniformLocation | null>;
  private uBright: Record<string, WebGLUniformLocation | null>;
  private uBlur: Record<string, WebGLUniformLocation | null>;
  private uComposite: Record<string, WebGLUniformLocation | null>;
  private uVelDebug: Record<string, WebGLUniformLocation | null>;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.floatTargets = !!gl.getExtension('EXT_color_buffer_float');
    this.progMb = linkProgram(gl, FS_VERT, POST_MB_FRAG);
    this.progBright = linkProgram(gl, FS_VERT, POST_BRIGHT_FRAG);
    this.progBlur = linkProgram(gl, FS_VERT, POST_BLUR_FRAG);
    this.progComposite = linkProgram(gl, FS_VERT, POST_COMPOSITE_FRAG);
    this.progVelDebug = linkProgram(gl, FS_VERT, POST_VELOCITY_DEBUG_FRAG);
    this.uMb = uniforms(gl, this.progMb, ['uColor', 'uVelocity', 'uDepth', 'uShutter', 'uMaxLen', 'uNear', 'uFar', 'uDepthTol', 'uSamples']);
    this.uBright = uniforms(gl, this.progBright, ['uColor', 'uThreshold']);
    this.uBlur = uniforms(gl, this.progBlur, ['uTex', 'uDir']);
    this.uComposite = uniforms(gl, this.progComposite, ['uSky', 'uSharp', 'uBlur', 'uBloom', 'uFlareTex', 'uBlurAmount', 'uFlare', 'uExposureKnee']);
    this.uVelDebug = uniforms(gl, this.progVelDebug, ['uVelocity', 'uScale']);
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
    disposeTarget(this.mbColor);
    if (this.sceneFbo) gl.deleteFramebuffer(this.sceneFbo);
    if (this.skyFbo) gl.deleteFramebuffer(this.skyFbo);
    if (this.skyTex) gl.deleteTexture(this.skyTex);
    if (this.colorTex) gl.deleteTexture(this.colorTex);
    if (this.velocityTex) gl.deleteTexture(this.velocityTex);
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
    // Velocity: signed RG16F when float targets are available. Without them a
    // RGBA8 target cannot represent negative velocities, so the blur stage is
    // skipped rather than sampling a clamped/garbage buffer.
    if (this.floatTargets) {
      this.velocityTex = this.makeColor(w, h, gl.RG16F, gl.RG, gl.HALF_FLOAT);
      this.mbSupported = true;
    } else {
      this.velocityTex = this.colorTarget(w, h);
      this.mbSupported = false;
    }
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
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.velocityTex, 0);
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
    mk(this.mbColor, w, h);
    mk(this.bright, halfW, halfH);
    mk(this.blurA, halfW, halfH);
    mk(this.blurB, halfW, halfH);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Bind the scene target and clear it (call at the start of a frame). */
  begin(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
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
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
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

  private blitPass(prog: WebGLProgram, target: Target | null, bind: () => void, w: number, h: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
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
    // Debug: show the velocity buffer itself (red = +x, green = +y, blue =
    // magnitude) instead of the scene. Nothing else in the chain runs.
    if (opts.debugVelocity) {
      this.blitPass(this.progVelDebug, null, () => {
        this.bindTex(this.uVelDebug.uVelocity, 0, this.velocityTex);
        gl.uniform1f(this.uVelDebug.uScale, opts.debugScale);
      }, gl.drawingBufferWidth, gl.drawingBufferHeight);
      return;
    }
    const sharp = this.colorTex;
    let blurred = sharp;
    let blurAmount = 0;
    // 1. per-object motion blur of the objects (the sky is never blurred)
    if (opts.motionBlur && this.mbSupported) {
      this.blitPass(this.progMb, this.mbColor, () => {
        this.bindTex(this.uMb.uColor, 0, this.colorTex);
        this.bindTex(this.uMb.uVelocity, 1, this.velocityTex);
        this.bindTex(this.uMb.uDepth, 2, this.depthTex);
        gl.uniform1f(this.uMb.uShutter, opts.shutter);
        gl.uniform1f(this.uMb.uMaxLen, opts.maxBlur);
        gl.uniform1f(this.uMb.uNear, opts.near);
        gl.uniform1f(this.uMb.uFar, opts.far);
        gl.uniform1f(this.uMb.uDepthTol, opts.depthTolerance);
        gl.uniform1i(this.uMb.uSamples, opts.samples);
      }, this.mbColor.w, this.mbColor.h);
      blurred = this.mbColor.tex;
      blurAmount = 1;
    }
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
    // 3. composite to the canvas: sky + blurred objects + sharp objects
    const bloom = flare > 0 ? this.blurB.tex : this.blurA.tex;
    this.blitPass(this.progComposite, null, () => {
      this.bindTex(this.uComposite.uSky, 0, this.skyTex);
      this.bindTex(this.uComposite.uSharp, 1, sharp);
      this.bindTex(this.uComposite.uBlur, 2, blurred);
      this.bindTex(this.uComposite.uBloom, 3, bloom);
      this.bindTex(this.uComposite.uFlareTex, 4, opts.flareTex ? opts.flareTex.tex : null);
      gl.uniform1f(this.uComposite.uBlurAmount, blurAmount);
      gl.uniform1f(this.uComposite.uFlare, flare);
      gl.uniform1f(this.uComposite.uExposureKnee, 0.55);
    }, gl.drawingBufferWidth, gl.drawingBufferHeight);
  }
}
