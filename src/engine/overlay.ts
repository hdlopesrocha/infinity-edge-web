// Screen-space overlay painter: a 2D canvas uploaded as a texture and
// composited as a quad into the frame's UI target (stage 5), exactly like the
// in-GL HUD (hud3d.ts). The multiplayer lobby is drawn through this, so the
// whole view is the WebGL canvas: no DOM elements on screen.
//
// Painting goes through a callback with a logical size; the overlay is
// allocated at the canvas's device resolution (capped) so text stays crisp.

const MAX_W = 2560;
const MAX_H = 1600;

let uiVersionCounter = 0;

/**
 * Monotonic UI version. The overlay repaints only when it changes, and the
 * counter is global: a freshly mounted screen (a new MenuUi/LobbyUi instance)
 * must be strictly newer than whatever the overlay painted last, otherwise its
 * first paint would be skipped and the screen would stay blank.
 */
export function nextUiVersion(): number {
  return ++uiVersionCounter;
}

/** A full-screen UI layer painted into the frame (the multiplayer lobby). */
export interface ScreenUi {
  /** Bump whenever the content changes: only then is it repainted/uploaded. */
  version: number;
  /** Paint the UI; coordinates are device pixels of the overlay canvas. */
  paint(ctx: CanvasRenderingContext2D, w: number, h: number): void;
  /**
   * Optional input, used by the immersive VR panel's gaze crosshair. The
   * screen-space path handles pointer events itself, so this is only called
   * where the UI is shown inside the headset (coordinates are UI pixels).
   */
  pointer?(kind: 'move' | 'down' | 'up', x: number, y: number, cssW: number, cssH: number): boolean;
  /**
   * Optional rectangle (canvas pixels, top-left origin) that the focus veil
   * must keep sharp. The world outside it is blurred/tinted. Flat menus use
   * their content panels; the VR path projects its own world-space panel.
   */
  focusRect?(w: number, h: number): { x: number; y: number; w: number; h: number } | null;
}

const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }
`;
const FRAG = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 o;
void main(){
  vec4 c = texture(uTex, vUv);
  if (c.a <= 0.003) discard;
  o = c;
}
`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('overlay shader: ' + gl.getShaderInfoLog(sh));
  return sh;
}

export class ScreenOverlay {
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tex: WebGLTexture;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private uTex: WebGLUniformLocation | null;
  private lastVersion = -1;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1280;
    this.canvas.height = 720;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('overlay: no 2d context');
    this.ctx = ctx;
    const tex = gl.createTexture();
    if (!tex) throw new Error('overlay: texture failed');
    this.tex = tex;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1280, 720, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('overlay link: ' + gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.uTex = gl.getUniformLocation(prog, 'uTex');
    const vao = gl.createVertexArray()!;
    const vbo = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.vao = vao;
  }

  /** Logical size the painter works in (device px, capped). */
  layoutSize(canvasW: number, canvasH: number): { w: number; h: number } {
    const scale = Math.min(1, MAX_W / Math.max(1, canvasW), MAX_H / Math.max(1, canvasH));
    return { w: Math.max(320, Math.round(canvasW * scale)), h: Math.max(240, Math.round(canvasH * scale)) };
  }

  /**
   * Paint the UI into the overlay when its version changed (or the size did),
   * then composite it into the target rectangle. Unchanged frames cost one
   * quad draw and one texture bind - no 2D repaint, no texture upload.
   */
  drawUi(
    fbo: WebGLFramebuffer | null,
    rect: { x: number; y: number; w: number; h: number },
    ui: ScreenUi, canvasW: number, canvasH: number,
  ): void {
    const { w, h } = this.layoutSize(canvasW, canvasH);
    const resized = this.canvas.width !== w || this.canvas.height !== h;
    if (resized) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (resized || ui.version !== this.lastVersion) {
      this.lastVersion = ui.version;
      ui.paint(this.ctx, w, h);
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    this.draw(fbo, rect);
  }

  /** Composite into a target rectangle (device px). */
  draw(fbo: WebGLFramebuffer | null, rect: { x: number; y: number; w: number; h: number }): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(rect.x, rect.y, Math.max(1, rect.w), Math.max(1, rect.h));
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.uTex, 0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
  }
}
