// In-GL menu for immersive WebXR sessions, drawn as a PLANE in world space
// (not glued to the screen) so the player can look around and aim at it.
//
// The menu texture is painted onto an offscreen 2D canvas, uploaded as a
// texture, and composited as a textured quad facing the camera at a fixed
// distance in front of the ship. Gaze selection: the screen centre ray is
// intersected with the plane; the hovered item fires after a 2 s dwell.
import { mat4, vec3 } from '../engine/math';
import type { store } from '../game/store';

const W = 1024;
const H = 512;
const MENU_DISTANCE = 3;          // world units in front of the ship
const MENU_WIDTH = 16;            // world units
const MENU_HEIGHT = MENU_WIDTH * (H / W);

interface MenuItem { id: string; label: string; type: 'button' | 'checkbox' | 'slider'; value?: number; x: number; y: number; w: number; h: number }

export class VrMenu {
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tex: WebGLTexture;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private uTex: WebGLUniformLocation | null;
  private uWorld: WebGLUniformLocation | null;
  private uView: WebGLUniformLocation | null;
  private uProj: WebGLUniformLocation | null;
  private uAlpha: WebGLUniformLocation | null;
  private uColor: WebGLUniformLocation | null;
  private uHasTex: WebGLUniformLocation | null;
  private items: MenuItem[] = [];
  private hovered = -1;
  private dwellStart = 0;
  private dwellMs = 0;
  private onFire: (id: string) => void = () => undefined;

  // plane basis in world space (recomputed each frame)
  private planePos = vec3.create();
  private planeX = vec3.create();   // right axis (world)
  private planeY = vec3.create();   // up axis (world)
  private planeN = vec3.create();   // normal (toward camera)

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

    // unlit program (already linked by the engine; reuse its shader sources)
    const vs = `#version 300 es
      layout(location=0) in vec3 aPos; layout(location=2) in vec2 aUV;
      uniform mat4 uWorld; uniform mat4 uView; uniform mat4 uProj;
      out vec2 vUV;
      void main(){ vUV = aUV; gl_Position = uProj * uView * uWorld * vec4(aPos, 1.0); }`;
    const fs = `#version 300 es
      precision mediump float; in vec2 vUV; uniform sampler2D uTex; uniform float uAlpha;
      out vec4 o;
      void main(){ vec4 c = texture(uTex, vUV); if (c.a <= 0.003) discard; o = vec4(c.rgb, c.a * uAlpha); }`;
    const vsS = gl.createShader(gl.VERTEX_SHADER)!; gl.shaderSource(vsS, vs); gl.compileShader(vsS);
    const fsS = gl.createShader(gl.FRAGMENT_SHADER)!; gl.shaderSource(fsS, fs); gl.compileShader(fsS);
    const prog = gl.createProgram()!; gl.attachShader(prog, vsS); gl.attachShader(prog, fsS); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('menu link: ' + gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.uTex = gl.getUniformLocation(prog, 'uTex');
    this.uWorld = gl.getUniformLocation(prog, 'uWorld');
    this.uView = gl.getUniformLocation(prog, 'uView');
    this.uProj = gl.getUniformLocation(prog, 'uProj');
    this.uAlpha = gl.getUniformLocation(prog, 'uAlpha');
    this.uColor = gl.getUniformLocation(prog, 'uColor');
    this.uHasTex = gl.getUniformLocation(prog, 'uHasTex');

    // unit quad in local space, UV 0..1
    const vao = gl.createVertexArray()!;
    const vbo = gl.createBuffer()!;
    const uvbo = gl.createBuffer()!;
    const ibo = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, uvbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.vao = vao;
  }

  setOnFire(fn: (id: string) => void): void { this.onFire = fn; }

  setItems(labels: { id: string; label: string; type?: 'button' | 'checkbox' | 'slider'; value?: number }[]): void {
    // stack items vertically, centred
    const itemH = 64, gap = 16;
    const totalH = labels.length * itemH + (labels.length - 1) * gap;
    let y = (H - totalH) / 2;
    this.items = labels.map((l) => {
      const it = { id: l.id, label: l.label, type: l.type ?? 'button', value: l.value, x: W / 2 - 220, y, w: 440, h: itemH };
      y += itemH + gap;
      return it;
    });
  }

  /** Update the plane basis from the camera/ship and run gaze-dwell selection. */
  update(dt: number, camPos: vec3, camDir: vec3, shipPos: vec3, shipDir: vec3, gazeDir?: vec3): void {
    // plane sits in front of the ship, facing the camera
    const fwd = vec3.normalize(vec3.create(), shipDir);
    vec3.scaleAndAdd(this.planePos, shipPos, fwd, MENU_DISTANCE);
    const up = vec3.fromValues(0, 1, 0);
    vec3.cross(this.planeX, camDir, up);   // right (was up x camDir = left, causing horizontal mirror)
    const lx = vec3.length(this.planeX);
    if (lx < 1e-4) vec3.set(this.planeX, 1, 0, 0); else vec3.scale(this.planeX, this.planeX, 1 / lx);
    vec3.cross(this.planeY, camDir, this.planeX); // up
    const ly = vec3.length(this.planeY);
    if (ly < 1e-4) vec3.set(this.planeY, 0, 1, 0); else vec3.scale(this.planeY, this.planeY, 1 / ly);
    vec3.scale(this.planeN, camDir, -1);  // normal points TOWARD the camera

    // gaze: intersect the gaze ray with the plane
    const gd = gazeDir ? gazeDir : camDir;
    const toP = vec3.subtract(vec3.create(), this.planePos, camPos);
    const denom = vec3.dot(gd, this.planeN);
    let idx = -1;
    let hitPx = -1;
    let hitPy = -1;
    if (Math.abs(denom) > 1e-4) {
      const t = vec3.dot(toP, this.planeN) / denom;
      if (t > 0) {
        const hit = vec3.scaleAndAdd(vec3.create(), camPos, gd, t);
        const local = vec3.subtract(vec3.create(), hit, this.planePos);
        const u = vec3.dot(local, this.planeX) / MENU_WIDTH;
        const v = vec3.dot(local, this.planeY) / MENU_HEIGHT;
        if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
          hitPx = u * W;
          hitPy = v * H;
          for (let i = 0; i < this.items.length; i++) {
            const it = this.items[i];
            if (hitPx >= it.x && hitPx <= it.x + it.w && hitPy >= it.y && hitPy <= it.y + it.h) { idx = i; break; }
          }
        }
      }
    }
    
    // For sliders, update value based on gaze X position while hovering
    if (idx >= 0 && this.items[idx].type === 'slider' && hitPx >= 0) {
      const it = this.items[idx];
      const tx = it.x + 16, tw = it.w - 32;
      const val = Math.max(0, Math.min(1, (hitPx - tx) / tw));
      this.items[idx].value = val;
    }
    if (idx !== this.hovered) { this.hovered = idx; this.dwellStart = performance.now(); this.dwellMs = 0; }
    else if (idx >= 0) {
      this.dwellMs = performance.now() - this.dwellStart;
      if (this.dwellMs >= 3000) { this.onFire(this.items[idx].id); this.hovered = -1; this.dwellMs = 0; }
    }

    // paint
    const c = this.ctx;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(20, 20, 40, 0.85)';
    c.fillRect(0, 0, W, H);
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#fff'; c.font = '700 44px system-ui, sans-serif';
    c.shadowColor = 'rgba(0,0,0,0.9)'; c.shadowBlur = 8;
    c.fillText('PAUSED', W / 2, 70);
    c.font = '16px system-ui, sans-serif'; c.fillStyle = 'rgba(255,255,255,0.7)';
    c.fillText('Look at a button for 2 s to select', W / 2, 108);
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      const hovered = i === this.hovered;
      c.fillStyle = hovered ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.1)';
      c.fillRect(it.x, it.y, it.w, it.h);
      c.strokeStyle = hovered ? '#7fe8d8' : 'rgba(255,255,255,0.45)';
      c.lineWidth = 2; c.strokeRect(it.x, it.y, it.w, it.h);
      c.fillStyle = '#fff'; c.font = '700 28px system-ui, sans-serif'; c.shadowBlur = 6;
      if (it.type === 'checkbox') {
        // checkbox on the left
        const cbx = it.x + 16, cby = it.y + (it.h - 28) / 2;
        c.strokeStyle = hovered ? '#7fe8d8' : 'rgba(255,255,255,0.45)';
        c.lineWidth = 2; c.strokeRect(cbx, cby, 28, 28);
        if (it.value && it.value > 0) {
          c.fillStyle = '#7fe8d8';
          c.fillRect(cbx + 4, cby + 4, 20, 20);
        }
        c.fillStyle = '#fff'; c.textAlign = 'left';
        c.fillText(it.label, cbx + 40, it.y + it.h / 2);
        c.textAlign = 'center';
      } else if (it.type === 'slider') {
        c.fillStyle = '#fff'; c.font = '700 20px system-ui, sans-serif'; c.shadowBlur = 4;
        c.fillText(it.label, it.x + 16, it.y + it.h / 2 - 6);
        c.textAlign = 'left';
        // slider track
        const tx = it.x + 16, ty = it.y + it.h / 2 + 8, tw = it.w - 32, th = 6;
        c.fillStyle = 'rgba(255,255,255,0.15)';
        c.fillRect(tx, ty, tw, th);
        const val = Math.max(0, Math.min(1, it.value ?? 0.5));
        c.fillStyle = '#7fe8d8';
        c.fillRect(tx, ty, tw * val, th);
        // knob
        c.fillStyle = '#fff';
        c.beginPath(); c.arc(tx + tw * val, ty + th / 2, 8, 0, Math.PI * 2); c.fill();
        c.textAlign = 'center';
      } else {
        c.fillText(it.label, it.x + it.w / 2, it.y + it.h / 2);
      }
      if (hovered) {
        const prog = Math.min(1, this.dwellMs / 3000);
        c.strokeStyle = '#7fe8d8'; c.lineWidth = 3;
        c.beginPath(); c.arc(it.x + it.w / 2, it.y + it.h / 2, Math.min(it.w, it.h) / 2 - 6, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2);
        c.stroke();
      }
    }
    // crosshair at gaze hit point (or center if no hit)
    const cpx = hitPx >= 0 ? hitPx : W / 2;
    const cpy = hitPy >= 0 ? hitPy : H / 2;
    c.strokeStyle = 'rgba(255,255,255,0.9)';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(cpx - 12, cpy); c.lineTo(cpx - 4, cpy);
    c.moveTo(cpx + 4, cpy); c.lineTo(cpx + 12, cpy);
    c.moveTo(cpx, cpy - 12); c.lineTo(cpx, cpy - 4);
    c.moveTo(cpx, cpy + 4); c.lineTo(cpx, cpy + 12);
    c.stroke();
    c.beginPath();
    c.arc(cpx, cpy, 3, 0, Math.PI * 2);
    c.fillStyle = 'rgba(255,255,255,0.8)';
    c.fill();
    c.shadowBlur = 0;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** World-space plane: rendered last, over everything, no depth test. */
  draw(fbo: WebGLFramebuffer | null, view: Float32Array, proj: Float32Array, _camPos: vec3): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.prog);
    const world = new Float32Array(16);
    for (let i = 0; i < 3; i++) {
      world[i]      = this.planeX[i] * MENU_WIDTH;
      world[4 + i]  = this.planeY[i] * MENU_HEIGHT;
      world[8 + i]  = this.planeN[i];
      world[12 + i] = this.planePos[i];
    }
    world[15] = 1;
    if (this.uWorld) gl.uniformMatrix4fv(this.uWorld, false, world);
    if (this.uView) gl.uniformMatrix4fv(this.uView, false, view);
    if (this.uProj) gl.uniformMatrix4fv(this.uProj, false, proj);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (this.uTex) gl.uniform1i(this.uTex, 0);
    if (this.uAlpha) gl.uniform1f(this.uAlpha, 1.0);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }
}
