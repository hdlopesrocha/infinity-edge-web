// In-GL menu for immersive WebXR sessions. While a match is paused the page
// DOM is hidden by the platform, so the pause menu (Resume / Leave / Exit VR)
// is painted here, one copy per eye, with a 1 s gaze-dwell to select an item.
import type { store } from '../game/store';

const W = 1024;
const H = 512;

interface MenuItem { id: string; label: string; x: number; y: number; w: number; h: number }

export class VrMenu {
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tex: WebGLTexture;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private uTex: WebGLUniformLocation | null;
  private items: MenuItem[] = [];
  private hovered = -1;
  private dwellStart = 0;
  private dwellMs = 0;
  private onFire: (id: string) => void = () => undefined;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W; this.canvas.height = H;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
    const tex = gl.createTexture();
    if (!tex) throw new Error('menu texture failed');
    this.tex = tex;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const vs = `#version 300 es
      layout(location=0) in vec2 aPos; out vec2 vUv;
      void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;
    const fs = `#version 300 es
      precision mediump float; in vec2 vUv; uniform sampler2D uTex; out vec4 o;
      void main(){ vec4 c = texture(uTex, vUv); if (c.a <= 0.003) discard; o = c; }`;
    const vsS = gl.createShader(gl.VERTEX_SHADER)!; gl.shaderSource(vsS, vs); gl.compileShader(vsS);
    const fsS = gl.createShader(gl.FRAGMENT_SHADER)!; gl.shaderSource(fsS, fs); gl.compileShader(fsS);
    const prog = gl.createProgram()!; gl.attachShader(prog, vsS); gl.attachShader(prog, fsS); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('menu link: ' + gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.uTex = gl.getUniformLocation(prog, 'uTex');
    const vao = gl.createVertexArray()!; const vbo = gl.createBuffer()!;
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null); gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.vao = vao;
  }

  setOnFire(fn: (id: string) => void): void { this.onFire = fn; }

  setItems(labels: { id: string; label: string }[]): void {
    this.items = labels.map((l, i) => ({ ...l, x: W / 2 - 220, y: 150 + i * 80, w: 440, h: 64 }));
  }

  /** Head yaw/pitch (degrees) of the player; dwell on the item under the
   *  crosshair (screen centre) for 1 s to select it. */
  update(dt: number): void {
    // The crosshair is at (W/2, H/2); the menu is drawn full-screen, so an
    // item is "hovered" when its rect contains the centre.
    let idx = -1;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (W / 2 >= it.x && W / 2 <= it.x + it.w && H / 2 >= it.y && H / 2 <= it.y + it.h) { idx = i; break; }
    }
    if (idx !== this.hovered) { this.hovered = idx; this.dwellStart = performance.now(); this.dwellMs = 0; }
    else if (idx >= 0) {
      this.dwellMs = performance.now() - this.dwellStart;
      if (this.dwellMs >= 1000) { this.onFire(this.items[idx].id); this.hovered = -1; this.dwellMs = 0; }
    }
    // Paint
    const c = this.ctx;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.fillRect(0, 0, W, H);
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#fff'; c.font = '700 48px system-ui, sans-serif';
    c.shadowColor = 'rgba(0,0,0,0.9)'; c.shadowBlur = 8;
    c.fillText('PAUSED', W / 2, 80);
    c.font = '16px system-ui, sans-serif'; c.fillStyle = 'rgba(255,255,255,0.7)';
    c.fillText('Gaze at a button for 1 s to select', W / 2, 120);
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      const hovered = i === this.hovered;
      c.fillStyle = hovered ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.08)';
      c.fillRect(it.x, it.y, it.w, it.h);
      c.strokeStyle = hovered ? '#7fe8d8' : 'rgba(255,255,255,0.4)';
      c.lineWidth = 2; c.strokeRect(it.x, it.y, it.w, it.h);
      c.fillStyle = '#fff'; c.font = '700 30px system-ui, sans-serif'; c.shadowBlur = 6;
      c.fillText(it.label, it.x + it.w / 2, it.y + it.h / 2);
      if (hovered) {
        const prog = Math.min(1, this.dwellMs / 1000);
        c.strokeStyle = '#7fe8d8'; c.lineWidth = 3;
        c.beginPath(); c.arc(it.x + it.w / 2, it.y + it.h / 2, Math.min(it.w, it.h) / 2 - 4, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2);
        c.stroke();
      }
    }
    c.shadowBlur = 0;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  draw(fbo: WebGLFramebuffer | null, vp: { x: number; y: number; w: number; h: number }): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(vp.x, vp.y, vp.w, vp.h);
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.uTex, 0);
    gl.bindVertexArray(this.vao); gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null); gl.bindTexture(gl.TEXTURE_2D, null);
    gl.disable(gl.BLEND);
  }
}
