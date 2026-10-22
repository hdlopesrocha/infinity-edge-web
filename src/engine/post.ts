// Scene render targets + post-processing chain: six explicit stages.
//
//   1. sky:        the dome, never blurred
//   2. models:     all 3D meshes (opaque + transparent + glow/plume shells),
//                  with depth test, coverage in alpha
//   3. billboards: camera-facing sprites + smoke, depth-tested against the
//                  models' depth (the depth attachment is shared, never
//                  cleared or written here), additive premultiplied colour
//   4. blur:       the models buffer blurred (sky and billboards excluded)
//   5. UI:         HUD / score / life / missiles, drawn in GL over transparency
//   6. final:      1 + 4 + 2 + 3 + 5, in that order, plus the lens-flare ghosts
//
// The depth is copied out right before the transparent pass so soft-particle
// smoke can fade against the opaque geometry without a feedback loop.

import {
  FS_VERT, POST_BLUR_FRAG, POST_BRIGHT_FRAG, POST_COMPOSITE_FRAG, POST_FOCUS_SCENE_FRAG,
  linkProgram, uniforms,
} from './shaders';
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
  /** Normalized (0..1) UI sub-rect sampled for this view: the eye's own rect
   *  in stereo/XR so each eye gets its undistorted copy; full by default. */
  uiRect?: { x: number; y: number; w: number; h: number } | null;
  /** Framebuffer the composite writes to; absent/null = the canvas. WebXR passes its base layer. */
  fbo?: WebGLFramebuffer | null;
  /** Zoom-blur radius at the screen edge, in UV (0 = off). */
  zoom: number;
  /** Screen point (UV) the ship is flying toward. */
  zoomCenterX: number;
  zoomCenterY: number;
  /**
   * UI rectangle for this view in UV (bottom-left origin). The world outside
   * it is blurred and tinted toward `focusTint`, with zero blur on the edge.
   * null/omitted disables the veil.
   */
  focus?: { x: number; y: number; w: number; h: number } | null;
  /**
   * Optional projected panel silhouette, bl/br/tr/tl in this view's UV.
   * When present, the veil follows the quad instead of the axis-aligned
   * rectangle, so an obliquely viewed VR menu keeps an exact sharp island.
   */
  focusQuad?: readonly [
    number, number, number, number, number, number, number, number,
  ] | null;
  /** Player/team colour used by the focus veil (linear 0..1 RGB). */
  focusTint?: [number, number, number];
  /** UV height over which the veil ramps from the rectangle edge to full. */
  focusFeather?: number;
  /** 0..1; 0 disables the veil even when a rectangle is present. */
  focusStrength?: number;
  /** Player-colour boundary stroke width, in physical target pixels. */
  focusBorderPx?: number;
}

/** Zoom-blur tunables. */
export const ZOOM_BLUR = {
  /** Radius at the screen edge, in UV, at full throttle. */
  maxRadiusUV: 0.10,
  /** Taps along the zoom ray: enough to blend into a streak instead of
   *  showing a second, mirrored-looking copy of the ship. */
  samples: 16,
};

export class Post {
  gl: WebGL2RenderingContext;
  w = 0;
  h = 0;
  /** Stage 2 colour: all 3D meshes, alpha = coverage (sky is separate). */
  colorTex: WebGLTexture | null = null;
  /** Stage 3 colour: billboards + smoke (premultiplied, zero coverage). */
  bbTex: WebGLTexture | null = null;
  bbFbo: WebGLFramebuffer | null = null;
  /** Stage 5 colour: the GL HUD over transparency. */
  uiTex: WebGLTexture | null = null;
  uiFbo: WebGLFramebuffer | null = null;
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
  /** Lens-flare bloom (bright pass of the models), small and soft. */
  private flareA: Target = { fbo: null, tex: null, w: 0, h: 0 };
  private flareB: Target = { fbo: null, tex: null, w: 0, h: 0 };
  private blurB: Target = { fbo: null, tex: null, w: 0, h: 0 };
  /** Quarter-resolution world copy + ping-pong blur for the UI focus veil. */
  private focusA: Target = { fbo: null, tex: null, w: 0, h: 0 };
  private focusB: Target = { fbo: null, tex: null, w: 0, h: 0 };
  private quadVao: WebGLVertexArrayObject | null = null;

  private progBright: WebGLProgram;
  private progBlur: WebGLProgram;
  private progFocusScene: WebGLProgram;
  private progComposite: WebGLProgram;
  private uBright: Record<string, WebGLUniformLocation | null>;
  private uBlur: Record<string, WebGLUniformLocation | null>;
  private uFocusScene: Record<string, WebGLUniformLocation | null>;
  private uComposite: Record<string, WebGLUniformLocation | null>;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.floatTargets = !!gl.getExtension('EXT_color_buffer_float');
    this.progBright = linkProgram(gl, FS_VERT, POST_BRIGHT_FRAG);
    this.progBlur = linkProgram(gl, FS_VERT, POST_BLUR_FRAG);
    this.progFocusScene = linkProgram(gl, FS_VERT, POST_FOCUS_SCENE_FRAG);
    this.progComposite = linkProgram(gl, FS_VERT, POST_COMPOSITE_FRAG);
    this.uBright = uniforms(gl, this.progBright, ['uColor', 'uThreshold']);
    this.uBlur = uniforms(gl, this.progBlur, ['uTex', 'uDir']);
    this.uFocusScene = uniforms(gl, this.progFocusScene, ['uSky', 'uModels', 'uBloom', 'uBillboards']);
    this.uComposite = uniforms(gl, this.progComposite, [
      'uSky', 'uModels', 'uBloom', 'uFlareSrc', 'uBillboards', 'uUI', 'uUIRect',
      'uSceneBlur', 'uFocusRect', 'uFocusQuadOn',
      'uFocusQuad0', 'uFocusQuad1', 'uFocusQuad2', 'uFocusQuad3',
      'uFocusTint', 'uFocusAspect', 'uFocusFeather', 'uFocusStrength',
      'uFocusView', 'uFocusBorderPx',
      'uFlareTex', 'uFlare', 'uExposureKnee', 'uZoomCenter', 'uZoom', 'uZoomSamples',
    ]);
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
    disposeTarget(this.flareA);
    disposeTarget(this.flareB);
    disposeTarget(this.focusA);
    disposeTarget(this.focusB);
    if (this.sceneFbo) gl.deleteFramebuffer(this.sceneFbo);
    if (this.bbFbo) gl.deleteFramebuffer(this.bbFbo);
    if (this.uiFbo) gl.deleteFramebuffer(this.uiFbo);
    if (this.skyFbo) gl.deleteFramebuffer(this.skyFbo);
    if (this.skyTex) gl.deleteTexture(this.skyTex);
    if (this.colorTex) gl.deleteTexture(this.colorTex);
    if (this.bbTex) gl.deleteTexture(this.bbTex);
    if (this.uiTex) gl.deleteTexture(this.uiTex);
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
    let status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Scene framebuffer incomplete: 0x' + status.toString(16));

    // Stage 3 shares the models' depth attachment: billboards depth-test
    // against the meshes without clearing or rewriting their depth.
    this.bbTex = this.colorTarget(w, h);
    this.bbFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bbFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.bbTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depthRb, 0);
    status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Billboard framebuffer incomplete: 0x' + status.toString(16));
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Stage 5: plain colour target, no depth.
    this.uiTex = this.colorTarget(w, h);
    this.uiFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.uiFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.uiTex, 0);
    status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('UI framebuffer incomplete: 0x' + status.toString(16));
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

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
    mk(this.flareA, Math.max(1, w >> 2), Math.max(1, h >> 2));
    mk(this.flareB, Math.max(1, w >> 2), Math.max(1, h >> 2));
    // Quarter-res is intentional: the veil only shows a soft, low-frequency
    // world behind the UI, so the extra passes stay cheap even in stereo XR.
    mk(this.focusA, Math.max(1, w >> 2), Math.max(1, h >> 2));
    mk(this.focusB, Math.max(1, w >> 2), Math.max(1, h >> 2));
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

  /** Stage 3: bind the billboard target (colour cleared, models' depth kept). */
  beginBillboards(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bbFbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, this.w, this.h);
    gl.depthMask(false);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Stage 5: drop last frame's UI so a skipped HUD never leaves ghosts. */
  clearUI(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.uiFbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, this.w, this.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
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

  /** Run the post chain: blur the models, then composite 1+4+2+3+5. */
  present(opts: PresentOptions): void {
    const gl = this.gl;
    const models = this.colorTex;
    // 4. blur, from the models only (stage 2): the sky is never blurred and
    // the billboards stay sharp on top. Also feeds the lens-flare ghosts.
    const flare = opts.flareTex ? opts.flare : 0;
    // Lens-flare bloom: bright pass of the models, blurred small - kept apart
    // from the blur layer so the ghosts cannot duplicate the whole scene.
    if (flare > 0) {
      this.blitPass(this.progBright, this.flareA, () => {
        this.bindTex(this.uBright.uColor, 0, models);
        gl.uniform1f(this.uBright.uThreshold, 0.8);
      }, this.flareA.w, this.flareA.h);
      this.blitPass(this.progBlur, this.flareB, () => {
        this.bindTex(this.uBlur.uTex, 0, this.flareA.tex);
        gl.uniform2f(this.uBlur.uDir, 1.5 / this.flareB.w, 0);
      }, this.flareB.w, this.flareB.h);
      this.blitPass(this.progBlur, this.flareA, () => {
        this.bindTex(this.uBlur.uTex, 0, this.flareB.tex);
        gl.uniform2f(this.uBlur.uDir, 0, 1.5 / this.flareA.h);
      }, this.flareA.w, this.flareA.h);
    }
    {
      // Stage 4 always runs: the final pass layers it under the models.
      // Blur source: stage 2 copied down (dir 0 = pure copy).
      this.blitPass(this.progBlur, this.bright, () => {
        this.bindTex(this.uBlur.uTex, 0, models);
        gl.uniform2f(this.uBlur.uDir, 0, 0);
      }, this.bright.w, this.bright.h);
      const dirs: [number, number][] = [[1, 0], [0, 1]];
      let src = this.bright;
      let dst = this.blurA;
      for (let i = 0; i < 2; i++) {
        this.blitPass(this.progBlur, dst, () => {
          this.bindTex(this.uBlur.uTex, 0, src.tex);
          gl.uniform2f(this.uBlur.uDir, (dirs[i][0] * 2.4) / dst.w, (dirs[i][1] * 2.4) / dst.h);
        }, dst.w, dst.h);
        src = dst;
        dst = dst === this.blurA ? this.blurB : this.blurA;
      }
      // second, wider pass over the result
      this.blitPass(this.progBlur, this.blurB, () => {
        this.bindTex(this.uBlur.uTex, 0, this.blurA.tex);
        gl.uniform2f(this.uBlur.uDir, 6 / this.blurB.w, 6 / this.blurB.h);
      }, this.blurB.w, this.blurB.h);
    }
    const bloom = flare > 0 ? this.blurB.tex : this.blurA.tex;
    // A quarter-res world copy for the UI focus veil. It is blurred
    // horizontally then vertically so the veil has a soft, even falloff; the
    // full-resolution scene still supplies the sharp island inside the UI.
    const focus = opts.focus;
    const focusStrength = focus ? Math.max(0, Math.min(1, opts.focusStrength ?? 0.9)) : 0;
    if (focus && focusStrength > 0) {
      this.blitPass(this.progFocusScene, this.focusA, () => {
        this.bindTex(this.uFocusScene.uSky, 0, this.skyTex);
        this.bindTex(this.uFocusScene.uModels, 1, models);
        this.bindTex(this.uFocusScene.uBloom, 2, bloom);
        this.bindTex(this.uFocusScene.uBillboards, 3, this.bbTex);
      }, this.focusA.w, this.focusA.h);
      this.blitPass(this.progBlur, this.focusB, () => {
        this.bindTex(this.uBlur.uTex, 0, this.focusA.tex);
        gl.uniform2f(this.uBlur.uDir, 2.6 / this.focusB.w, 0);
      }, this.focusB.w, this.focusB.h);
      this.blitPass(this.progBlur, this.focusA, () => {
        this.bindTex(this.uBlur.uTex, 0, this.focusB.tex);
        gl.uniform2f(this.uBlur.uDir, 0, 2.6 / this.focusA.h);
      }, this.focusA.w, this.focusA.h);
    }
    // 6. final, in order: sky + blur + models + billboards + UI.
    const vp = opts.viewport;
    const viewW = vp ? vp.w : gl.drawingBufferWidth;
    const viewH = vp ? vp.h : gl.drawingBufferHeight;
    this.blitPass(this.progComposite, null, () => {
      this.bindTex(this.uComposite.uSky, 0, this.skyTex);
      this.bindTex(this.uComposite.uModels, 1, models);
      this.bindTex(this.uComposite.uBloom, 2, bloom);
      this.bindTex(this.uComposite.uFlareSrc, 6, flare > 0 ? this.flareA.tex : null);
      this.bindTex(this.uComposite.uBillboards, 3, this.bbTex);
      this.bindTex(this.uComposite.uUI, 4, this.uiTex);
      this.bindTex(this.uComposite.uSceneBlur, 7, this.focusA.tex);
      const ur = opts.uiRect ?? { x: 0, y: 0, w: 1, h: 1 };
      gl.uniform4f(this.uComposite.uUIRect, ur.x, ur.y, ur.w, ur.h);
      const fr = focus ?? { x: 0, y: 0, w: 1, h: 1 };
      gl.uniform4f(this.uComposite.uFocusRect, fr.x, fr.y, fr.w, fr.h);
      const fq = opts.focusQuad;
      gl.uniform1f(this.uComposite.uFocusQuadOn, fq ? 1 : 0);
      gl.uniform2f(this.uComposite.uFocusQuad0, fq?.[0] ?? 0, fq?.[1] ?? 0);
      gl.uniform2f(this.uComposite.uFocusQuad1, fq?.[2] ?? 0, fq?.[3] ?? 0);
      gl.uniform2f(this.uComposite.uFocusQuad2, fq?.[4] ?? 0, fq?.[5] ?? 0);
      gl.uniform2f(this.uComposite.uFocusQuad3, fq?.[6] ?? 0, fq?.[7] ?? 0);
      const tint = opts.focusTint ?? [0.25, 0.878, 0.816];
      gl.uniform3f(this.uComposite.uFocusTint, tint[0], tint[1], tint[2]);
      gl.uniform1f(this.uComposite.uFocusAspect, viewW / Math.max(1, viewH));
      gl.uniform1f(this.uComposite.uFocusFeather, Math.max(1e-4, opts.focusFeather ?? 0.16));
      gl.uniform1f(this.uComposite.uFocusStrength, focusStrength);
      gl.uniform2f(this.uComposite.uFocusView, viewW, viewH);
      gl.uniform1f(this.uComposite.uFocusBorderPx, Math.max(0, opts.focusBorderPx ?? 2));
      this.bindTex(this.uComposite.uFlareTex, 5, opts.flareTex ? opts.flareTex.tex : null);
      gl.uniform1f(this.uComposite.uFlare, flare);
      gl.uniform1f(this.uComposite.uExposureKnee, 0.55);
      gl.uniform2f(this.uComposite.uZoomCenter, opts.zoomCenterX, opts.zoomCenterY);
      gl.uniform1f(this.uComposite.uZoom, opts.zoom);
      gl.uniform1i(this.uComposite.uZoomSamples, ZOOM_BLUR.samples);
      if (vp) gl.viewport(vp.x, vp.y, vp.w, vp.h);
    }, viewW, viewH, opts.fbo ?? null);
  }
}
