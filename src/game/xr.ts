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
// - the game HUD and every menu use one generic world-space UI scene
//   (src/engine/uiscene.ts): one 16:9 plane at the near/far midpoint, sized to
//   80% of the fullscreen frustum at that depth and anchored on the VR reset
//   origin. Menus paint their ScreenUi into it with the action column on and
//   keep the reset orientation, so the gaze ray can sweep them; the live game
//   paints the HUD into the same plane but rotates it with the head, so the
//   interface is always visible. The headset's gaze ray drives the UI's own
//   pointer handler; trigger clicks instantly, dwelling (2 s by default,
//   configurable in Options) selects without a controller. There is no
//   separate VR menu.
import { mat4, vec3 } from '../engine/math';
import type { GameInstance } from './instance';
import { store } from './store';
import { AIM_URL } from '../engine/hud3d';
import { applyTeamColors } from './colors';
import { partyPlayerColor, updateParty } from './party';
import { syncHud } from './hud';
import { extractFrustum } from '../engine/frustum';
import {
  GazeCursor, GazePointer, PANEL_H, PANEL_W, cyclopsView, hitPanel, panelBasis,
  projectedPlaneQuad, projectedPlaneRect, viewPanelBasis, withClipRect,
} from '../engine/vrpanel';
import type { PanelBasis } from '../engine/vrpanel';
import { UiScene } from '../engine/uiscene';
import type { ScreenUi } from '../engine/overlay';
import { isVrLongPress, VR_LONG_PRESS_MS } from './vr';

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
  // selectstart/selectend bracket the trigger press that ends in `select`.
  addEventListener(
    type: 'select' | 'selectstart' | 'selectend' | 'end',
    cb: () => void,
  ): void;
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

/**
 * Clone an eye projection and move only its near clip inward. Keeps m[0]/m[5]/
 * m[8]/m[9] untouched, so the UI plane has exactly the same x/y projection as
 * the scene but a plane closer than the runtime's near plane is not clipped.
 */
function uiProjection(out: mat4, eyeProj: Float32Array, far: number): Float32Array {
  mat4.copy(out, eyeProj as unknown as mat4);
  const near = UI_NEAR;
  out[10] = -(far + near) / (far - near);
  out[14] = -2 * far * near / (far - near);
  out[11] = -1;
  return out as unknown as Float32Array;
}

/**
 * View-space offset of the NDC centre for one projection: the direction
 * `(m[8]/m[0], m[9]/m[5])` is where the screen centre sits relative to the
 * view axis. Averaged over the eyes, it centres the shared plane in the fused
 * view instead of on the raw forward axis.
 */
function projectionCenter(projections: ArrayLike<number>[]): { x: number; y: number } {
  let sx = 0, sy = 0, n = 0;
  for (const p of projections) {
    const m0 = Math.abs(p[0] ?? 0);
    const m5 = Math.abs(p[5] ?? 0);
    if (!(m0 > 1e-6) || !(m5 > 1e-6)) continue;
    sx += (p[8] ?? 0) / m0;
    sy += (p[9] ?? 0) / m5;
    n++;
  }
  return n > 0 ? { x: sx / n, y: sy / n } : { x: 0, y: 0 };
}

/**
 * Average x/y projection scale (`m[0]`, `m[5]`) across the eyes. At distance
 * `d` the fullscreen frustum height is `2d / m[5]` and width `2d / m[0]`.
 */
function projectionScale(projections: ArrayLike<number>[]): { x: number; y: number } {
  let sx = 0, sy = 0, n = 0;
  for (const p of projections) {
    const m0 = Math.abs(p[0] ?? 0);
    const m5 = Math.abs(p[5] ?? 0);
    if (!(m0 > 1e-6) || !(m5 > 1e-6)) continue;
    sx += m0;
    sy += m5;
    n++;
  }
  return n > 0 ? { x: sx / n, y: sy / n } : { x: 1, y: 1 };
}

/** One UI plane for every scene (menus and game).
 *
 * The plane sits at the midpoint between the camera's near and far planes and
 * is sized to 80% of the frustum's fullscreen rectangle at that depth. Every
 * scene draws into that same plane:
 *   - menus keep the default (reset/initialised) orientation, so the plane
 *     stays still and the gaze ray sweeps it;
 *   - the game UI rotates the plane with the head so it is always visible.
 * The plane's centre is the VR reset origin, projected along the default view
 * forward by the midpoint distance. */
const UI_PLANE_SCALE = 0.8;
/** The UI keeps the eye's exact x/y projection but uses a near depth clip
 *  smaller than the eye runtime's, so the plane is never clipped even when
 *  the reset origin is close to the viewer. */
const UI_NEAR = 0.01;
/** Short screen-space feather for the immersive focus veil. */
const UI_FOCUS_FEATHER = 0.03;

let session: XRSession | null = null;
let keepVrOnEnd = false;
let entering = false;
let baselineYawAbs = 0;
let latestHeadYawAbs = 0;
let initialized = false;
/** Default (reset) VR origin the single UI plane is anchored to. */
let resetCenter: vec3 | null = null;

/**
 * The XR session owns the simulation loop, so a match can finish without the
 * page's requestAnimationFrame callback running. GameCanvas registers the
 * handler that stores the result and navigates to victory/defeat.
 */
let onMatchEnd: (() => void) | null = null;

export function setXrMatchEndHandler(handler: (() => void) | null): void {
  onMatchEnd = handler;
}

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
 * End the session. `keepVr` keeps the app in VR mode (split view without a
 * headset session). Pausing no longer ends the session: the pause menu is the
 * same world-space ScreenUi panel as every other menu.
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
    focusRect: { x: number; y: number; w: number; h: number } | null;
    focusQuad: import('../engine/vrpanel').PlaneQuad | null;
    focusTint: [number, number, number];
    focusFeather: number;
    focusBorderEnabled: boolean;
    suppressUiFocusFallback: boolean;
    drawHudTo: (fbo: WebGLFramebuffer | null, rect: { x: number; y: number; w: number; h: number }, hud: typeof store.hud | null) => void;
    drawFocusBorder: (
      fbo?: WebGLFramebuffer | null,
      view?: { x: number; y: number; w: number; h: number } | null,
    ) => void;
    prepareHud: (hud: typeof store.hud | null) => void;
    drawHudPlane: (
      fbo: WebGLFramebuffer | null, view: Float32Array, proj: Float32Array,
      center: vec3, right: vec3, up: vec3, halfW: number, halfH: number,
    ) => void;
    sampleFrame: (dtMs: number) => void;
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
  // Head-tracked view: the chase base follows the ship's up vector, so the
  // headset rotates with the spaceship (including its roll).
  const gl = renderer.gl;
  await (gl as unknown as { makeXRCompatible(): Promise<void> }).makeXRCompatible();
  const layer = new XRWebGLLayer(s, gl);
  // The fitted panels need a shorter veil ramp than the flat screens. Keep the
  // page renderer's value and put it back when the session ends.
  const previousFocusFeather = renderer.focusFeather;
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
  // One generic UI scene: the same plane carries the HUD and every menu. A
  // driver that rejects the small shaders must not kill the session: the world
  // still renders and the fallback HUD path remains available below.
  let uiScene: UiScene | null = null;
  let cursor: GazeCursor | null = null;
  try {
    uiScene = new UiScene(gl);
  } catch {
    uiScene = null;
  }
  try {
    cursor = new GazeCursor(gl);
    // Menu gaze cursor uses the same `_aim.png` crosshair as the spaceship HUD.
    const aimIcon = new Image();
    aimIcon.crossOrigin = 'anonymous';
    aimIcon.onload = () => cursor?.setIcon(aimIcon);
    aimIcon.src = AIM_URL;
  } catch {
    cursor = null;
  }
  let gaze: GazePointer | null = null;
  let gazeUi: ScreenUi | null = null;
  let selectQueued = false;
  let calibrateQueued = false;
  // Long-press pause: selectstart/selectend bracket the trigger press, and a
  // hold past the shared threshold pauses a live match. The release then
  // must not click the UI or re-centre the view behind the pause menu.
  let pressStarted = 0;
  let pressTimer = 0;
  let pressActive = false;
  let suppressRelease = false;
  const clearPress = (): void => {
    if (pressTimer) {
      window.clearTimeout(pressTimer);
      pressTimer = 0;
    }
    pressActive = false;
  };
  const refSpace = await s.requestReferenceSpace('local');
  const head = mat4.create();
  const chase = mat4.create();
  let last = 0;
  /** True once a match frame has been drawn; used to re-anchor on exit. */
  let wasInMatch = false;

  const loop = (time: number, frame: XRFrame): void => {
    if (!session) return;
    session.requestAnimationFrame(loop);
    const dt = last ? Math.min(50, time - last) : 16;
    last = time;
    // The session's own cadence (the page rAF is paused/throttled in XR).
    renderer.sampleFrame(dt);
    updateParty(store.options, dt);
    // The world-space menu/lobby/room follows the same live accent as the HUD.
    renderer.uiOverlay?.syncAccent?.(performance.now());
    const instance = getInstance();
    if (instance) applyTeamColors(instance, store.options, partyPlayerColor(store.options));
    // Keep the focus veil on the chosen player colour even when the page rAF
    // is throttled by the headset.
    const tint = instance?.selectedObject?.team?.color ?? partyPlayerColor(store.options);
    renderer.focusTint[0] = tint[0];
    renderer.focusTint[1] = tint[1];
    renderer.focusTint[2] = tint[2];
    // The immersive plane is the only focus island; never fall back to the
    // flat UI rectangle when it is projected off-screen.
    renderer.suppressUiFocusFallback = true;
    const pose = frame.getViewerPose(refSpace);
    if (!instance || !pose) return;
    const projections = pose.views.map((v) => v.projectionMatrix);
    // The one UI plane: centred at the midpoint between the camera's near and
    // far planes, as 80% of the fullscreen frustum rectangle at that depth.
    const midDistance = Math.max(renderer.camera.near + 1e-3, (renderer.camera.near + far) / 2);
    const pscale = projectionScale(projections);
    const planeW = (2 * midDistance / pscale.x) * UI_PLANE_SCALE;
    const planeH = (2 * midDistance / pscale.y) * UI_PLANE_SCALE;
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
    if (store.paused) {
      // Frozen match: poll the pad only, so START can resume from the headset.
      instance.control.update(instance.canvasW, instance.canvasH);
      if (instance.control.pauseRequested) {
        instance.control.pauseRequested = false;
        store.paused = false;
      }
    } else if (instance.gameType === 'BACK' || !inMenu) {
      instance.update(dt);
      if (instance.control.pauseRequested) {
        instance.control.pauseRequested = false;
        if (store.interactive) store.paused = true;
      }
    }
    // The session loop, not the page rAF, produced this frame: hand a finished
    // match to GameCanvas so it can route to the results screen. The session
    // stays live across that route: the result menu is a ScreenUi like every
    // other menu, so the next frame draws it on the world-space panel. Without
    // this the world stays frozen on the last match frame with no accessible
    // menu.
    if (instance.result && store.route === 'game' && onMatchEnd) {
      onMatchEnd();
      return;
    }
    // One UI plane serves both modes. A menu/pause screen is a ScreenUi panel
    // on the base view; a live match paints the HUD into the same plane. The
    // scene-level action column is on for menus and off for the game; it is
    // switched here, programmatically, every frame.
    // A paused match is a menu frame: the pause ScreenUi panel is the only
    // overlay, and the HUD is rebuilt only after resuming.
    const inMatch = store.interactive && instance.gameType !== 'BACK' && !store.paused;
    // Ship-up chase base for the scene and the menu plane; the head pose is
    // composed per eye, so head rotation follows the spaceship's rotation.
    renderer.camera.chaseView(chase);
    const cam = renderer.camera;
    const ui = renderer.uiOverlay;
    // Never let a stale menu overlay steal controls while a match is live; it
    // only counts as a menu outside a match or while paused.
    const menuUi = ui && (!store.interactive || store.paused) ? ui : null;
    // The rendered eye cameras are not at the chase camera's position (the
    // head pose offsets them), so capture the rendered head centre; it becomes
    // the VR reset origin the one UI plane is anchored to.
    const cyclops = pose.views.length > 0
      ? cyclopsView(pose.views.map((v) => v.transform.matrix), baselineYawAbs, chase)
      : null;
    // Menus keep the reset orientation so the gaze ray can sweep a still
    // plane; the live HUD rotates the same plane with the head (set below) so
    // it stays in front of the user. Both share the same centre, distance,
    // size and focus feather.
    if (inMatch) {
      wasInMatch = true;
    } else if (menuUi && wasInMatch) {
      // Just returned from a match: re-anchor the menu plane at the current
      // head position so the player is looking straight at the menu.
      resetCenter = cyclops ? vec3.clone(cyclops.center) : null;
      wasInMatch = false;
    }
    const ndcCenter = projectionCenter(projections);
    // Remember the reset/initialised origin and orientation; the single plane
    // is anchored there. Both scenes then use the exact same plane, distance
    // and size, with only the rotation decided per scene.
    if (cyclops && !resetCenter) {
      resetCenter = vec3.clone(cyclops.center);
    }
    const defaultCenter = resetCenter ?? cyclops?.center ?? cam.position;
    // Menus keep the base/chase orientation (upright, not head-rotated).
    const menuBasis = viewPanelBasis(
      chase, defaultCenter, midDistance, ndcCenter.x, ndcCenter.y,
    );
    // The game UI rotates the plane with the head around the reset origin; the
    // menus keep the reset orientation so the gaze ray can sweep a still plane.
    // Game UI: fixed in front of the camera; same position and rotation as the
    // head/camera view, so it always faces the user.
    const gameBasis = cyclops
      ? viewPanelBasis(cyclops.view, cyclops.center, midDistance, ndcCenter.x, ndcCenter.y)
      : menuBasis;
    let planeBasis: PanelBasis | null = menuUi || inMatch
      ? (menuUi ? menuBasis : gameBasis)
      : null;
    /** The renderer's own HUD texture is used only if UiScene failed to build. */
    let hudFallback = false;
    // Only menus draw the focus frame; the live HUD is borderless.
    renderer.focusBorderEnabled = true;
    if (menuUi) {
      if (uiScene) {
        uiScene.setActions(true);
        uiScene.setMenu(menuUi);
      }
      if (menuUi !== gazeUi) {
        gazeUi = menuUi;
        gaze = new GazePointer(menuUi, PANEL_W, PANEL_H, store.options.dwellTime * 1000);
      }
    } else if (inMatch && cyclops) {
      renderer.focusBorderEnabled = false;
      // Game UI on the same plane, but with the plane rotated by the current
      // head pose around the reset origin, so it is always visible. Paint the
      // 16:9 texture with a camera looking along the rotated plane normal from
      // that origin; the texture centre then lands on the plane centre.
      const hudCenter = cyclops.center;
      const forward = vec3.negate(vec3.create(), gameBasis.normal);
      const target = vec3.add(vec3.create(), hudCenter, forward);
      const hudFittedFov = 2 * Math.atan((planeH * 0.5) / midDistance);
      const basePos = vec3.clone(cam.position);
      const baseLook = vec3.clone(cam.lookAt);
      const baseUp = vec3.clone(cam.up);
      vec3.copy(cam.position, hudCenter);
      vec3.copy(cam.up, gameBasis.up);
      vec3.copy(cam.direction, forward);
      vec3.copy(cam.side, gameBasis.right);
      mat4.lookAt(cam.view, hudCenter, target, gameBasis.up);
      mat4.perspective(
        cam.proj, hudFittedFov, PANEL_W / PANEL_H, UI_NEAR,
        Math.max(far, midDistance * 2),
      );
      // Paint the HUD with the same principal point as the plane placement:
      // the texture centre must land on the NDC centre, not the raw view axis.
      cam.proj[8] = ndcCenter.x * cam.proj[0];
      cam.proj[9] = ndcCenter.y * cam.proj[5];
      mat4.multiply(cam.viewProj, cam.proj, cam.view);
      extractFrustum(cam.viewProj, renderer.frustum);
      instance.canvasW = PANEL_W;
      instance.canvasH = PANEL_H;
      syncHud(instance);
      if (uiScene) {
        uiScene.setActions(false);
        uiScene.setHud(store.hud);
      } else {
        hudFallback = true;
        renderer.prepareHud(store.hud);
      }
      // Restore the chase camera for the per-eye scene pass (the loop replaces
      // the eye view/projection itself).
      vec3.copy(cam.position, basePos);
      vec3.copy(cam.lookAt, baseLook);
      vec3.copy(cam.up, baseUp);
      cam.updateMatrices();
    } else if (uiScene) {
      uiScene.setHud(null);
      renderer.focusBorderEnabled = true;
    }
    if (!ui && gaze) {
      // The HUD mode has no ScreenUi: drop the hover/dwell state.
      gaze.reset();
      gaze = null;
      gazeUi = null;
    }
    // Each eye goes through the whole normal pipeline (scene target, scene
    // draw, composite) but the composite blits into the WebXR base layer with
    // that eye's viewport instead of the canvas. Drawing only the scene left
    // the eyes black: the composite is what produces the final image.
    gl.disable(gl.SCISSOR_TEST);
    for (let vi = 0; vi < pose.views.length; vi++) {
      const view = pose.views[vi];
      const vp = layer.getViewport(view);
      if (!vp || vp.width <= 0 || vp.height <= 0) continue;
      // Never inherit a clip rect: the panel below scopes its own, and a
      // leftover scissor would black out this eye's scene composite.
      gl.disable(gl.SCISSOR_TEST);
      mat4.invert(head, view.transform.matrix);
      // yaw-only re-center: looking the way you did when VR started (or when
      // you last tapped) gives the unrotated chase view.
      mat4.rotateY(head, head, baselineYawAbs);
      mat4.multiply(cam.view, head, chase);           // head rotation over the chase view
      mat4.copy(cam.proj, view.projectionMatrix);
      mat4.multiply(cam.viewProj, cam.proj, cam.view);
      renderer.viewport = { x: vp.x, y: vp.y, w: vp.width, h: vp.height };
      renderer.presentFbo = layer.framebuffer;
      // Snapshot the eye matrices: the scene passes below may touch the
      // camera, and the UI/cursor must use exactly this eye's view.
      const eyeView = mat4.clone(cam.view) as unknown as Float32Array;
      const eyeProj = mat4.clone(cam.proj) as unknown as Float32Array;
      // The UI is closer than the runtime near plane; keep the eye's x/y
      // projection but use a nearer depth clip for every UI pass.
      const uiProj = uiProjection(mat4.create(), eyeProj, Math.max(cam.far, midDistance * 2));
      // The one UI plane is the sharp island: project it into this eye and
      // blur/tint the scene outside it. Menus are viewed obliquely when the
      // head turns, so stroke their real projected quad (the HUD is
      // fronto-parallel, which is the same path with a rectangle-like quad).
      // Both modes use the same feather.
      const planeQuad = planeBasis
        ? projectedPlaneQuad(
          eyeView, uiProj, planeBasis.center, planeBasis.right, planeBasis.up,
          planeW * 0.5, planeH * 0.5,
        )
        : null;
      const planeFocus = planeBasis
        ? projectedPlaneRect(
          eyeView, uiProj, planeBasis.center, planeBasis.right, planeBasis.up,
          planeW * 0.5, planeH * 0.5,
        )
        : null;
      renderer.focusRect = planeFocus;
      renderer.focusQuad = planeQuad;
      renderer.focusFeather = planeFocus ? UI_FOCUS_FEATHER : previousFocusFeather;
      // The per-eye UI rect is applied where the pixels land (see below), so
      // the composite itself carries no UI.
      renderer.beginFrame();   // scene target + frustum for this eye
      instance.draw();         // stages 1-3 into their targets
      // Stage 5 rides the final pass now, so the per-eye overlay hook is
      // gone; the HUD stays sharp while the world zoom-blurs behind it.
      renderer.endFrame(null);
      if (renderer.renderOptions.zoom > 0) {
        instance.drawShipsSharp(layer.framebuffer, { x: vp.x, y: vp.y, w: vp.width, h: vp.height });
      }
      // The one plane carries the menu (and its gaze cursor) or the HUD. It is
      // drawn after the composite in this eye's rectangle.
      const scene = uiScene;
      if (ui && planeBasis && scene && scene.ready) {
        // The loop mutates these; capture the non-null values for the closure.
        const aim = gaze;
        const pointer = cursor;
        const look = planeBasis;
        gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
        withClipRect(gl, { x: vp.x, y: vp.y, w: vp.width, h: vp.height }, () => {
          // Gaze ray from this eye's view matrix: origin = inverse
          // translation, direction = the view-space ray that lands on the NDC
          // centre. Using -Z alone would aim the crosshair at the projection's
          // principal point, which is off-centre on asymmetric XR eyes.
          const inv = mat4.create();
          mat4.invert(inv, eyeView as unknown as mat4);
          const origin = vec3.fromValues(inv[12], inv[13], inv[14]);
          // Raw camera direction for this eye; its projection per eye is the
          // crosshair position (this is what makes the stereo pair match).
          const ray = vec3.normalize(
            vec3.create(), vec3.fromValues(-eyeView[2], -eyeView[6], -eyeView[10]),
          );
          const hit = aim && pointer
            ? hitPanel(origin, ray, look, planeW, planeH, scene.width, scene.height)
            : null;
          if (vi === 0 && aim && pointer) {
            // One pointer/dwell state for the UI; the left eye aims it.
            // Options can change while the panel is open, so refresh live.
            aim.setDwellMs(store.options.dwellTime * 1000);
            aim.update(hit, dt);
            if (selectQueued) {
              aim.click();
              selectQueued = false;
            }
            // A hover change bumps the UI version: repaint before drawing.
            scene.setMenu(ui);
          }
          scene.draw(layer.framebuffer, eyeView, uiProj, look, planeW, planeH);
          if (pointer) {
            // Project the camera direction (through the world hit, or the
            // plane midpoint when it misses) with this eye's own view/proj:
            // the crosshair sits where that eye's camera direction points.
            const point = hit
              ? hit.point
              : vec3.scaleAndAdd(vec3.create(), origin, ray, midDistance);
            const mv = mat4.multiply(
              mat4.create(), uiProj as unknown as mat4, eyeView as unknown as mat4,
            );
            const cx = mv[0] * point[0] + mv[4] * point[1] + mv[8] * point[2] + mv[12];
            const cy = mv[1] * point[0] + mv[5] * point[1] + mv[9] * point[2] + mv[13];
            const cw = mv[3] * point[0] + mv[7] * point[1] + mv[11] * point[2] + mv[15];
            const sizePx = Math.min(vp.width, vp.height) * 0.02;
            pointer.drawScreen(
              layer.framebuffer, vp.width, vp.height,
              cw !== 0 ? cx / cw : 0, cw !== 0 ? cy / cw : 0,
              sizePx,
              aim && aim.hasTarget ? aim.progress : 0,
              renderer.focusTint,
            );
          }
        });
      } else if (inMatch && planeBasis) {
        if (scene && scene.ready) {
          const look = planeBasis;
          withClipRect(gl, { x: vp.x, y: vp.y, w: vp.width, h: vp.height }, () => {
            scene.draw(layer.framebuffer, eyeView, uiProj, look, planeW, planeH);
          });
        } else if (hudFallback) {
          const look = planeBasis;
          withClipRect(gl, { x: vp.x, y: vp.y, w: vp.width, h: vp.height }, () => {
            renderer.drawHudPlane(
              layer.framebuffer, eyeView, uiProj,
              look.center, look.right, look.up, planeW * 0.5, planeH * 0.5,
            );
          });
        }
      }
      // The world-space plane is drawn after the composite, so its own pass
      // must carry the player-colour focus frame as well.
      renderer.drawFocusBorder(layer.framebuffer, {
        x: vp.x, y: vp.y, w: vp.width, h: vp.height,
      });
    }
    // Apply a queued trigger/tap recalibration once both eyes are done: the
    // click used the current view, and the next frame faces the head's
    // current heading. Per-eye timing cannot skew the stereo pair.
    if (calibrateQueued) {
      baselineYawAbs = latestHeadYawAbs;
      calibrateQueued = false;
      // Re-anchor the single plane where the user just reset the view.
      if (cyclops) resetCenter = vec3.clone(cyclops.center);
    }
    if (!ui) selectQueued = false;
    renderer.viewport = null;
    renderer.presentFbo = null;
    // The per-eye focus rect belongs to the frame just drawn; do not let it
    // leak into the page's non-XR fallback renderer.
    renderer.focusRect = null;
    renderer.focusQuad = null;
    instance.canvasW = fullW;
    instance.canvasH = fullH;
  };
  s.requestAnimationFrame(loop);
  // A tap/trigger inside the session clicks the item under the crosshair; in a
  // match (no UI overlay) it re-centres the view instead. Holding it pauses.
  s.addEventListener('selectstart', () => {
    if (pressActive) return; // one timer per press, even with several sources
    pressActive = true;
    pressStarted = performance.now();
    suppressRelease = false;
    pressTimer = window.setTimeout(() => {
      pressTimer = 0;
      if (!pressActive || !session) return;
      if (!isVrLongPress(performance.now() - pressStarted)) return;
      // Only a live match pauses: inside the menus a hold is still a click.
      if (!store.interactive || store.paused) return;
      suppressRelease = true;
      // Drop anything queued by an earlier press so the session ends cleanly.
      selectQueued = false;
      calibrateQueued = false;
      // GameCanvas swaps renderer.uiOverlay to the WebGL pause menu; the
      // immersive session stays live and draws that panel in both eyes.
      store.paused = true;
    }, VR_LONG_PRESS_MS);
  });
  s.addEventListener('selectend', () => {
    clearPress();
  });
  s.addEventListener('select', () => {
    if (suppressRelease) {
      suppressRelease = false;
      clearPress();
      return;
    }
    clearPress();
    // Every short trigger/tap recalibrates the view, in menus and in a match
    // alike. Recalibration applies after the UI click in the next frame.
    calibrateQueued = true;
    if (renderer.uiOverlay) selectQueued = true;
  });
  s.addEventListener('end', () => {
    clearPress();
    suppressRelease = false;
    uiScene?.dispose();
    cursor?.dispose();
    session = null;
    renderer.xrActive = false;
    renderer.presentBounds = null;
    renderer.focusRect = null;
    renderer.focusQuad = null;
    renderer.focusFeather = previousFocusFeather;
    renderer.focusBorderEnabled = true;
    renderer.suppressUiFocusFallback = false;
    baselineYawAbs = 0;
    latestHeadYawAbs = 0;
    initialized = false;
    resetCenter = null;
    if (!keepVrOnEnd) store.vr = false;
    keepVrOnEnd = false;
    onEnd();
  });
  return true;
}
