// Minimal WebXR typings: TypeScript's dom lib omits them and this module uses
// only this surface, so we declare it locally instead of adding a dependency.
interface XRViewport { x: number; y: number; width: number; height: number }
interface XRView { projectionMatrix: Float32Array; transform: { matrix: Float32Array } }
interface XRViewerPose { views: XRView[] }
interface XRFrame { getViewerPose(space: unknown): XRViewerPose | null }
interface XRWebGLLayer {
  framebuffer: WebGLFramebuffer | null;
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

// Real WebXR ("immersive-vr"): the session owns the frame loop and we render
// the scene once per eye straight into the XR framebuffer, with each eye's own
// pose and projection. Not a gyroscope look-alike.
//
// Integration notes:
// - the chase camera keeps flying the ship; the head pose is applied on top of
//   that view (seated experience: rotation from the XR transform, translation
//   ignored), so the ship stays centred while you look around.
// - the post chain (zoom blur / lens flare / soft particles) is skipped inside
//   XR: we draw the map directly into the XR framebuffer per eye.
// - while a session is live, the normal rAF path only advances the simulation
//   (renderer.xrActive) so nothing double-draws to the canvas.
import { mat4 } from '../engine/math';
import type { GameInstance } from './instance';
import { store } from './store';
import { calibrateVr } from './vr';
import { syncHud } from './hud';
import { HudOverlay } from '../engine/hud3d';

type XrSystem = {
  isSessionSupported(mode: string): Promise<boolean>;
  requestSession(mode: string, init?: Record<string, unknown>): Promise<XRSession>;
};

function xr(): XrSystem | null {
  const n = navigator as unknown as { xr?: XrSystem };
  return n.xr ?? null;
}

let session: XRSession | null = null;
let keepVrOnEnd = false;
let entering = false;

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
 * UI) - that is what menus do, since an immersive session hides the page DOM.
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
    beginFrame: () => void;
    endFrame: () => void;
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
  s.updateRenderState({ baseLayer: layer });
  const refSpace = await s.requestReferenceSpace('local');
  const head = mat4.create();
  const chase = mat4.create();
  let last = 0;
  let hudOverlay: HudOverlay | null = null;

  const loop = (time: number, frame: XRFrame): void => {
    if (!session) return;
    session.requestAnimationFrame(loop);
    const dt = last ? Math.min(50, time - last) : 16;
    last = time;
    const instance = getInstance();
    const pose = frame.getViewerPose(refSpace);
    if (!instance || !pose) return;
    // Simulate normally: this also positions the chase camera behind the ship.
    instance.canvasW = gl.drawingBufferWidth;
    instance.canvasH = gl.drawingBufferHeight;
    if (!store.paused) instance.update(dt);
    syncHud(instance);
    mat4.copy(chase, renderer.camera.view);
    const cam = renderer.camera;
    // Each eye goes through the whole normal pipeline (scene target, scene
    // draw, composite) but the composite blits into the WebXR base layer with
    // that eye's viewport instead of the canvas. Drawing only the scene left
    // the eyes black: the composite is what produces the final image.
    gl.disable(gl.SCISSOR_TEST);
    for (const view of pose.views) {
      const vp = layer.getViewport(view);
      if (!vp || vp.width <= 0 || vp.height <= 0) continue;
      mat4.invert(head, view.transform.matrix);
      mat4.multiply(cam.view, head, chase);           // head rotation over the chase view
      mat4.copy(cam.proj, view.projectionMatrix);
      mat4.multiply(cam.viewProj, cam.proj, cam.view);
      renderer.viewport = { x: vp.x, y: vp.y, w: vp.width, h: vp.height };
      renderer.presentFbo = layer.framebuffer;
      renderer.beginFrame();   // scene target + frustum for this eye
      instance.draw();         // scene into the scene target
      renderer.endFrame();     // composite straight into the XR framebuffer
      // The DOM is hidden inside the session, so the HUD (score, clock, aim,
      // life, markers, notifications) is composited here in GL, per eye.
      try {
        if (!hudOverlay) hudOverlay = new HudOverlay(gl);
        hudOverlay.update(store.hud);
        hudOverlay.draw(layer.framebuffer, { x: vp.x, y: vp.y, w: vp.width, h: vp.height });
      } catch { /* a failed overlay must never kill the frame */ }
    }
    renderer.viewport = null;
    renderer.presentFbo = null;
  };
  s.requestAnimationFrame(loop);
  // A tap on the screen inside the session re-centres the view (there is no
  // DOM in there, so this is the only click the page can see).
  s.addEventListener('select', () => calibrateVr());
  s.addEventListener('end', () => {
    session = null;
    renderer.xrActive = false;
    if (!keepVrOnEnd) store.vr = false;
    keepVrOnEnd = false;
    onEnd();
  });
  return true;
}
