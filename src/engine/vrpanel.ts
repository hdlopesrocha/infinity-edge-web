// World-space WebGL menu panel for immersive WebXR.
//
// The menus, lobby and room menu are ScreenUi painters (src/engine/overlay.ts):
// the same painter is uploaded as a texture and drawn as a quad inside the 3D
// scene, in front of the headset, instead of being pasted flat over each eye.
// A gaze ray from the headset intersects that plane (pure math, unit-tested)
// and drives the UI's own pointer handler, so every existing screen keeps its
// normal hover/click behaviour in VR - there is no separate VR menu.
//
// One interaction rule the UI layer cannot know: dwelling. A headset without a
// controller still selects by keeping the crosshair on an item; the controller
// trigger (session "select") clicks immediately. The dwell ring is drawn by
// GazeCursor. Dwell only arms after a deliberate move and disarms after every
// click, so a freshly opened screen cannot auto-click whatever happens to sit
// under the crosshair. Once armed, acquiring another clickable target resets
// the 2 s timer; rotating inside the same target does not.

import { mat4, vec3 } from './math';
import type { ScreenUi } from './overlay';

/** Painted panel size: 16:9, the menus' design aspect (crisp in a headset). */
export const PANEL_W = 1600;
export const PANEL_H = 900;

/** Default dwell needed to select without a controller (2 s). */
export const DWELL_MS = 2000;
/**
 * Movement needed to arm the dwell after a fresh screen or a click (UI px).
 * A small deliberate look is enough; the target-change rule below prevents
 * that from becoming an accidental click when a screen first appears.
 */
export const DWELL_ARM_PX = 20;
/**
 * Fallback reset distance for ScreenUis that do not expose gaze targets.
 * 48 px is about 3.2 degrees on the 8-unit panel, up from the old ~1.9
 * degree box, so normal head corrections do not restart the timer.
 */
export const DWELL_SLOP_PX = 48;

const WORLD_UP: vec3 = vec3.fromValues(0, 1, 0);

export interface PanelBasis {
  /** Panel centre in world space. */
  center: vec3;
  /** Unit screen-right axis. */
  right: vec3;
  /** Unit screen-up axis. */
  up: vec3;
  /** Plane normal, pointing at the viewer. */
  normal: vec3;
}

export interface PanelHit {
  /** Pointer position in UI pixels (top-left origin), ready for ScreenUi.pointer. */
  x: number;
  y: number;
  /** Panel coordinates in -1..1 (u right, v up). */
  u: number;
  v: number;
  /** Distance along the gaze ray. */
  distance: number;
  /** World-space intersection point. */
  point: vec3;
}

/**
 * Panel in front of the camera, facing it. The basis follows the *base* view
 * (not the head pose): the headset ray sweeps across a stable panel, which is
 * what makes a crosshair useful. A degenerate camera direction (startup NaN)
 * falls back to looking down -Z so the panel never disappears.
 */
export function panelBasis(camPos: vec3, camDir: vec3, distance: number): PanelBasis {
  const forward = vec3.create();
  vec3.normalize(forward, camDir);
  if (!Number.isFinite(forward[0]) || !Number.isFinite(forward[1]) || !Number.isFinite(forward[2]) ||
      vec3.length(forward) < 1e-5) {
    vec3.set(forward, 0, 0, -1);
  }
  const right = vec3.create();
  vec3.cross(right, forward, WORLD_UP);          // forward x up = right
  if (vec3.length(right) < 1e-4) vec3.set(right, 1, 0, 0);
  vec3.normalize(right, right);
  const up = vec3.create();
  vec3.cross(up, right, forward);                // right x forward = up
  vec3.normalize(up, up);
  const center = vec3.scaleAndAdd(vec3.create(), camPos, forward, distance);
  const normal = vec3.negate(vec3.create(), forward);
  return { center, right, up, normal };
}

/**
 * View-space ray that lands on the projected NDC centre `(ndcX, ndcY)`. The
 * offset corrects for the projection's principal point (`m[8]`/`m[9]`), so ray
 * aiming and the cursor stay at the true screen centre on asymmetric XR eyes.
 */
export function viewCenterRay(view: mat4, ndcX = 0, ndcY = 0): vec3 {
  const right = vec3.fromValues(view[0], view[4], view[8]);
  const up = vec3.fromValues(view[1], view[5], view[9]);
  const forward = vec3.fromValues(-view[2], -view[6], -view[10]);
  const dir = vec3.create();
  vec3.scaleAndAdd(dir, forward, right, ndcX);
  vec3.scaleAndAdd(dir, dir, up, ndcY);
  if (!(vec3.length(dir) > 1e-5)) vec3.copy(dir, forward);
  return vec3.normalize(dir, dir);
}

/**
 * Panel basis from an explicit view matrix, with the centre placed on the
 * view-space ray that projects to NDC `(ndcX, ndcY)` (0,0 = screen centre).
 *
 * `panelBasis` places the centre along the camera forward axis, which is only
 * the screen centre for a symmetric projection. WebXR eye projections are
 * often asymmetric (`m[8]`/`m[9]` shift the principal point), so a plane on the
 * forward axis can appear left/up of centre. The view's own right/up axes keep
 * the panel parallel to the view, and the centre correction makes the panel
 * rectangle project centred even with that offset.
 */
export function viewPanelBasis(
  view: mat4, center: vec3, distance: number, ndcX = 0, ndcY = 0,
): PanelBasis {
  const right = vec3.fromValues(view[0], view[4], view[8]);
  const up = vec3.fromValues(view[1], view[5], view[9]);
  const forward = vec3.fromValues(-view[2], -view[6], -view[10]);
  if (vec3.length(right) > 1e-6) vec3.normalize(right, right);
  if (vec3.length(up) > 1e-6) vec3.normalize(up, up);
  if (vec3.length(forward) > 1e-6) vec3.normalize(forward, forward);
  const dir = viewCenterRay(view, ndcX, ndcY);
  const panelCenter = vec3.scaleAndAdd(vec3.create(), center, dir, distance);
  const normal = vec3.negate(vec3.create(), forward);
  return { center: panelCenter, right, up, normal };
}

/**
 * Intersect a world-space ray with the panel. Returns null when the ray points
 * away, runs parallel, or lands outside the panel's width/height.
 */
export function hitPanel(
  origin: vec3, dir: vec3, basis: PanelBasis,
  width: number, height: number,
  uiW = PANEL_W, uiH = PANEL_H,
): PanelHit | null {
  const d = vec3.create();
  vec3.normalize(d, dir);
  if (vec3.length(d) < 1e-5) return null;
  const denom = vec3.dot(d, basis.normal);
  // Only the front face (looking roughly at the panel) can be aimed at.
  if (denom > -1e-5) return null;
  const toCenter = vec3.subtract(vec3.create(), basis.center, origin);
  const distance = vec3.dot(toCenter, basis.normal) / denom;
  if (!(distance > 0)) return null;
  const point = vec3.scaleAndAdd(vec3.create(), origin, d, distance);
  const local = vec3.subtract(vec3.create(), point, basis.center);
  const u = vec3.dot(local, basis.right) / (Math.max(1e-4, width) * 0.5);
  const v = vec3.dot(local, basis.up) / (Math.max(1e-4, height) * 0.5);
  if (u < -1 || u > 1 || v < -1 || v > 1) return null;
  return {
    x: (u * 0.5 + 0.5) * uiW,
    y: (0.5 - v * 0.5) * uiH,
    u, v, distance, point,
  };
}

/** Four projected panel corners, UV bottom-left, in bl/br/tr/tl order. */
export type PlaneQuad = [
  number, number, number, number, number, number, number, number,
];

/**
 * Project the four corners of a world-space panel into one eye's UV.
 *
 * A panel viewed straight-on projects to an axis-aligned rectangle, but the
 * menu panel follows the ship/base view rather than the head. Turning the
 * head therefore views it obliquely: the real silhouette is a trapezoid. Keep
 * the corners so the focus frame can follow that silhouette instead of an
 * axis-aligned bounding box that floats outside the panel.
 */
export function projectedPlaneQuad(
  view: Float32Array, proj: Float32Array,
  center: vec3, right: vec3, up: vec3, halfW: number, halfH: number,
): PlaneQuad | null {
  const m = mat4.multiply(mat4.create(), proj, view);
  const out: number[] = [];
  // Bottom-left, bottom-right, top-right, top-left in panel space.
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const x = center[0] + right[0] * halfW * sx + up[0] * halfH * sy;
    const y = center[1] + right[1] * halfW * sx + up[1] * halfH * sy;
    const z = center[2] + right[2] * halfW * sx + up[2] * halfH * sy;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (!(w > 1e-5)) return null;
    const nx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    const ny = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
    out.push(nx * 0.5 + 0.5, ny * 0.5 + 0.5);
  }
  return out as PlaneQuad;
}

/**
 * Project a world-space rectangle (the menu/HUD panel) into one eye's UV.
 * The returned rectangle is in the composite's bottom-left UV convention, so
 * the post-process can keep the panel sharp and blur/tint everything outside
 * it with zero blur on the edge. Returns null when the panel is not in front
 * of this eye or the projection is degenerate.
 */
export function projectedPlaneRect(
  view: Float32Array, proj: Float32Array,
  center: vec3, right: vec3, up: vec3, halfW: number, halfH: number,
): { x: number; y: number; w: number; h: number } | null {
  const quad = projectedPlaneQuad(view, proj, center, right, up, halfW, halfH);
  if (!quad) return null;
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  if (!(maxX > minX) || !(maxY > minY)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Uniform scale for a world-space plane so it fits inside an eye's projection.
 *
 * A menu/HUD panel is painted at a fixed world size and distance. On a narrow
 * or moderate eye FOV that can be wider than the view: its projected rectangle
 * then crosses the viewport edge, so the focus frame loses its side strokes and
 * the post-process has no "outside" left to blur. Scale the quad (and the
 * painted FOV for the HUD) by this factor to keep a margin around it.
 *
 * `projections` are the WebXR eye projection matrices. For a plane centred on
 * the view axis, the NDC half-extent is `(size / 2) / distance * m[0]` (or
 * m[5] vertically); require it to stay inside `margin` (0..1 of NDC). The
 * asymmetric per-eye offsets m[8]/m[9] are subtracted from the usable margin
 * so the tighter side is safe too.
 */
export function planeFitScale(
  projections: ArrayLike<number>[],
  width: number,
  height: number,
  distance: number,
  margin = 0.86,
): number {
  if (!(width > 0) || !(height > 0) || !(distance > 0)) return 1;
  const edge = Math.max(0.05, Math.min(1, margin));
  let scale = 1;
  for (const p of projections) {
    const m0 = Math.abs(p[0] ?? 0);
    const m5 = Math.abs(p[5] ?? 0);
    if (!(m0 > 1e-6) || !(m5 > 1e-6) || !Number.isFinite(m0) || !Number.isFinite(m5)) continue;
    // Per-eye projections are often asymmetric (m[8]/m[9] shift the NDC
    // centre). Keep the same margin on the tighter side as well.
    const offX = Math.max(0, Math.min(edge, Math.abs(p[8] ?? 0)));
    const offY = Math.max(0, Math.min(edge, Math.abs(p[9] ?? 0)));
    // NDC half-size = (worldHalf / distance) * projection scale. Solve for the
    // largest world size whose half-size is at most `edge` on both sides.
    const fitW = (2 * distance * (edge - offX)) / m0;
    const fitH = (2 * distance * (edge - offY)) / m5;
    scale = Math.min(scale, fitW / width, fitH / height);
  }
  return Math.max(0.05, Math.min(1, scale));
}

/**
 * Cyclops view for the head-locked HUD. The eye views are composed exactly as
 * the renderer does it (head pose -> yaw re-centre -> ship-up chase), inverted
 * to world space and averaged into one head-centre position. The returned view
 * keeps the first eye's rotation but maps that rendered head centre to the
 * origin.
 *
 * Using the raw room-space eye poses here is wrong: the chase camera is not at
 * the room origin, so the HUD plane would sit far away from the actual view
 * (and usually outside the frustum). The composition must include the chase.
 */
export function cyclopsView(
  eyeViewMatrices: Float32Array[], baselineYawAbs: number, chase: mat4,
): { view: mat4; center: vec3 } {
  const view = mat4.create();
  const first = mat4.create();
  const eye = mat4.create();
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < eyeViewMatrices.length; i++) {
    mat4.invert(view, eyeViewMatrices[i]);
    mat4.rotateY(view, view, baselineYawAbs);
    mat4.multiply(view, view, chase);
    if (i === 0) mat4.copy(first, view);
    mat4.invert(eye, view);
    cx += eye[12]; cy += eye[13]; cz += eye[14];
  }
  const n = Math.max(1, eyeViewMatrices.length);
  cx /= n; cy /= n; cz /= n;
  const out = mat4.clone(first);
  out[12] = out[13] = out[14] = 0;
  const offset = vec3.transformMat4(vec3.create(), vec3.fromValues(cx, cy, cz), out);
  out[12] = -offset[0];
  out[13] = -offset[1];
  out[14] = -offset[2];
  return { view: out, center: vec3.fromValues(cx, cy, cz) };
}

/**
 * Gaze pointer: hover, dwell and click state for one ScreenUi. Pure logic (no
 * DOM/GL) so the interaction is unit-tested; the XR loop feeds it a hit per
 * frame and a dt.
 */
export class GazePointer {
  private lastX = -1;
  private lastY = -1;
  private anchorX = 0;
  private anchorY = 0;
  private dwell = 0;
  private armed = false;
  private entered = false;
  /** Clickable region currently under the gaze (null = empty UI area). */
  private target: string | null = null;

  constructor(
    private ui: ScreenUi,
    private w = PANEL_W,
    private h = PANEL_H,
    private dwellMs = DWELL_MS,
  ) {}

  /** Change the click dwell live (settings slider). Resets a partial dwell. */
  setDwellMs(ms: number): void {
    const next = Number.isFinite(ms) ? Math.max(250, Math.min(10000, ms)) : DWELL_MS;
    if (next !== this.dwellMs) {
      this.dwellMs = next;
      this.dwell = 0;
    }
  }

  /** Painted size the pointer coordinates refer to. */
  get size(): { w: number; h: number } {
    return { w: this.w, h: this.h };
  }

  get hover(): { x: number; y: number } | null {
    return this.lastX < 0 ? null : { x: this.lastX, y: this.lastY };
  }

  /** 0..1 dwell progress for the crosshair ring. */
  get progress(): number {
    return this.armed ? Math.min(1, this.dwell / this.dwellMs) : 0;
  }

  /** True while the crosshair is over a clickable target. */
  get hasTarget(): boolean {
    return this.target !== null;
  }

  /**
   * Feed the current hit (UI pixels, null when the gaze misses the panel) and
   * the frame time. Returns true when the dwell fired a click.
   */
  update(hit: { x: number; y: number } | null, dtMs: number): boolean {
    if (!hit) {
      if (this.lastX >= 0) {
        this.lastX = -1;
        this.lastY = -1;
        this.ui.pointer?.('move', -1, -1, this.w, this.h);
      }
      this.dwell = 0;
      this.target = null;
      return false;
    }
    if (this.lastX < 0 || Math.abs(hit.x - this.lastX) > 0.5 || Math.abs(hit.y - this.lastY) > 0.5) {
      this.lastX = hit.x;
      this.lastY = hit.y;
      this.ui.pointer?.('move', hit.x, hit.y, this.w, this.h);
    }
    // Target-aware UIs let the dwell continue while the head rotates inside
    // the same button; only acquiring a different button restarts the timer.
    // ScreenUis without this hook fall back to the movement radius below.
    const target = this.ui.gazeTarget
      ? this.ui.gazeTarget(hit.x, hit.y, this.w, this.h)
      : undefined;
    // A fresh screen must not click whatever happens to sit under the
    // crosshair when it appears: dwell only arms after a deliberate move.
    if (!this.entered) {
      this.entered = true;
      this.anchorX = hit.x;
      this.anchorY = hit.y;
      this.armed = false;
      this.dwell = 0;
      this.target = target ?? null;
      return false;
    }
    if (!this.armed) {
      if (Math.abs(hit.x - this.anchorX) > DWELL_ARM_PX || Math.abs(hit.y - this.anchorY) > DWELL_ARM_PX) {
        this.armed = true;
        this.anchorX = hit.x;
        this.anchorY = hit.y;
        this.dwell = 0;
        this.target = target ?? null;
      }
      return false;
    }
    if (target !== undefined) {
      if (target !== this.target) {
        // The crosshair moved to another clickable region (or off one): this
        // is a new pointing task, so start its dwell from zero.
        this.target = target;
        this.anchorX = hit.x;
        this.anchorY = hit.y;
        this.dwell = 0;
        return false;
      }
      if (target === null) {
        this.dwell = 0;
        return false;
      }
    } else if (Math.abs(hit.x - this.anchorX) > DWELL_SLOP_PX || Math.abs(hit.y - this.anchorY) > DWELL_SLOP_PX) {
      this.anchorX = hit.x;
      this.anchorY = hit.y;
      this.dwell = 0;
    }
    this.dwell += Math.max(0, Math.min(100, dtMs));
    if (this.dwell >= this.dwellMs) {
      this.click();
      return true;
    }
    return false;
  }

  /** Click at the current hover (controller trigger / session select). */
  click(): boolean {
    if (this.lastX < 0) return false;
    this.ui.pointer?.('down', this.lastX, this.lastY, this.w, this.h);
    this.ui.pointer?.('up', this.lastX, this.lastY, this.w, this.h);
    this.dwell = 0;
    // Keep the crosshair where it is but do not immediately dwell again.
    this.armed = false;
    this.anchorX = this.lastX;
    this.anchorY = this.lastY;
    return true;
  }

  /** Clear the hover (leaving the panel/menu) and stop the dwell. */
  reset(): void {
    if (this.lastX >= 0) this.ui.pointer?.('move', -1, -1, this.w, this.h);
    this.lastX = -1;
    this.lastY = -1;
    this.dwell = 0;
    this.armed = false;
    this.entered = false;
    this.target = null;
  }
}

// ------------------------------------------------------------------- WebGL

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('vr panel shader: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function program(gl: WebGL2RenderingContext, vert: string, frag: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vert));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('vr panel link: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

interface Quad {
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  ibo: WebGLBuffer;
}

/** Unit quad (-1..1) shared by the panel and the cursor. */
function quad(gl: WebGL2RenderingContext): Quad {
  const vao = gl.createVertexArray()!;
  const vbo = gl.createBuffer()!;
  const ibo = gl.createBuffer()!;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  return { vao, vbo, ibo };
}

export interface ClipRect { x: number; y: number; w: number; h: number }

/**
 * Run `draw` clipped (and viewported) to one eye's rectangle, then always
 * clear the scissor. Leaving the scissor enabled after an overlay is a nasty
 * stereo bug: the *next* eye's scene is clipped to the previous eye's half,
 * so the panel shows in both eyes while the world only renders in one.
 */
export function withClipRect(gl: WebGL2RenderingContext, rect: ClipRect, draw: () => void): void {
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(rect.x, rect.y, rect.w, rect.h);
  gl.viewport(rect.x, rect.y, rect.w, rect.h);
  try {
    draw();
  } finally {
    gl.disable(gl.SCISSOR_TEST);
  }
}

/** Save/restore the GL state these quads touch (they draw over the frame). */
function withOverlayState(gl: WebGL2RenderingContext, draw: () => void): void {
  const depth = gl.isEnabled(gl.DEPTH_TEST);
  const cull = gl.isEnabled(gl.CULL_FACE);
  const blend = gl.isEnabled(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.depthMask(false);
  gl.disable(gl.CULL_FACE);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  draw();
  if (!blend) gl.disable(gl.BLEND);
  if (depth) gl.enable(gl.DEPTH_TEST);
  if (cull) gl.enable(gl.CULL_FACE);
  gl.depthMask(true);
}

const PANEL_VERT = `#version 300 es
layout(location=0) in vec2 aPos;
uniform vec3 uCenter, uRight, uUp;
uniform vec2 uHalf;
uniform mat4 uView, uProj;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  vec3 p = uCenter + uRight * (aPos.x * uHalf.x) + uUp * (aPos.y * uHalf.y);
  gl_Position = uProj * uView * vec4(p, 1.0);
}`;

const PANEL_FRAG = `#version 300 es
precision mediump float;
in vec2 vUV;
uniform sampler2D uTex;
out vec4 o;
void main() {
  vec4 c = texture(uTex, vUV);
  if (c.a <= 0.003) discard;
  o = c;
}`;

/**
 * The ScreenUi texture on a world-space quad. The texture is painted at a
 * fixed 16:9 size (PANEL_W x PANEL_H) and uploaded only when the UI's version
 * changes, exactly like the screen-space overlay.
 */
export class VrPanel {
  readonly width = PANEL_W;
  readonly height = PANEL_H;
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tex: WebGLTexture;
  private prog: WebGLProgram;
  private quad: Quad;
  private uTex: WebGLUniformLocation | null;
  private uCenter: WebGLUniformLocation | null;
  private uRight: WebGLUniformLocation | null;
  private uUp: WebGLUniformLocation | null;
  private uHalf: WebGLUniformLocation | null;
  private uView: WebGLUniformLocation | null;
  private uProj: WebGLUniformLocation | null;
  private lastVersion = -1;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.canvas = document.createElement('canvas');
    this.canvas.width = PANEL_W;
    this.canvas.height = PANEL_H;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('vr panel: no 2d context');
    this.ctx = ctx;
    const tex = gl.createTexture();
    if (!tex) throw new Error('vr panel: texture failed');
    this.tex = tex;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, PANEL_W, PANEL_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.prog = program(gl, PANEL_VERT, PANEL_FRAG);
    this.uTex = gl.getUniformLocation(this.prog, 'uTex');
    this.uCenter = gl.getUniformLocation(this.prog, 'uCenter');
    this.uRight = gl.getUniformLocation(this.prog, 'uRight');
    this.uUp = gl.getUniformLocation(this.prog, 'uUp');
    this.uHalf = gl.getUniformLocation(this.prog, 'uHalf');
    this.uView = gl.getUniformLocation(this.prog, 'uView');
    this.uProj = gl.getUniformLocation(this.prog, 'uProj');
    this.quad = quad(gl);
  }

  /** Uploaded texture, shared with the generic UiScene's one plane. */
  get texture(): WebGLTexture {
    return this.tex;
  }

  /** Repaint and upload when the UI changed. */
  update(ui: ScreenUi): void {
    if (ui.version === this.lastVersion) return;
    this.lastVersion = ui.version;
    ui.paint(this.ctx, PANEL_W, PANEL_H);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    // Same convention as ScreenOverlay: v=1 samples the canvas's top row.
    const flip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) as boolean;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flip);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Release the GL objects when the session ends. */
  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.tex);
    gl.deleteProgram(this.prog);
    gl.deleteVertexArray(this.quad.vao);
    gl.deleteBuffer(this.quad.vbo);
    gl.deleteBuffer(this.quad.ibo);
  }

  /** Draw the panel in the eye currently bound (viewport/scissor are the caller's). */
  draw(
    fbo: WebGLFramebuffer | null, view: Float32Array, proj: Float32Array,
    basis: PanelBasis, width: number, height: number,
  ): void {
    const gl = this.gl;
    withOverlayState(gl, () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.useProgram(this.prog);
      if (this.uCenter) gl.uniform3fv(this.uCenter, basis.center);
      if (this.uRight) gl.uniform3fv(this.uRight, basis.right);
      if (this.uUp) gl.uniform3fv(this.uUp, basis.up);
      if (this.uHalf) gl.uniform2f(this.uHalf, width * 0.5, height * 0.5);
      if (this.uView) gl.uniformMatrix4fv(this.uView, false, view);
      if (this.uProj) gl.uniformMatrix4fv(this.uProj, false, proj);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      if (this.uTex) gl.uniform1i(this.uTex, 0);
      gl.bindVertexArray(this.quad.vao);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
      gl.bindVertexArray(null);
      gl.bindTexture(gl.TEXTURE_2D, null);
    });
  }
}

/**
 * A textured quad in world space, clipped to one eye. The HUD uses it for its
 * in-game panel (the menu VrPanel owns its own painter/uploader, but the
 * drawing is the same).
 */
export class WorldQuad {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private quad: Quad;
  private uTex: WebGLUniformLocation | null;
  private uCenter: WebGLUniformLocation | null;
  private uRight: WebGLUniformLocation | null;
  private uUp: WebGLUniformLocation | null;
  private uHalf: WebGLUniformLocation | null;
  private uView: WebGLUniformLocation | null;
  private uProj: WebGLUniformLocation | null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.prog = program(gl, PANEL_VERT, PANEL_FRAG);
    this.uTex = gl.getUniformLocation(this.prog, 'uTex');
    this.uCenter = gl.getUniformLocation(this.prog, 'uCenter');
    this.uRight = gl.getUniformLocation(this.prog, 'uRight');
    this.uUp = gl.getUniformLocation(this.prog, 'uUp');
    this.uHalf = gl.getUniformLocation(this.prog, 'uHalf');
    this.uView = gl.getUniformLocation(this.prog, 'uView');
    this.uProj = gl.getUniformLocation(this.prog, 'uProj');
    this.quad = quad(gl);
  }

  draw(
    fbo: WebGLFramebuffer | null, view: Float32Array, proj: Float32Array,
    center: vec3, right: vec3, up: vec3, halfW: number, halfH: number,
    tex: WebGLTexture,
  ): void {
    const gl = this.gl;
    withOverlayState(gl, () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.useProgram(this.prog);
      if (this.uCenter) gl.uniform3fv(this.uCenter, center);
      if (this.uRight) gl.uniform3fv(this.uRight, right);
      if (this.uUp) gl.uniform3fv(this.uUp, up);
      if (this.uHalf) gl.uniform2f(this.uHalf, halfW, halfH);
      if (this.uView) gl.uniformMatrix4fv(this.uView, false, view);
      if (this.uProj) gl.uniformMatrix4fv(this.uProj, false, proj);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      if (this.uTex) gl.uniform1i(this.uTex, 0);
      gl.bindVertexArray(this.quad.vao);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
      gl.bindVertexArray(null);
      gl.bindTexture(gl.TEXTURE_2D, null);
    });
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.prog);
    gl.deleteVertexArray(this.quad.vao);
    gl.deleteBuffer(this.quad.vbo);
    gl.deleteBuffer(this.quad.ibo);
  }
}

const BORDER_VERT = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const BORDER_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform vec2 uView;
uniform vec2 uP0, uP1, uP2, uP3;
uniform vec3 uColor;
uniform float uThickness;
out vec4 o;

float cross2(vec2 a, vec2 b) { return a.x * b.y - a.y * b.x; }
float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  float len2 = dot(ab, ab);
  float t = len2 > 1e-6 ? clamp(dot(p - a, ab) / len2, 0.0, 1.0) : 0.0;
  return length(p - (a + ab * t));
}

void main() {
  vec2 p = vUV * uView;
  vec2 p0 = uP0 * uView;
  vec2 p1 = uP1 * uView;
  vec2 p2 = uP2 * uView;
  vec2 p3 = uP3 * uView;
  // Convex quad, either winding; the border is stroked inside its silhouette.
  float c0 = cross2(p1 - p0, p - p0);
  float c1 = cross2(p2 - p1, p - p1);
  float c2 = cross2(p3 - p2, p - p2);
  float c3 = cross2(p0 - p3, p - p3);
  bool allPos = c0 >= 0.0 && c1 >= 0.0 && c2 >= 0.0 && c3 >= 0.0;
  bool allNeg = c0 <= 0.0 && c1 <= 0.0 && c2 <= 0.0 && c3 <= 0.0;
  if (!allPos && !allNeg) discard;
  float d = min(min(segDist(p, p0, p1), segDist(p, p1, p2)),
                min(segDist(p, p2, p3), segDist(p, p3, p0)));
  if (d > uThickness) discard;
  o = vec4(uColor, 1.0);
}`;

/**
 * Crisp screen-space focus stroke around a projected panel silhouette.
 *
 * The flat renderer can use axis-aligned strips, but the VR menu panel is
 * viewed obliquely whenever the head turns. Its real projected edges are a
 * trapezoid, not the bounding box `projectedPlaneRect()` returns, so drawing a
 * rectangle border leaves strokes floating outside the panel. This pass tests
 * each pixel against the four projected edges and paints the same 2 CSS px
 * inside the silhouette.
 */
export class PanelBorder {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private quad: Quad;
  private uView: WebGLUniformLocation | null;
  private uP0: WebGLUniformLocation | null;
  private uP1: WebGLUniformLocation | null;
  private uP2: WebGLUniformLocation | null;
  private uP3: WebGLUniformLocation | null;
  private uColor: WebGLUniformLocation | null;
  private uThickness: WebGLUniformLocation | null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.prog = program(gl, BORDER_VERT, BORDER_FRAG);
    this.uView = gl.getUniformLocation(this.prog, 'uView');
    this.uP0 = gl.getUniformLocation(this.prog, 'uP0');
    this.uP1 = gl.getUniformLocation(this.prog, 'uP1');
    this.uP2 = gl.getUniformLocation(this.prog, 'uP2');
    this.uP3 = gl.getUniformLocation(this.prog, 'uP3');
    this.uColor = gl.getUniformLocation(this.prog, 'uColor');
    this.uThickness = gl.getUniformLocation(this.prog, 'uThickness');
    this.quad = quad(gl);
  }

  draw(
    fbo: WebGLFramebuffer | null, view: ClipRect, corners: PlaneQuad,
    color: readonly [number, number, number], thicknessPx: number,
  ): void {
    if (view.w <= 0 || view.h <= 0) return;
    const gl = this.gl;
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const scissorOn = gl.isEnabled(gl.SCISSOR_TEST);
    const prevScissor = gl.getParameter(gl.SCISSOR_BOX) as Int32Array;
    withOverlayState(gl, () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(view.x, view.y, view.w, view.h);
      gl.viewport(view.x, view.y, view.w, view.h);
      gl.useProgram(this.prog);
      if (this.uView) gl.uniform2f(this.uView, view.w, view.h);
      if (this.uP0) gl.uniform2f(this.uP0, corners[0], corners[1]);
      if (this.uP1) gl.uniform2f(this.uP1, corners[2], corners[3]);
      if (this.uP2) gl.uniform2f(this.uP2, corners[4], corners[5]);
      if (this.uP3) gl.uniform2f(this.uP3, corners[6], corners[7]);
      if (this.uColor) gl.uniform3f(this.uColor, color[0], color[1], color[2]);
      if (this.uThickness) gl.uniform1f(this.uThickness, Math.max(1, thicknessPx));
      gl.bindVertexArray(this.quad.vao);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
      gl.bindVertexArray(null);
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
    if (scissorOn) gl.scissor(prevScissor[0], prevScissor[1], prevScissor[2], prevScissor[3]);
    else gl.disable(gl.SCISSOR_TEST);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.prog);
    gl.deleteVertexArray(this.quad.vao);
    gl.deleteBuffer(this.quad.vbo);
    gl.deleteBuffer(this.quad.ibo);
  }
}

const CURSOR_VERT = `#version 300 es
layout(location=0) in vec2 aPos;
uniform vec3 uCenter, uRight, uUp;
uniform float uRadius;
uniform float uAspect;
uniform mat4 uView, uProj;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  vec3 p = uCenter + uRight * (aPos.x * uRadius * uAspect) + uUp * (aPos.y * uRadius);
  gl_Position = uProj * uView * vec4(p, 1.0);
}`;

const CURSOR_FRAG = `#version 300 es
precision mediump float;
in vec2 vUV;
uniform vec3 uColor;
uniform float uProgress;
uniform sampler2D uIcon;
uniform float uUseIcon;
out vec4 o;
void main() {
  if (uUseIcon > 0.5) {
    vec4 icon = texture(uIcon, vUV);
    if (icon.a <= 0.01) discard;
    o = vec4(icon.rgb, icon.a * 0.95);
    return;
  }
  vec2 p = vUV * 2.0 - 1.0;
  float r = length(p);
  float ring = smoothstep(0.10, 0.02, abs(r - 0.62));
  float dot0 = smoothstep(0.16, 0.0, r);
  float cross = 0.0;
  if (abs(p.x) < 0.04 && abs(p.y) < 0.52) cross = 1.0;
  if (abs(p.y) < 0.04 && abs(p.x) < 0.52) cross = 1.0;
  float a = max(max(ring, cross * 0.85), dot0);
  vec3 col = mix(uColor, vec3(1.0), dot0);
  // Dwell arc: starts at the top and fills clockwise.
  float ang = atan(p.x, p.y);
  float frac = ang < 0.0 ? (ang + 6.2831853) / 6.2831853 : ang / 6.2831853;
  float arc = (abs(r - 0.62) < 0.13 && uProgress > 0.001 && frac <= uProgress) ? 1.0 : 0.0;
  col = mix(col, vec3(1.0, 0.83, 0.47), arc);
  a = max(a, arc);
  if (a < 0.01) discard;
  o = vec4(col, a);
}`;

const SCREEN_CURSOR_VERT = `#version 300 es
layout(location=0) in vec2 aPos;
uniform vec2 uCenter;
uniform vec2 uSize;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(uCenter + aPos * uSize, 0.0, 1.0);
}`;

const SCREEN_CURSOR_FRAG = `#version 300 es
precision mediump float;
in vec2 vUV;
uniform sampler2D uIcon;
uniform float uUseIcon;
uniform vec3 uColor;
uniform float uProgress;
out vec4 o;
void main() {
  vec2 p = vUV * 2.0 - 1.0;
  float r = length(p);
  float ring = smoothstep(0.10, 0.02, abs(r - 0.62));
  float ang = atan(p.x, p.y);
  float frac = ang < 0.0 ? (ang + 6.2831853) / 6.2831853 : ang / 6.2831853;
  float arc = (abs(r - 0.62) < 0.13 && uProgress > 0.001 && frac <= uProgress) ? 1.0 : 0.0;
  // No target (or no dwell yet): no inner wheel, just the crosshair.
  float wheel = uProgress > 0.001 ? max(ring, arc) : 0.0;
  vec3 col = uColor;
  float a = wheel;
  if (uUseIcon > 0.5) {
    vec4 icon = texture(uIcon, vUV);
    col = mix(icon.rgb, uColor, wheel);
    a = max(icon.a * 0.95, wheel);
  }
  if (a < 0.01) discard;
  o = vec4(col, a);
}`;

/** Crosshair/dwell ring, billboarded at the gaze point of one eye. */
export class GazeCursor {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private quad: Quad;
  private uCenter: WebGLUniformLocation | null;
  private uRight: WebGLUniformLocation | null;
  private uUp: WebGLUniformLocation | null;
  private uRadius: WebGLUniformLocation | null;
  private uView: WebGLUniformLocation | null;
  private uProj: WebGLUniformLocation | null;
  private uColor: WebGLUniformLocation | null;
  private uProgress: WebGLUniformLocation | null;
  private uIcon: WebGLUniformLocation | null;
  private uUseIcon: WebGLUniformLocation | null;
  private uAspect: WebGLUniformLocation | null;
  /** Optional spaceship `_aim.png` icon; when set the ring is replaced. */
  private icon: WebGLTexture | null = null;
  private iconAspect = 1;
  /** Screen-space variant: same icon at the same spot in both eyes. */
  private screenProg: WebGLProgram;
  private sCenter: WebGLUniformLocation | null;
  private sSize: WebGLUniformLocation | null;
  private sIcon: WebGLUniformLocation | null;
  private sUseIcon: WebGLUniformLocation | null;
  private sColor: WebGLUniformLocation | null;
  private sProgress: WebGLUniformLocation | null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.prog = program(gl, CURSOR_VERT, CURSOR_FRAG);
    this.screenProg = program(gl, SCREEN_CURSOR_VERT, SCREEN_CURSOR_FRAG);
    this.sCenter = gl.getUniformLocation(this.screenProg, 'uCenter');
    this.sSize = gl.getUniformLocation(this.screenProg, 'uSize');
    this.sIcon = gl.getUniformLocation(this.screenProg, 'uIcon');
    this.sUseIcon = gl.getUniformLocation(this.screenProg, 'uUseIcon');
    this.sColor = gl.getUniformLocation(this.screenProg, 'uColor');
    this.sProgress = gl.getUniformLocation(this.screenProg, 'uProgress');
    this.uCenter = gl.getUniformLocation(this.prog, 'uCenter');
    this.uRight = gl.getUniformLocation(this.prog, 'uRight');
    this.uUp = gl.getUniformLocation(this.prog, 'uUp');
    this.uRadius = gl.getUniformLocation(this.prog, 'uRadius');
    this.uView = gl.getUniformLocation(this.prog, 'uView');
    this.uProj = gl.getUniformLocation(this.prog, 'uProj');
    this.uColor = gl.getUniformLocation(this.prog, 'uColor');
    this.uProgress = gl.getUniformLocation(this.prog, 'uProgress');
    this.uIcon = gl.getUniformLocation(this.prog, 'uIcon');
    this.uUseIcon = gl.getUniformLocation(this.prog, 'uUseIcon');
    this.uAspect = gl.getUniformLocation(this.prog, 'uAspect');
    this.quad = quad(gl);
  }

  /** Use the same crosshair art as the spaceship HUD (`_aim.png`). */
  setIcon(img: HTMLImageElement): void {
    const gl = this.gl;
    if (this.icon) gl.deleteTexture(this.icon);
    const tex = gl.createTexture();
    if (!tex) return;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.icon = tex;
    this.iconAspect = img.width / Math.max(1, img.height);
  }

  dispose(): void {
    const gl = this.gl;
    if (this.icon) gl.deleteTexture(this.icon);
    this.icon = null;
    gl.deleteProgram(this.prog);
    gl.deleteProgram(this.screenProg);
    gl.deleteVertexArray(this.quad.vao);
    gl.deleteBuffer(this.quad.vbo);
    gl.deleteBuffer(this.quad.ibo);
  }

  /**
   * Draw the cursor in screen space at the centre of the current viewport.
   * Both eyes get the exact same relative position, so the two images fuse
   * instead of showing a separate left/right crosshair.
   */
  drawScreen(
    fbo: WebGLFramebuffer | null, w: number, h: number,
    ndcX: number, ndcY: number, sizePx: number,
    progress = 0, color: readonly [number, number, number] = [0.5, 0.91, 0.85],
  ): void {
    const gl = this.gl;
    const useIcon = this.icon !== null;
    const sx = (sizePx * 2) / Math.max(1, w);
    const sy = (sizePx * 2) / Math.max(1, h);
    withOverlayState(gl, () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.useProgram(this.screenProg);
      if (this.sCenter) gl.uniform2f(this.sCenter, ndcX, ndcY);
      if (this.sSize) gl.uniform2f(this.sSize, sx, sy);
      if (this.sUseIcon) gl.uniform1f(this.sUseIcon, useIcon ? 1 : 0);
      if (this.sColor) gl.uniform3f(this.sColor, color[0], color[1], color[2]);
      if (this.sProgress) gl.uniform1f(this.sProgress, Math.max(0, Math.min(1, progress)));
      if (useIcon && this.sIcon) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.icon);
        gl.uniform1i(this.sIcon, 0);
      }
      gl.bindVertexArray(this.quad.vao);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
      gl.bindVertexArray(null);
      if (useIcon) gl.bindTexture(gl.TEXTURE_2D, null);
    });
  }

  draw(
    fbo: WebGLFramebuffer | null, view: Float32Array, proj: Float32Array,
    center: vec3, right: vec3, up: vec3, radius: number, progress: number,
  ): void {
    const gl = this.gl;
    const useIcon = this.icon !== null;
    withOverlayState(gl, () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.useProgram(this.prog);
      if (this.uCenter) gl.uniform3fv(this.uCenter, center);
      if (this.uRight) gl.uniform3fv(this.uRight, right);
      if (this.uUp) gl.uniform3fv(this.uUp, up);
      if (this.uRadius) gl.uniform1f(this.uRadius, Math.max(0.001, radius));
      if (this.uAspect) gl.uniform1f(this.uAspect, useIcon ? this.iconAspect : 1);
      if (this.uUseIcon) gl.uniform1f(this.uUseIcon, useIcon ? 1 : 0);
      if (useIcon && this.uIcon) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.icon);
        gl.uniform1i(this.uIcon, 0);
      }
      if (this.uView) gl.uniformMatrix4fv(this.uView, false, view);
      if (this.uProj) gl.uniformMatrix4fv(this.uProj, false, proj);
      if (this.uColor) gl.uniform3f(this.uColor, 0.5, 0.91, 0.85);
      if (this.uProgress) gl.uniform1f(this.uProgress, Math.max(0, Math.min(1, progress)));
      gl.bindVertexArray(this.quad.vao);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
      gl.bindVertexArray(null);
      if (useIcon) gl.bindTexture(gl.TEXTURE_2D, null);
    });
  }
}
