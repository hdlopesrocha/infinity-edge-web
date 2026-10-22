// VR mode: head-tracked view from the device's gyroscope.
//
// Entered from the in-game settings. A gamepad is recommended (the gaze
// cursor handles the menus, the stick flies), but it is not required: without
// one you keep the keyboard and touch controls and still look around.
//
// The camera keeps its chase position; the *view* gets an extra yaw/pitch
// taken from DeviceOrientationEvent. Tapping the screen calibrates: whatever
// the gyroscope reads at that moment becomes the new centre of the view.
import { reactive } from 'vue';
import { store } from './store';

/**
 * How long a trigger/tap must be held to become the VR pause gesture.
 * Shared by the immersive WebXR path (selectstart/selectend) and the
 * sensor/drag fallback (pointerdown/up), so both feel the same.
 */
export const VR_LONG_PRESS_MS = 700;

/** A press is a long press once it reaches the shared threshold. */
export function isVrLongPress(durationMs: number): boolean {
  return durationMs >= VR_LONG_PRESS_MS;
}

/** Degrees, relative to the last calibration. */
let yaw = 0;
let pitch = 0;
let roll = 0;
let zeroYaw = 0;
let zeroPitch = 0;
let zeroRoll = 0;
let haveOrientation = false;
let eventCount = 0;
let dragYaw = 0;
let dragPitch = 0;
let bound = false;

function onOrientation(e: DeviceOrientationEvent): void {
  if (e.alpha == null && e.beta == null && e.gamma == null) return;
  haveOrientation = true;
  eventCount++;
  vrState.tracking = true;
  vrState.events = eventCount;
  const a = e.alpha ?? 0;          // compass-ish yaw
  const b = e.beta ?? 0;           // front-back tilt
  const g = e.gamma ?? 0;          // left-right roll
  // Screen orientation can rotate the axes; keep it simple and use the raw
  // values relative to the calibration point.
  yaw = a - zeroYaw;
  pitch = b - zeroPitch;
  roll = g - zeroRoll;
  // Keep them in a sane range so a full turn does not spin wildly.
  yaw = ((yaw + 540) % 360) - 180;
  pitch = Math.max(-80, Math.min(80, pitch));
  roll = Math.max(-90, Math.min(90, roll));
}

async function bind(): Promise<void> {
  if (bound || typeof window === 'undefined') return;
  bound = true;
  window.addEventListener('deviceorientation', onOrientation, true);
  // Some platforms only start delivering events after a short delay; nothing
  // to await here, but keep the async shape for future permission paths.
}

/** True when a standard-mapped gamepad is actually connected. */
export function gamepadConnected(): boolean {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return false;
  for (const p of navigator.getGamepads()) if (p && p.connected) return true;
  return false;
}

export function vrAvailable(): boolean {
  return gamepadConnected();
}

/** Last enable attempt's outcome, for the UI. */
export type VrStatus = 'off' | 'on' | 'denied' | 'unsupported';
/** Reactive so the UI can say "active" the moment motion data arrives. */
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => {
    vrState.lastError = String((e as ErrorEvent).message ?? e).slice(0, 120);
  });
  window.addEventListener('unhandledrejection', (e) => {
    vrState.lastError = String((e as PromiseRejectionEvent).reason ?? e).slice(0, 120);
  });
}

export const vrState = reactive({
  status: 'off' as VrStatus,
  tracking: false,
  events: 0,
  /** Live look values, updated every frame while VR is on. */
  yaw: 0,
  pitch: 0,
  roll: 0,
  /** Last runtime error, shown on the settings screen. */
  lastError: '' as string,
  /** What the platform said about motion access, for the status line. */
  permission: 'unknown' as string,
  /** 'webxr' inside an immersive session, otherwise the sensor fallback. */
  mode: 'none' as 'none' | 'webxr' | 'sensor',
  /** True once the player has looked around by dragging (sensor fallback). */
  dragLook: false,
});

/** iOS 13+ asks for motion access from a user gesture; other platforms have
 *  no permission step at all (deviceorientation just starts firing). */
interface PermissionCapable {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

export async function enableVr(
  xr?: { renderer: import('../engine/renderer').Renderer; getInstance: () => import('./instance').GameInstance | null; onEnd: () => void },
): Promise<VrStatus> {
  // Real VR first: an immersive session, not a gyroscope imitation.
  if (xr) {
    try {
      const { enterXr } = await import('./xr');
      if (await enterXr(xr.renderer as never, xr.getInstance, xr.onEnd)) {
        vrState.status = 'on';
        vrState.mode = 'webxr';
        store.vr = true;
        return 'on';
      }
    } catch { /* fall through to the sensor path */ }
  }
  const ev = (typeof window !== 'undefined'
    ? (window as unknown as { DeviceOrientationEvent?: PermissionCapable }).DeviceOrientationEvent
    : undefined);
  if (!ev) {
    vrState.status = 'unsupported';
    store.vr = false;
    return 'unsupported';
  }
  // iOS 13+ gates motion behind a prompt that must come from a user gesture.
  // Everywhere else either the function does not exist or calling it throws
  // (NotSupportedError on some Chrome builds) -- an exception is NOT a denial,
  // it just means there is no prompt on this platform, so carry on and let
  // the events decide.
  if (typeof ev.requestPermission === 'function') {
    try {
      const res = await ev.requestPermission();
      // iOS answers 'denied' without a prompt when the site's motion access
      // was switched off earlier or the call missed the gesture window. Do
      // not give up on that: enable the mode and listen anyway (the sensor
      // starts delivering the moment the user allows it in
      // Settings -> Safari -> Motion & Orientation Access), and fall back to
      // dragging the scene to look.
      vrState.permission = res;
    } catch {
      vrState.permission = 'unavailable';
    }
  } else {
    vrState.permission = 'not-required';
  }
  await bind();
  store.vr = true;
  vrState.status = 'on';
  return 'on';
}

export function setVr(on: boolean): void {
  if (on) { void enableVr(); return; }
  store.vr = false;
  vrState.status = 'off';
}

/**
 * Toggle VR from the chrome button shown on every menu. Turning it off leaves
 * an immersive session first; turning it on prefers WebXR when a renderer is
 * available, otherwise the gyroscope/drag fallback.
 */
export async function toggleVrMode(): Promise<void> {
  if (store.vr) {
    try {
      const { leaveXr } = await import('./xr');
      leaveXr();
    } catch { /* no immersive session to leave */ }
    setVr(false);
    return;
  }
  const w = typeof window !== 'undefined'
    ? (window as unknown as {
        __ieRenderer?: import('../engine/renderer').Renderer;
        __ieGame?: import('./instance').GameInstance | null;
      })
    : null;
  const renderer = w?.__ieRenderer;
  await enableVr(renderer
    ? { renderer, getInstance: () => w?.__ieGame ?? null, onEnd: () => { store.vr = false; } }
    : undefined);
}

/**
 * Sensor fallback: dragging across the scene looks around. Works on any
 * touch device, so VR is usable even where motion access is blocked.
 */
export function dragLook(dx: number, dy: number): void {
  if (!store.vr) return;
  dragYaw += dx * 0.25;
  dragPitch = Math.max(-80, Math.min(80, dragPitch - dy * 0.25));
  vrState.dragLook = true;
}

/** Tap/click: make the current look direction the centre of the view. */
export function calibrateVr(): void {
  if (!store.vr) return;
  dragYaw = 0;
  dragPitch = 0;
  // Re-read the current absolute values: the deltas are what we display, so
  // the calibration simply re-bases them.
  zeroYaw = ((yaw + zeroYaw + 540) % 360) - 180;
  zeroPitch = pitch + zeroPitch;
  zeroRoll = roll + zeroRoll;
  yaw = 0;
  pitch = 0;
  roll = 0;
}

/** Current head offset in degrees (0/0 until the first orientation event). */
export function vrLook(): { yaw: number; pitch: number; roll: number; tracking: boolean } {
  void bind();
  // The sensor wins when it delivers; the drag offset is the fallback. The
  // values are mirrored into vrState so the settings screen can show them --
  // that readout is how the user sees the mode actually doing something.
  const out = haveOrientation
    ? { yaw, pitch, roll, tracking: true }
    : vrState.dragLook
      ? { yaw: dragYaw, pitch: dragPitch, roll: 0, tracking: true }
      : { yaw: 0, pitch: 0, roll: 0, tracking: false };
  vrState.yaw = Math.round(out.yaw);
  vrState.pitch = Math.round(out.pitch);
  vrState.roll = Math.round(out.roll);
  vrState.tracking = out.tracking;
  return out;
}
