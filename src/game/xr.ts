// Real WebXR ("immersive-vr"): the session owns the frame loop and we render
// the scene once per eye straight into the XR framebuffer, with each eye's own
// pose and projection. Not a gyroscope look-alike.
//
// Integration notes:
// - the chase camera keeps flying the ship; the head pose is applied on top of
//   that view (seated experience: rotation from the XR transform), so the ship
//   stays centred while you look around.
// - the post chain (zoom blur / lens flare / soft particles) is skipped inside
//   XR: we draw the map directly into the XR framebuffer per eye.
// - while a session is live, the normal rAF path only advances the simulation
//   (renderer.xrActive) so nothing double-draws to the canvas.
// - the menus are the same WebGL ScreenUi the 2D pages use: they are painted
//   once into a texture and drawn as a world-space panel in front of the base
//   view (src/engine/vrpanel.ts). The headset's gaze ray sweeps that panel and
//   drives the UI's own pointer handler; trigger clicks instantly, dwelling
//   (~1.6 s) selects without a controller. There is no separate VR menu.
import { mat4, vec3 } from '../engine/math';
import type { GameInstance } from './instance';
import { store } from './store';
import { syncHud } from './hud';
import {
  GazeCursor, GazePointer, PANEL_H, PANEL_W, VrPanel, hitPanel, panelBasis,
} from '../engine/vrpanel';
import type { ScreenUi } from '../engine/overlay';

// Minimal WebXR typings: TypeScript's dom lib omits them and this module uses
// only this surface, so we declare it locally instead of adding a dependency.
interface XRViewport { x: number; y: number; width: number; height: number }
interface XRView { projectionMatrix: Float32Array; transform: { matrix: Float32Array } }
interface XRViewerPose { views: XRView[] }
interface XRFrame { getViewerPose(space: unknown): XRViewerPose | null }
interface XRWebGLLayer {
  framebuffer: WebGLFramebuffer | null;
  framebufferWidth: number;
  framebufferHeight: number;
  getViewport(view: XRView): XRViewport | null;
}
declare const XRWebGLLayer: { new (session: unknown, gl: WebGL2RenderingContext): XRWebGLLayer };
interface XRSession {
  requestAnimationFrame(cb: (time: number, frame: XRFrame) => void): number;
  requestReferenceSpace(type: string): Promise<unknown>;
  updateRenderState(state: Record<string, unknown>): void;
  addEventListener(type: string, cb: () => void): void;
  end(): Promise<void>;
}

type XrSystem = {
  isSessionSupported(mode: string): Promise<boolean>;
  requestSession(mode: string, init?: Record<string, unknown>): Promise<XRSession>;
};

function xr(): XrSystem | null {
  const n = navigator as unknown as { xr?: XrSystem };
  return n.xr ?? null;
}

/** Panel placement in world units (the old VR menu's comfortable scale). */
const PANEL_DISTANCE = 6;
const PANEL_WIDTH = 8;
const PANEL_HEIGHT = PANEL_WIDTH * (PANEL_H / PANEL_W);

let session: XRSession | null = null;
let keepVrOnEnd = false;
let entering = false;
let baselineYawAbs = 0;
let latestHeadYawAbs = 0;
let initialized = false;

export function xrActive(): boolean {
  return session !== null;
}

/** Is immersive-vr usable here? (needs WebXR *and* a secure context) */
export async function xrSupported(): Promise<boolean> {
  const sys = xr();
  if (!sys) return false;
  try {
    return await sys.isSessionSupported('immersive-vr');
  } catch {
    return false;
  }
}

/**
 * End the session. `keepVr` keeps the app in VR mode (split view with the DOM
 * UI) - that is what pressing pause does, since an immersive session hides the
 * page DOM and the pause panel belongs to the DOM HUD.
 */
export function leaveXr(keepVr = false): void {
  const s = session;
  session = null;
  keepVrOnEnd = keepVr;
  if (s) void s.end().catch(() => undefined);
}

/**
 * Enter immersive VR. `getInstance` is polled so the session survives a scene
 * rebuild; `onEnd` clears the UI state.
 */
export async function enterXr(
  renderer: {
    gl: WebGL2RenderingContext;
    camera: import('../engine/camera').Camera;
    frustum: import('../engine/frustum').FrustumPlanes;
    xrActive: boolean;
    viewport: { x: number; y: number; w: number; h: number } | null;
    presentFbo: WebGLFramebuffer | null;
    presentBounds: { w: number; h: number } | null;
    uiOverlay: ScreenUi | null;
    drawHudTo: (fbo: WebGLFramebuffer | null, rect: { x: number; y: number; w: number; h: number }, hud: typeof store.hud | null) => void;
    beginFrame: () => void;
    endFrame: (hud?: typeof store.hud | null) => void;
    renderOptions: { zoom: number };
  },
  getInstance: () => GameInstance | null,
  onEnd: () => void,
): Promise<boolean> {
  const sys = xr();
  if (!sys) return false;
  if (session || entering) return false;
  entering = true;
  let s: XRSession;
  try {
    s = await sys.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor', 'dom-overlay'], domOverlay: { root: document.body } });
  } catch {
    entering = false;
    return false;
  }
  entering = false;
  session = s;
  renderer.xrActive = true;
  const gl = renderer.gl;
  await (gl as unknown as { makeXRCompatible(): Promise<void> }).makeXRCompatible();
  const layer = new XRWebGLLayer(s, gl);
  // The runtime builds each eye's projection matrix, so its depth range has to
  // be set from the same draw distance the settings use - otherwise XR renders
  // with the runtime's own far plane, not the player's.
  const far = Math.max(64, store.options.distance || 0) || 192;
  s.updateRenderState({ baseLayer: layer, depthNear: 0.1, depthFar: far });
  // The eye viewports are in the layer's framebuffer pixels, not the canvas's:
  // the UI rect math needs that space to put the HUD in the same spot in both
  // eyes instead of doubling it.
  if (layer.framebufferWidth > 0 && layer.framebufferHeight > 0) {
    renderer.presentBounds = { w: layer.framebufferWidth, h: layer.framebufferHeight };
  }
  // The new UI (menus, lobby, room menu) on a world-space panel + gaze cursor.
  const panel = new VrPanel(gl);
  const cursor = new GazeCursor(gl);
  let gaze: GazePointer | null = null;
  let gazeUi: ScreenUi | null = null;
  let selectQueued = false;
  const refSpace = await s.requestReferenceSpace('local');
  const head = mat4.create();
  const chase = mat4.create();
  let last = 0;

  const loop = (time: number, frame: XRFrame): void => {
    if (!session) return;
    session.requestAnimationFrame(loop);
    const dt = last ? Math.min(50, time - last) : 16;
    last = time;
    const instance = getInstance();
    const pose = frame.getViewerPose(refSpace);
    if (!instance || !pose) return;
    // Re-centering: the head yaw that maps to "forward" is the one recorded
    // when VR starts, or the one recorded on a tap/trigger in a match (menus
    // use select for clicks instead).
    if (pose.views.length > 0) {
      const m = pose.views[0].transform.matrix;
      latestHeadYawAbs = Math.atan2(m[8], m[10]);
      if (!initialized) { baselineYawAbs = latestHeadYawAbs; initialized = true; }
    }
    // Keep the engine's far plane (fog falloff, fog/soft-particle range,
    // culling) on the settings value too; the projection comes from the pose.
    renderer.camera.far = far;
    // Simulate normally: this also positions the chase camera behind the ship.
    const fullW = gl.drawingBufferWidth;
    const fullH = gl.drawingBufferHeight;
    instance.canvasW = fullW;
    instance.canvasH = fullH;
    const inMenu = !store.interactive;
    // Background/menu scenes still orbit their camera; only real matches freeze.
    if (instance.gameType === 'BACK' || (!store.paused && !inMenu)) instance.update(dt);
    syncHud(instance);
    // The new UI overlay (MenuUi/LobbyUi/RoomUi) becomes a texture + panel.
    const ui = renderer.uiOverlay;
    if (ui) {
      panel.update(ui);
      if (ui !== gazeUi) {
        gazeUi = ui;
        gaze = new GazePointer(ui, panel.width, panel.height);
      }
    } else if (gaze) {
      // A match has no ScreenUi (the HUD is drawn separately): drop the hover.
      gaze.reset();
      gaze = null;
      gazeUi = null;
    }
    // The panel follows the base view (not the head): the headset's gaze ray
    // then sweeps across a stable panel, which is what a crosshair needs.
    const basis = panelBasis(renderer.camera.position, renderer.camera.direction, PANEL_DISTANCE);
    mat4.copy(chase, renderer.camera.view);
    const cam = renderer.camera;
    // Each eye goes through the whole normal pipeline (scene target, scene
    // draw, composite) but the composite blits into the WebXR base layer with
    // that eye's viewport instead of the canvas. Drawing only the scene left
    // the eyes black: the composite is what produces the final image.
    gl.disable(gl.SCISSOR_TEST);
    for (let vi = 0; vi < pose.views.length; vi++) {
      const view = pose.views[vi];
      const vp = layer.getViewport(view);
      if (!vp || vp.width <= 0 || vp.height <= 0) continue;
      mat4.invert(head, view.transform.matrix);
      // yaw-only re-center: looking the way you did when VR started (or when
      // you last tapped) gives the unrotated chase view.
      mat4.rotateY(head, head, baselineYawAbs);
      mat4.multiply(cam.view, head, chase);           // head rotation over the chase view
      mat4.copy(cam.proj, view.projectionMatrix);
      mat4.multiply(cam.viewProj, cam.proj, cam.view);
      renderer.viewport = { x: vp.x, y: vp.y, w: vp.width, h: vp.height };
      renderer.presentFbo = layer.framebuffer;
      // The per-eye UI rect is applied where the pixels land (see below), so
      // the composite itself carries no UI.
      renderer.beginFrame();   // scene target + frustum for this eye
      instance.draw();         // stages 1-3 into their targets
      // Per-eye HUD in the eye's own rect (same relative position both eyes).
      instance.canvasW = Math.max(1, vp.width);
      instance.canvasH = Math.max(1, vp.height);
      syncHud(instance);
      // Stage 5 rides the final pass now, so the per-eye overlay hook is
      // gone; the HUD stays sharp while the world zoom-blurs behind it.
      renderer.endFrame(null);
      if (renderer.renderOptions.zoom > 0) {
        instance.drawShipsSharp(layer.framebuffer, { x: vp.x, y: vp.y, w: vp.width, h: vp.height });
      }
      // HUD straight into this eye's rectangle - the same math as the
      // crosshair and as the split view, so both eyes can only match.
      renderer.drawHudTo(layer.framebuffer, { x: vp.x, y: vp.y, w: vp.width, h: vp.height }, store.hud);
      if (ui && gaze) {
        // The panel is drawn last, over the HUD, in this eye's rectangle.
        const eyeView = cam.view as unknown as Float32Array;
        const eyeProj = cam.proj as unknown as Float32Array;
        gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(vp.x, vp.y, vp.width, vp.height);
        gl.viewport(vp.x, vp.y, vp.width, vp.height);
        // Gaze ray from this eye's view matrix: origin = inverse translation,
        // direction = -Z of the camera basis.
        const inv = mat4.create();
        mat4.invert(inv, cam.view);
        const origin = vec3.fromValues(inv[12], inv[13], inv[14]);
        const ray = vec3.normalize(vec3.create(), vec3.fromValues(-eyeView[2], -eyeView[6], -eyeView[10]));
        const hit = hitPanel(origin, ray, basis, PANEL_WIDTH, PANEL_HEIGHT, panel.width, panel.height);
        if (vi === 0) {
          // One pointer/dwell state for the UI; the left eye aims it.
          gaze.update(hit, dt);
          if (selectQueued) {
            gaze.click();
            selectQueued = false;
          }
          // A hover change bumps the UI version: repaint before drawing.
          panel.update(ui);
        }
        panel.draw(layer.framebuffer, eyeView, eyeProj, basis, PANEL_WIDTH, PANEL_HEIGHT);
        // Reticle at this eye's own hit (parallax-correct); a fixed distance
        // along the gaze when the panel does not fill that direction.
        const point = hit
          ? hit.point
          : vec3.scaleAndAdd(vec3.create(), origin, ray, PANEL_DISTANCE);
        const radius = Math.max(0.06, (hit ? hit.distance : PANEL_DISTANCE) * 0.032);
        const right = vec3.fromValues(eyeView[0], eyeView[4], eyeView[8]);
        const up = vec3.fromValues(eyeView[1], eyeView[5], eyeView[9]);
        cursor.draw(layer.framebuffer, eyeView, eyeProj, point, right, up, radius, gaze.progress);
      }
    }
    renderer.viewport = null;
    renderer.presentFbo = null;
    instance.canvasW = fullW;
    instance.canvasH = fullH;
  };
  s.requestAnimationFrame(loop);
  // A tap/trigger inside the session clicks the item under the crosshair; in a
  // match (no UI overlay) it re-centres the view instead.
  s.addEventListener('select', () => {
    if (renderer.uiOverlay) selectQueued = true;
    else baselineYawAbs = latestHeadYawAbs;
  });
  s.addEventListener('end', () => {
    panel.dispose();
    cursor.dispose();
    session = null;
    renderer.xrActive = false;
    renderer.presentBounds = null;
    baselineYawAbs = 0;
    latestHeadYawAbs = 0;
    initialized = false;
    if (!keepVrOnEnd) store.vr = false;
    keepVrOnEnd = false;
    onEnd();
  });
  return true;
}
