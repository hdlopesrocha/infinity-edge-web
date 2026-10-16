// In-GL HUD overlay for immersive WebXR sessions.
//
// Inside an immersive session the page DOM (score, clock, aim, life, markers,
// notifications) is hidden by the platform, so the HUD has to be drawn in
// WebGL: the snapshot in store.hud is painted onto an offscreen 2D canvas,
// uploaded as a texture, and composited as a screen-space quad into each eye's
// viewport after the post composite. Same data the DOM overlay renders, so the
// two can never disagree.
import type { store } from '../game/store';

type Hud = typeof store.hud;

const W = 1024;
const H = 1024;

function lifeColor(v: number, max: number): string {
  const p = max === 0 ? 0 : Math.max(0, v / max);
  const r = (((1 * (1 - p) + 0.2 * p) / 2) * 0.7 * 255) | 0;
  const gg = (((0.27 * (1 - p) + 0.8 * p) / 2) * 0.7 * 255) | 0;
  const b = (((0 * (1 - p) + 0.2 * p) / 2) * 0.7 * 255) | 0;
  return `rgb(${r},${gg},${b})`;
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
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('hud shader: ' + gl.getShaderInfoLog(sh));
  return sh;
}

export class HudOverlay {
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tex: WebGLTexture;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private uTex: WebGLUniformLocation | null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
    const tex = gl.createTexture();
    if (!tex) throw new Error('hud texture failed');
    this.tex = tex;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('hud link: ' + gl.getProgramInfoLog(prog));
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

  /** Paint the DOM HUD's contents (score/clock/notify/timer/aim/life/markers). */
  update(h: Hud): void {
    const c = this.ctx;
    c.clearRect(0, 0, W, H);
    const sx = W / Math.max(1, h.canvasW);
    const sy = H / Math.max(1, h.canvasH);
    const s = Math.min(sx, sy);
    c.textAlign = 'center';
    c.textBaseline = 'top';
    const shadow = (blur: number): void => {
      c.shadowColor = 'rgba(0,0,0,0.9)';
      c.shadowBlur = blur;
    };
    // Score, top centre.
    if (h.score) {
      c.fillStyle = '#fff';
      c.font = `700 ${Math.round(30 * s)}px system-ui, sans-serif`;
      shadow(6);
      c.fillText(h.score, W / 2, 8 * sy);
    }
    // Match clock m:ss under the score, amber in the last 30 s.
    if (h.matchLeft !== null) {
      const total = Math.max(0, Math.ceil(h.matchLeft / 1000));
      const clock = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
      c.fillStyle = h.matchLeft <= 30000 ? '#ffcc55' : '#fff';
      c.font = `${Math.round(22 * s)}px system-ui, sans-serif`;
      shadow(5);
      c.fillText(clock, W / 2, 44 * sy);
    }
    // Notification line.
    if (h.notify) {
      c.fillStyle = '#fff';
      c.font = `${Math.round(24 * s)}px system-ui, sans-serif`;
      shadow(6);
      c.fillText(h.notify, W / 2, 96 * sy);
    }
    // Respawn / leaving-field countdown, centred panel.
    const t = h.outside ?? h.respawn;
    if (t) {
      const secs = Math.max(0, Math.ceil(t.left / 1000));
      const label = h.outside ? 'Leaving the field of battle' : 'Waiting to respawn';
      const bw = 300 * s, bh = 110 * sy;
      const bx = W / 2 - bw / 2, by = H * 0.3;
      c.fillStyle = 'rgba(0,0,0,0.45)';
      c.fillRect(bx, by, bw, bh);
      c.strokeStyle = h.outside ? 'rgba(255,122,82,0.8)' : 'rgba(255,255,255,0.35)';
      c.lineWidth = 2;
      c.strokeRect(bx, by, bw, bh);
      c.fillStyle = '#fff';
      c.font = `${Math.round(18 * s)}px system-ui, sans-serif`;
      shadow(4);
      c.fillText(label, W / 2, by + 8 * sy);
      c.font = `700 ${Math.round(44 * s)}px system-ui, sans-serif`;
      c.fillText(`${secs}s`, W / 2, by + 32 * sy);
      const pct = t.total > 0 ? Math.max(0, Math.min(1, t.left / t.total)) : 0;
      c.fillStyle = 'rgba(255,255,255,0.18)';
      c.fillRect(bx + 12 * s, by + bh - 16 * sy, bw - 24 * s, 5);
      c.fillStyle = h.outside ? '#ff7a52' : '#7fe8d8';
      c.fillRect(bx + 12 * s, by + bh - 16 * sy, (bw - 24 * s) * pct, 5);
    }
    // Aim reticle where the DOM crosshair sits (ellipse in canvas space so it
    // is a true circle on screen whatever the viewport aspect is).
    {
      const ax = h.aimX * sx, ay = h.aimY * sy;
      const rx = 22 * sx, ry = 22 * sy;
      const r = Math.max(rx, ry);
      c.strokeStyle = 'rgba(255,255,255,0.9)';
      c.lineWidth = Math.max(2, 2.5 * s);
      shadow(4);
      c.beginPath();
      c.ellipse(ax, ay, rx, ry, 0, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.moveTo(ax - r - 8 * s, ay); c.lineTo(ax - r + 6 * s, ay);
      c.moveTo(ax + r - 6 * s, ay); c.lineTo(ax + r + 8 * s, ay);
      c.moveTo(ax, ay - r - 8 * s); c.lineTo(ax, ay - r + 6 * s);
      c.moveTo(ax, ay + r - 6 * s); c.lineTo(ax, ay + r + 8 * s);
      c.stroke();
    }
    // Target markers: diamond in the team colour + label (ship %).
    for (const m of h.pointers) {
      const mx = m.x * sx, my = m.y * sy;
      const rx = 16 * sx, ry = 16 * sy;
      const r = Math.max(rx, ry);
      const col = `rgb(${(m.color[0] * 255) | 0},${(m.color[1] * 255) | 0},${(m.color[2] * 255) | 0})`;
      c.strokeStyle = col;
      c.lineWidth = Math.max(2, 3 * s);
      shadow(5);
      c.beginPath();
      if (m.over) {
        c.ellipse(mx, my, rx, ry, 0, 0, Math.PI * 2);
      } else {
        c.moveTo(mx, my - r); c.lineTo(mx + r, my); c.lineTo(mx, my + r); c.lineTo(mx - r, my);
        c.closePath();
      }
      c.stroke();
      if (m.label) {
        c.fillStyle = '#fff';
        c.font = `${Math.round(17 * s)}px system-ui, sans-serif`;
        c.fillText(m.label, mx, my + r + 4 * sy);
      }
    }
    // Life bars, bottom centre.
    if (h.life.length > 0) {
      const segs = h.life.length === 1
        ? [{ x: W / 2 - 75 * s, w: 150 * s, seg: h.life[0] }]
        : h.life.map((seg, i) => ({ x: W / 2 - 117 * s + i * 80 * s, w: 72 * s, seg }));
      const y = H - 40 * sy, hh = 12 * sy;
      for (const { x, w, seg } of segs) {
        c.fillStyle = 'rgba(0,0,0,0.5)';
        c.fillRect(x - 4, y - 4, w + 8, hh + 8);
        const frac = seg.max > 0 ? Math.max(0, Math.min(1, seg.value / seg.max)) : 0;
        c.fillStyle = lifeColor(seg.value, seg.max);
        c.fillRect(x, y, w * frac, hh);
      }
    }
    // Missiles / nitro / throttle, bottom right.
    {
      c.textAlign = 'right';
      c.fillStyle = '#fff';
      c.font = `${Math.round(20 * s)}px system-ui, sans-serif`;
      shadow(5);
      const x = W - 20 * s;
      let y = H - 100 * sy;
      c.fillText(`HM ${h.homings}`, x, y);
      y += 28 * sy;
      c.fillStyle = h.nitroPct > 0 ? '#fff' : 'rgba(255,255,255,0.35)';
      c.fillText(`NITRO ${h.nitroPct}%`, x, y);
      c.textAlign = 'center';
    }
    c.shadowBlur = 0;
    // Upload (sub-image keeps the same texture object the session uses).
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Composite the overlay into the eye's framebuffer rectangle. */
  draw(fbo: WebGLFramebuffer | null, vp: { x: number; y: number; w: number; h: number }): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(vp.x, vp.y, vp.w, vp.h);
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
  }
}
