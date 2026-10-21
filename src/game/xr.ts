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
//   (2 s by default, configurable in Options) selects without a controller.
//   There is no separate VR menu.
import { mat4, vec3 } from '../engine/math';
import type { GameInstance } from './instance';
import { store } from './store';
import { applyTeamColors } from './colors';
import { partyPlayerColor, updateParty } from './party';
import { syncHud } from './hud';
import { extractFrustum } from '../engine/frustum';
import {
  GazeCursor, GazePointer, PANEL_H, PANEL_W, VrPanel, cyclopsView, hitPanel, panelBasis,
  planeFitScale, projectedPlaneRect, withClipRect,
} from '../engine/vrpanel';
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

/** Menu panel placement in world units.
 *
 * The panel used to sit 3 m ahead at 8 x 4.5 m. Both distance and world size
 * are now halved, so it is physically closer (more comfortable stereo depth
 * and less vergence) while projecting exactly the same rectangle in each eye.
 * Keep these two constants in step: changing only one changes the on-screen
 * size and the focus rectangle with it. */
const PANEL_DISTANCE = 1.5;
/** The non-interactive HUD keeps its earlier 0.75 m placement: it is already
 *  closer than the menu and its own focus rectangle must not move. */
const HUD_DISTANCE = 0.75;
/**
 * The HUD keeps the world size it had at 1.5 units while sitting at half that
 * distance, so it subtends twice the angle. The projection used to paint it is
 * widened by the same factor, so the painted aim/markers still land at the
 * correct angle on the quieter, bigger panel. The result is then fitted to the
 * eye's projection so the focus frame and the world veil remain visible around
 * it instead of running off the sides of the headset view.
 */
const HUD_FOV_SCALE = 2;
const PANEL_WIDTH = 4;
const PANEL_HEIGHT = PANEL_WIDTH * (PANEL_H / PANEL_W);
/** Fraction of the eye's half-view a panel may occupy. The remaining margin
 *  is what makes the 2 px frame and the blurred veil outside it visible. */
const PANEL_FIT = 0.86;
/** XR has only a thin margin around the fitted panel; a shorter ramp reaches
 *  full veil strength before the eye edge instead of fading out.
 *
 * This is a screen-space feather, not a world-space width. Halving the panel
 * distance and its world size together leaves `projectedPlaneRect()` and thus
 * the focus rectangle unchanged, so the blur ramp keeps exactly its previous
 * screen calibration. */
const XR_FOCUS_FEATHER = 0.05;

let session: XRSession | null = null;
let keepVrOnEnd = false;
let entering = false;
let baselineYawAbs = 0;
let latestHeadYawAbs = 0;
let initialized = false;

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
    focusTint: [number, number, number];
    focusFeather: number;
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
  // The new UI (menus, lobby, room menu) on a world-space panel + gaze cursor.
  // A driver that rejects the small shaders must not kill the session: the
  // world and HUD still render, only the panel is missing.
  let panel: VrPanel | null = null;
  let cursor: GazeCursor | null = null;
  try {
    panel = new VrPanel(gl);
    cursor = new GazeCursor(gl);
  } catch {
    panel = null;
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
    const pose = frame.getViewerPose(refSpace);
    if (!instance || !pose) return;
    const projections = pose.views.map((v) => v.projectionMatrix);
    // Fit the quad inside each eye instead of letting its side edges cross the
    // viewport. At the old fixed 8x4.5 units/3 m the panel subtended ~106
    // degrees, so on a typical headset its projected rectangle was wider than
    // the eye: the side frame strokes fell off-screen and almost the whole
    // view was "inside", leaving no outside area to blur.
    const panelScale = planeFitScale(
      projections, PANEL_WIDTH, PANEL_HEIGHT, PANEL_DISTANCE, PANEL_FIT,
    );
    const panelW = PANEL_WIDTH * panelScale;
    const panelH = PANEL_HEIGHT * panelScale;
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
    // In-match HUD: a head-locked plane at 0.75 m, close to the camera. It is
    // painted ONCE with the cyclops (head-centre) view and drawn in each eye,
    // so the score/time/items stay fixed to the head rotation and the
    // aim/markers keep their positions. The menu panel moved closer to 1.5 m,
    // but the HUD stays at its previous (already close) distance so its screen
    // rectangle is unchanged. Its painted projection is widened 2x so the
    // texture still covers that rectangle.
    // A paused match is a menu frame: the pause ScreenUi panel is the only
    // overlay, and the head-locked HUD is rebuilt only after resuming.
    const inMatch = store.interactive && instance.gameType !== 'BACK' && !store.paused;
    // Ship-up chase base for the scene and the menu panel; the head pose is
    // composed per eye, so head rotation follows the spaceship's rotation.
    renderer.camera.chaseView(chase);
    let hudBoard: { center: vec3; right: vec3; up: vec3 } | null = null;
    let hudHalfW = 0;
    let hudHalfH = 0;
    if (inMatch && pose.views.length > 0) {
      const cam = renderer.camera;
      const hudH = 900;
      const hudW = Math.max(2, Math.round(hudH * Math.max(1, cam.aspect)));
      // The rendered eye views (head compose + ship-up chase) averaged into
      // the cyclops HUD view. This must use the *composed* positions: the raw
      // room poses are not where the chase camera renders the head.
      const cyclops = cyclopsView(
        pose.views.map((v) => v.transform.matrix), baselineYawAbs, chase,
      );
      const hudView = cyclops.view;
      const hx = cyclops.center[0], hy = cyclops.center[1], hz = cyclops.center[2];
      const hudRight = vec3.fromValues(hudView[0], hudView[4], hudView[8]);
      const hudUp = vec3.fromValues(hudView[1], hudView[5], hudView[9]);
      const hudFwd = vec3.fromValues(-hudView[2], -hudView[6], -hudView[10]);

      // Project the snapshot through that head view with a widened
      // perspective: the plane fills the same angles as the painted texture.
      // Fit the resulting quad to the eye as well, and paint the HUD with the
      // fitted FOV so its markers still line up with the world.
      const hudFov = 2 * Math.atan(Math.tan(cam.fov / 2) * HUD_FOV_SCALE);
      const hudBaseHalfH = Math.tan(hudFov / 2) * HUD_DISTANCE;
      const hudBaseHalfW = hudBaseHalfH * (hudW / hudH);
      const hudScale = planeFitScale(
        projections, hudBaseHalfW * 2, hudBaseHalfH * 2, HUD_DISTANCE, PANEL_FIT,
      );
      const hudFittedFov = 2 * Math.atan(Math.tan(hudFov / 2) * hudScale);
      const basePos = vec3.clone(cam.position);
      const baseLook = vec3.clone(cam.lookAt);
      const baseUp = vec3.clone(cam.up);
      vec3.set(cam.position, hx, hy, hz);
      vec3.copy(cam.up, hudUp);
      vec3.copy(cam.direction, hudFwd);
      vec3.copy(cam.side, hudRight);
      mat4.copy(cam.view, hudView);
      mat4.perspective(cam.proj, hudFittedFov, hudW / hudH, cam.near, cam.far);
      mat4.multiply(cam.viewProj, cam.proj, cam.view);
      extractFrustum(cam.viewProj, renderer.frustum);
      instance.canvasW = hudW;
      instance.canvasH = hudH;
      syncHud(instance);
      renderer.prepareHud(store.hud);
      hudHalfH = Math.tan(hudFittedFov / 2) * HUD_DISTANCE;
      hudHalfW = hudHalfH * (hudW / hudH);
      hudBoard = {
        center: vec3.scaleAndAdd(vec3.create(), vec3.fromValues(hx, hy, hz), hudFwd, HUD_DISTANCE),
        right: hudRight,
        up: hudUp,
      };
      // Restore the chase camera for the scene and the menu panel.
      vec3.copy(cam.position, basePos);
      vec3.copy(cam.lookAt, baseLook);
      vec3.copy(cam.up, baseUp);
      cam.updateMatrices();
    }
    // The new UI overlay (MenuUi/LobbyUi/RoomUi) becomes a texture + panel.
    const ui = renderer.uiOverlay;
    if (ui && panel) {
      panel.update(ui);
      if (ui !== gazeUi) {
        gazeUi = ui;
        gaze = new GazePointer(ui, panel.width, panel.height, store.options.dwellTime * 1000);
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
      const eyeView = cam.view as unknown as Float32Array;
      const eyeProj = cam.proj as unknown as Float32Array;
      // World-space UI panels are the sharp island: project the menu panel (or
      // the head-locked HUD board) into this eye and blur/tint the scene
      // outside it. The panel is drawn after the composite, so its pixels are
      // never touched by the veil.
      const panelFocus = ui && panel
        ? projectedPlaneRect(
          eyeView, eyeProj, basis.center, basis.right, basis.up,
          panelW * 0.5, panelH * 0.5,
        )
        : null;
      const hudFocus = hudBoard
        ? projectedPlaneRect(
          eyeView, eyeProj, hudBoard.center, hudBoard.right, hudBoard.up, hudHalfW, hudHalfH,
        )
        : null;
      const focus = panelFocus ?? hudFocus ?? null;
      renderer.focusRect = focus;
      renderer.focusFeather = focus ? XR_FOCUS_FEATHER : previousFocusFeather;
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
      // HUD panel over the scene, in this eye, head-locked at HUD_DISTANCE.
      if (hudBoard) {
        const board = hudBoard;
        withClipRect(gl, { x: vp.x, y: vp.y, w: vp.width, h: vp.height }, () => {
          renderer.drawHudPlane(
            layer.framebuffer, eyeView, eyeProj,
            board.center, board.right, board.up, hudHalfW, hudHalfH,
          );
        });
      }
      if (ui && gaze && panel && cursor) {
        // The panel is drawn last, over the HUD, in this eye's rectangle.
        // withClipRect always clears the scissor afterwards: it must not
        // leak into the other eye's scene pass (that blacked out the right
        // eye while the menu itself still showed in both).
        // The loop mutates these; capture the non-null values for the closure.
        const aim = gaze;
        const board = panel;
        const pointer = cursor;
        gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
        withClipRect(gl, { x: vp.x, y: vp.y, w: vp.width, h: vp.height }, () => {
          // Gaze ray from this eye's view matrix: origin = inverse
          // translation, direction = -Z of the camera basis.
          const inv = mat4.create();
          mat4.invert(inv, cam.view);
          const origin = vec3.fromValues(inv[12], inv[13], inv[14]);
          const ray = vec3.normalize(vec3.create(), vec3.fromValues(-eyeView[2], -eyeView[6], -eyeView[10]));
          const hit = hitPanel(origin, ray, basis, panelW, panelH, board.width, board.height);
          if (vi === 0) {
            // One pointer/dwell state for the UI; the left eye aims it.
            // Options can change while the panel is open, so refresh live.
            aim.setDwellMs(store.options.dwellTime * 1000);
            aim.update(hit, dt);
            if (selectQueued) {
              aim.click();
              selectQueued = false;
            }
            // A hover change bumps the UI version: repaint before drawing.
            board.update(ui);
          }
          board.draw(layer.framebuffer, eyeView, eyeProj, basis, panelW, panelH);
          // Reticle at this eye's own hit (parallax-correct); a fixed distance
          // along the gaze when the panel does not fill that direction.
          const point = hit
            ? hit.point
            : vec3.scaleAndAdd(vec3.create(), origin, ray, PANEL_DISTANCE);
          const radius = Math.max(0.06, (hit ? hit.distance : PANEL_DISTANCE) * 0.032);
          const right = vec3.fromValues(eyeView[0], eyeView[4], eyeView[8]);
          const up = vec3.fromValues(eyeView[1], eyeView[5], eyeView[9]);
          pointer.draw(layer.framebuffer, eyeView, eyeProj, point, right, up, radius, aim.progress);
        });
      }
      // The world-space panel/HUD is drawn after the composite, so its own
      // pass must carry the player-colour focus frame as well.
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
    }
    if (!ui) selectQueued = false;
    renderer.viewport = null;
    renderer.presentFbo = null;
    // The per-eye focus rect belongs to the frame just drawn; do not let it
    // leak into the page's non-XR fallback renderer.
    renderer.focusRect = null;
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
    // alike. The recalibration is applied after the UI click in the next
    // frame, so the crosshair still activates what it was pointing at.
    calibrateQueued = true;
    if (renderer.uiOverlay) selectQueued = true;
  });
  s.addEventListener('end', () => {
    clearPress();
    suppressRelease = false;
    panel?.dispose();
    cursor?.dispose();
    session = null;
    renderer.xrActive = false;
    renderer.presentBounds = null;
    renderer.focusFeather = previousFocusFeather;
    baselineYawAbs = 0;
    latestHeadYawAbs = 0;
    initialized = false;
    if (!keepVrOnEnd) store.vr = false;
    keepVrOnEnd = false;
    onEnd();
  });
  return true;
}
