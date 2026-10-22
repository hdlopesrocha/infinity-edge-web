// Global Gamepad API watch.
//
// The flight controls (game/controls.ts) and the immersive session already
// read navigator.getGamepads() / session.inputSources. This watch keeps the
// Gamepad API polled app-wide (menus included) so a connected pad is seen as
// soon as the platform exposes it, and re-arms the Android Back sentinel when
// a controller appears — a controller Back press must always have a history
// entry to consume instead of closing the tab.

import { armBackGuard } from './backguard';

export function startGamepadWatch(): () => void {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) {
    return () => undefined;
  }
  let raf = 0;
  let seen = false;
  const loop = (): void => {
    raf = requestAnimationFrame(loop);
    const pads = navigator.getGamepads();
    let connected = false;
    for (const p of pads) {
      if (p && p.connected) { connected = true; break; }
    }
    if (connected && !seen) {
      seen = true;
      armBackGuard();
    } else if (!connected) {
      seen = false;
    }
  };
  raf = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(raf);
}
