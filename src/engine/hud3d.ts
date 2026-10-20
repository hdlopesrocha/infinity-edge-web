// In-GL HUD overlay for immersive WebXR sessions.
//
// Inside an immersive session the page DOM (score, clock, aim, life, markers,
// notifications) is hidden by the platform, so the HUD has to be drawn in
// WebGL: the snapshot in store.hud is painted onto an offscreen 2D canvas,
// uploaded as a texture, and composited as a screen-space quad into each eye's
// viewport after the post composite. Same data the DOM overlay renders, so the
// two can never disagree.
import { store } from '../game/store';
import { WorldQuad } from './vrpanel';
import type { vec3 } from './math';

type Hud = typeof store.hud;

/** Screen/CSS pixels of padding around the painted HUD. The focus veil uses
 *  the same inset so the border it blurs is exactly the non-UI margin. */
export const HUD_PADDING = 64;

/** Largest HUD texture edge (the texture itself takes the view's aspect). */
const MAX_HUD = 1600;

// Same base the DOM HUD uses for its icons (GameView `base`).
const TEX_BASE = (import.meta.env.BASE_URL + 'assets/textures/').replace(/([^:])\/\//g, '$1/');
const AIM_URL = TEX_BASE + '_aim.png';
const OVER_URL = TEX_BASE + '_over.png';
const ACCEL_URL = TEX_BASE + '_accelAnalog.png';
const FIRE_URL = TEX_BASE + '_fireButton.png';
const FIRE_HM_URL = TEX_BASE + '_fireButtonHM.png';
const NITRO_URL = TEX_BASE + '_nitro.png';
const STICK_BACK_URL = TEX_BASE + '_backAnalog.png';
const STICK_KNOB_URL = TEX_BASE + '_stickAnalog.png';

/** Async icon cache: 2D-canvas drawImage of the real game art. Until an icon
 *  has loaded the overlay falls back to the procedural shapes, so a slow
 *  texture can never blank the HUD. */
/** Tinted copies of an icon (cached), for team colours and the lock
 *  crosshair. */
const tintCache = new Map<string, HTMLCanvasElement>();
function tinted(img: HTMLImageElement, css: string): HTMLCanvasElement {
  const key = img.src + '|' + css;
  const hit = tintCache.get(key);
  if (hit) return hit;
  if (tintCache.size > 48) {
    const first = tintCache.keys().next();
    if (!first.done) tintCache.delete(first.value);
  }
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  const g = cv.getContext('2d')!;
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = css;
  g.fillRect(0, 0, cv.width, cv.height);
  tintCache.set(key, cv);
  return cv;
}

const iconCache = new Map<string, HTMLImageElement>();
const iconPending = new Set<string>();
function icon(url: string | null): HTMLImageElement | null {
  if (!url) return null;
  let img = iconCache.get(url);
  if (img) return img.complete && img.naturalWidth > 0 ? img : null;
  if (iconPending.has(url)) return null;
  iconPending.add(url);
  if (iconCache.size > 64) {
    const first = iconCache.keys().next();
    if (!first.done) iconCache.delete(first.value);
  }
  img = new Image();
  img.decoding = 'async';
  (img as HTMLImageElement).crossOrigin = 'anonymous';
  img.onload = () => iconPending.delete(url);
  img.onerror = () => iconPending.delete(url);
  img.src = url;
  iconCache.set(url, img);
  return null;
}

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
  /** World-space panel (immersive VR): the same painted texture on a plane. */
  private quad: WorldQuad | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1280;
    this.canvas.height = 720;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
    const tex = gl.createTexture();
    if (!tex) throw new Error('hud texture failed');
    this.tex = tex;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1280, 720, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
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
    // Warm the item art so the buttons are there from the first frame.
    for (const u of [AIM_URL, OVER_URL, ACCEL_URL, FIRE_URL, FIRE_HM_URL, NITRO_URL, STICK_BACK_URL, STICK_KNOB_URL]) icon(u);
  }

  /**
   * The texture takes the destination's aspect ratio (capped), so the HUD is
   * never stretched when it is composited into the canvas or an eye viewport:
   * text stays readable and round buttons stay round. Everything below maps
   * the game's canvas pixels into this texture with sx/sy.
   */
  private ensureSize(w: number, h: number): void {
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Paint the DOM HUD's contents (score/clock/notify/timer/aim/life/markers). */
  update(h: Hud): void {
    const scale = Math.min(1, MAX_HUD / Math.max(1, h.canvasW, h.canvasH));
    const texW = Math.max(2, Math.round(h.canvasW * scale));
    const texH = Math.max(2, Math.round(h.canvasH * scale));
    this.ensureSize(texW, texH);
    const W = texW;
    const H = texH;
    const c = this.ctx;
    c.clearRect(0, 0, W, H);
    const sx = W / Math.max(1, h.canvasW);
    const sy = H / Math.max(1, h.canvasH);
    const s = Math.min(sx, sy);
    // No UI hugs the border, only the 3D game does.
    const padX = HUD_PADDING * sx;
    const padY = HUD_PADDING * sy;
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
      c.fillText(h.score, W / 2, padY + 28 * sy);
    }
    // Match clock m:ss under the score, amber in the last 30 s.
    if (h.matchLeft !== null) {
      const total = Math.max(0, Math.ceil(h.matchLeft / 1000));
      const clock = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
      c.fillStyle = h.matchLeft <= 30000 ? '#ffcc55' : '#fff';
      c.font = `${Math.round(22 * s)}px system-ui, sans-serif`;
      shadow(5);
      c.fillText(clock, W / 2, padY + 52 * sy);
    }
    // Notification line.
    if (h.notify) {
      c.fillStyle = '#fff';
      c.font = `${Math.round(24 * s)}px system-ui, sans-serif`;
      shadow(6);
      c.fillText(h.notify, W / 2, padY + 88 * sy);
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
      if (h.respawn && h.deathCause) {
        c.font = `${Math.round(16 * s)}px system-ui, sans-serif`;
        c.fillStyle = 'rgba(255,255,255,0.85)';
        c.fillText(h.deathCause, W / 2, by + 78 * sy);
      }
      const pct = t.total > 0 ? Math.max(0, Math.min(1, t.left / t.total)) : 0;
      c.fillStyle = 'rgba(255,255,255,0.18)';
      c.fillRect(bx + 12 * s, by + bh - 16 * sy, bw - 24 * s, 5);
      c.fillStyle = h.outside ? '#ff7a52' : '#7fe8d8';
      c.fillRect(bx + 12 * s, by + bh - 16 * sy, (bw - 24 * s) * pct, 5);
    }
    // Aim: the real _aim.png crosshair (32x32), exactly like the DOM HUD.
    // Falls back to the drawn reticle until the icon loads.
    {
      // World-projected aim: inside the panel it is exactly where the base view
      // projects it; past an edge it sticks to that edge of the panel (the VR
      // HUD is a plane now, not the eye's screen).
      const rx = 22 * sx, ry = 22 * sy;
      const r = Math.max(rx, ry);
      const aimW = 32 * sx, aimH = 32 * sy;
      const aimMargin = 32 * Math.max(sx, sy) + 2;
      const ax = Math.max(aimMargin, Math.min(W - aimMargin, h.aimX * sx));
      const ay = Math.max(aimMargin, Math.min(H - aimMargin, h.aimY * sy));
      const aimImg = icon(AIM_URL);
      shadow(4);
      if (aimImg) {
        c.drawImage(aimImg, ax - aimW / 2, ay - aimH / 2, aimW, aimH);
      }
      // Extra red crosshair while an enemy is under it (missile lock ready).
      if (h.lockOn && aimImg) {
        const iw = 32 * sx * 1.35, ih = 32 * sy * 1.35;
        shadow(8);
        c.drawImage(tinted(aimImg, '#ff4d3d'), ax - iw / 2, ay - ih / 2, iw, ih);
      }
      if (aimImg) {
      } else {
        c.strokeStyle = 'rgba(255,255,255,0.9)';
        c.lineWidth = Math.max(2, 2.5 * s);
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
    }
    // Target markers: the same icons as the DOM HUD - _over.png (48x48) for
    // locked targets, the object's own icon otherwise - plus the label.
    // Procedural shapes cover icons that have not loaded yet.
    for (const m of h.pointers) {
      const rx = 64 * sx, ry = 64 * sy;
      const r = Math.max(rx, ry);
      const col = `rgb(${(m.color[0] * 255) | 0},${(m.color[1] * 255) | 0},${(m.color[2] * 255) | 0})`;
      const iwCss = m.over ? 48 : m.w;
      const ihCss = m.over ? 48 : m.h;
      const iw = iwCss * sx, ih = ihCss * sy;
      const marginX = Math.max(iw / 2, r) + 2;
      const marginY = Math.max(ih / 2, r) + 2;
      // Exact inside the panel, pinned to the nearest edge outside it.
      const mx = Math.max(marginX, Math.min(W - marginX, m.x * sx));
      const my = Math.max(marginY, Math.min(H - marginY, m.y * sy));
      const sprite = icon(m.over ? OVER_URL : m.iconUrl);
      // Team-coloured glow, like the DOM drop-shadow on the marker.
      c.shadowColor = col;
      c.shadowBlur = 5;
      if (sprite) {
        // Friend and enemy alike: the icon itself in the team colour.
        c.drawImage(tinted(sprite, col), mx - iw / 2, my - ih / 2, iw, ih);
      } else {
        c.strokeStyle = col;
        c.lineWidth = Math.max(2, 3 * s);
        c.shadowColor = 'rgba(0,0,0,0.9)';
        c.beginPath();
        if (m.over) {
          c.ellipse(mx, my, rx, ry, 0, 0, Math.PI * 2);
        } else {
          c.moveTo(mx, my - r); c.lineTo(mx + r, my); c.lineTo(mx, my + r); c.lineTo(mx - r, my);
          c.closePath();
        }
        c.stroke();
      }
      if (m.label) {
        c.fillStyle = '#fff';
        c.shadowColor = 'rgba(0,0,0,0.9)';
        c.shadowBlur = 4;
        c.font = `${Math.round(17 * s)}px system-ui, sans-serif`;
        c.fillText(m.label, mx, my + Math.max(ihCss * sy / 2, r) + 4 * sy);
      }
    }
    // Pre-match countdown: big and centred, so the goggles can be put on.
    if (h.countdown > 0) {
      c.font = `700 ${Math.round(120 * s)}px system-ui, sans-serif`;
      c.fillStyle = '#ffffff';
      shadow(14);
      c.fillText(String(h.countdown), W / 2, H * 0.36);
      c.font = `700 ${Math.round(30 * s)}px system-ui, sans-serif`;
      c.fillStyle = '#7fe8d8';
      c.fillText('READY IN', W / 2, H * 0.36 - 52 * sy);
    }
    // Missile-lock warning: blink a red banner under the top block.
    if (h.missileWarn) {
      const blink = (typeof performance !== 'undefined' ? performance.now() : 0) % 700 < 450;
      if (blink) {
        c.font = `700 ${Math.round(30 * s)}px system-ui, sans-serif`;
        c.fillStyle = '#ff4d3d';
        shadow(10);
        c.fillText('MISSILE LOCK', W / 2, padY + 104 * sy);
      }
    }
    // Speed, left of the life bars on the same line (world units per second).
    {
      c.textAlign = 'right';
      c.textBaseline = 'middle';
      c.font = `700 ${Math.round(24 * s)}px system-ui, sans-serif`;
      c.fillStyle = 'rgba(255,255,255,0.92)';
      shadow(4);
      c.fillText(`SPD ${Math.round(h.speed)}`, W / 2 - 150 * s, padY + 8 * sy);
      c.textAlign = 'center';
      c.textBaseline = 'top';
    }
    // Life bars, top centre (under the match clock).
    if (h.life.length > 0) {
      const segs = h.life.length === 1
        ? [{ x: W / 2 - 75 * s, w: 150 * s, seg: h.life[0] }]
        : h.life.map((seg, i) => ({ x: W / 2 - 117 * s + i * 80 * s, w: 72 * s, seg }));
      const y = padY + 8 * sy, hh = 12 * sy;
      for (const { x, w, seg } of segs) {
        c.fillStyle = 'rgba(0,0,0,0.5)';
        c.fillRect(x - 4, y - 4, w + 8, hh + 8);
        const frac = seg.max > 0 ? Math.max(0, Math.min(1, seg.value / seg.max)) : 0;
        c.fillStyle = lifeColor(seg.value, seg.max);
        c.fillRect(x, y, w * frac, hh);
      }
    }
    // Touch controls: outside VR only. In VR the buttons are gone and the
    // ammo they carried sits next to the life bars instead (below).
    if (!store.vr) {
      const bw = 96 * s;
      const bx = (h.canvasW - 96 - 128) * sx;
      const items: { url: string; count: string; dim: boolean }[] = [
        { url: FIRE_URL, count: '', dim: false },
        { url: FIRE_HM_URL, count: String(h.homings), dim: h.homings === 0 },
        { url: NITRO_URL, count: String(h.nitroPct), dim: h.nitroPct <= 0 },
      ];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const y = (h.canvasH - (96 + 32) * (i + 1)) * sy;
        c.globalAlpha = it.dim ? 0.2 : 1;
        const disc = icon(ACCEL_URL);
        if (disc) c.drawImage(disc, bx, y, bw, bw);
        const glyph = icon(it.url);
        if (glyph) c.drawImage(glyph, bx, y, bw, bw);
        if (it.count) {
          c.fillStyle = '#fff';
          c.font = `${Math.round(18 * s)}px system-ui, sans-serif`;
          shadow(4);
          c.fillText(it.count, bx + bw / 2, y + bw * 0.34);
        }
        c.globalAlpha = 1;
      }
      // Accelerator bar + knob (top right of the item stack).
      c.fillStyle = 'rgba(255,255,255,0.2)';
      c.fillRect((h.canvasW - 96 + 40) * sx, (h.canvasH - 400 + 48) * sy, 16 * s, (400 - 96) * s);
      const knob = icon(ACCEL_URL);
      if (knob) {
        const ky = (h.canvasH - 400 + 48 + (400 - 96) * (1 - h.acel) - 48) * sy;
        c.drawImage(knob, (h.canvasW - 96) * sx, ky, 96 * s, 96 * s);
      }
      // Flight stick, when the level enables it.
      if (h.stickOn) {
        const back = icon(STICK_BACK_URL);
        if (back) c.drawImage(back, h.backX * sx, h.backY * sy, 256 * s, 256 * s);
        const sk = icon(STICK_KNOB_URL);
        if (sk) c.drawImage(sk, h.knobX * sx, h.knobY * sy, 96 * s, 96 * s);
      }
    } else {
      // VR: no touch controls - homing missiles and nitro as small icons with
      // their counts, right beside the ship's life bars.
      const iw = 40 * s;
      const y = 74 * sy + padY + 6 * sy - 20 * s;
      const x0 = W / 2 + 150 * s;
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      const hm = icon(FIRE_HM_URL);
      if (hm) c.drawImage(hm, x0, y, iw, iw);
      c.font = `700 ${Math.round(22 * s)}px system-ui, sans-serif`;
      c.fillStyle = h.homings > 0 ? '#fff' : 'rgba(255,255,255,0.35)';
      shadow(4);
      c.fillText(String(h.homings), x0 + iw + 8 * s, y + iw / 2);
      const x1 = x0 + iw + 56 * s;
      const ni = icon(NITRO_URL);
      if (ni) c.drawImage(ni, x1, y, iw, iw);
      c.fillStyle = h.nitroPct > 0 ? '#fff' : 'rgba(255,255,255,0.35)';
      c.fillText(String(h.nitroPct), x1 + iw + 8 * s, y + iw / 2);
      c.textAlign = 'center';
      c.textBaseline = 'top';
    }

    // Frame time (web addition): smoothed display interval, bottom centre of
    // the plane. The setting lives in Options / pause settings.
    if (store.options.showMs && h.frameMs > 0) {
      c.textAlign = 'center';
      c.textBaseline = 'bottom';
      c.font = `${Math.round(16 * s)}px system-ui, sans-serif`;
      c.fillStyle = 'rgba(255,255,255,0.6)';
      shadow(4);
      c.fillText(`${h.frameMs.toFixed(1)} ms`, W / 2, H - padY - 4 * sy);
      c.textBaseline = 'top';
      c.shadowBlur = 0;
    }

    c.shadowBlur = 0;
    // Upload (sub-image keeps the same texture object the session uses).
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Composite the painted HUD as a world-space panel (immersive VR). */
  drawPlane(
    fbo: WebGLFramebuffer | null, view: Float32Array, proj: Float32Array,
    center: vec3, right: vec3, up: vec3,
    halfW: number, halfH: number,
  ): void {
    if (!this.quad) this.quad = new WorldQuad(this.gl);
    this.quad.draw(fbo, view, proj, center, right, up, halfW, halfH, this.tex);
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
// BUILD_MARKER_1792232038
