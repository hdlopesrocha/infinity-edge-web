// VR mode: head-tracked view from the device's gyroscope.
//
// Entered from the in-game settings. A gamepad is recommended (the gaze
// cursor handles the menus, the stick flies), but it is not required: without
// one you keep the keyboard and touch controls and still look around.
//
// The camera keeps its chase position; the *view* gets an extra yaw/pitch
// taken from DeviceOrientationEvent. Tapping the screen calibrates: whatever
// the gyroscope reads at that moment becomes the new centre of the view.
import { store } from './store';

/** Degrees, relative to the last calibration. */
let yaw = 0;
let pitch = 0;
let zeroYaw = 0;
let zeroPitch = 0;
let haveOrientation = false;
let bound = false;

function onOrientation(e: DeviceOrientationEvent): void {
  if (e.alpha == null && e.beta == null && e.gamma == null) return;
  haveOrientation = true;
  const a = e.alpha ?? 0;          // compass-ish yaw
  const b = e.beta ?? 0;           // front-back tilt
  // Screen orientation can rotate the axes; keep it simple and use the raw
  // values relative to the calibration point.
  yaw = a - zeroYaw;
  pitch = b - zeroPitch;
  // Keep them in a sane range so a full turn does not spin wildly.
  yaw = ((yaw + 540) % 360) - 180;
  pitch = Math.max(-80, Math.min(80, pitch));
}

function bind(): void {
  if (bound || typeof window === 'undefined') return;
  bound = true;
  window.addEventListener('deviceorientation', onOrientation, true);
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
export const vrState = { status: 'off' as VrStatus };

/** iOS 13+ asks for motion access from a user gesture; other platforms have
 *  no permission step at all (deviceorientation just starts firing). */
interface PermissionCapable {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

export async function enableVr(): Promise<VrStatus> {
  const ev = (typeof window !== 'undefined'
    ? (window as unknown as { DeviceOrientationEvent?: PermissionCapable }).DeviceOrientationEvent
    : undefined);
  if (!ev) {
    vrState.status = 'unsupported';
    return 'unsupported';
  }
  if (typeof ev.requestPermission === 'function') {
    try {
      const res = await ev.requestPermission();
      if (res !== 'granted') {
        vrState.status = 'denied';
        store.vr = false;
        return 'denied';
      }
    } catch {
      vrState.status = 'denied';
      store.vr = false;
      return 'denied';
    }
  }
  bind();
  store.vr = true;
  vrState.status = 'on';
  return 'on';
}

export function setVr(on: boolean): void {
  if (on) { void enableVr(); return; }
  store.vr = false;
  vrState.status = 'off';
}

/** Tap/click: make the current gyroscope reading the centre of the view. */
export function calibrateVr(): void {
  if (!store.vr) return;
  // Re-read the current absolute values: the deltas are what we display, so
  // the calibration simply re-bases them.
  zeroYaw = ((yaw + zeroYaw + 540) % 360) - 180;
  zeroPitch = pitch + zeroPitch;
  yaw = 0;
  pitch = 0;
}

/** Current head offset in degrees (0/0 until the first orientation event). */
export function vrLook(): { yaw: number; pitch: number; tracking: boolean } {
  bind();
  return { yaw, pitch, tracking: haveOrientation };
}
