// Android/controller Back guard.
//
// A controller's B button is the Android system Back. With no history entry
// left to consume, Android closes the tab/app. Keep a sentinel entry at the
// bottom of the history stack and re-arm it whenever it is consumed, so Back
// is swallowed instead of exiting. The app's own back actions mark themselves
// first so they still work.

let internal = false;

/** The app is about to navigate Back on purpose (router.back). */
export function markInternalBack(): void {
  internal = true;
}

/** Returns true once for an app-initiated Back. */
export function consumeInternalBack(): boolean {
  const v = internal;
  internal = false;
  return v;
}

/** Push/replace the bottom sentinel so a system Back always has something to
 *  consume. Safe to call after any route change. */
export function armBackGuard(): void {
  if (typeof window === 'undefined') return;
  const state = history.state as { position?: number } | null;
  // Only the bottom entry needs the sentinel; when the router is deeper in
  // its stack we must not add extra entries or in-app Back breaks.
  if (state && typeof state.position === 'number' && state.position > 0) return;
  try {
    history.pushState({ ...(state ?? {}), ieBackGuard: true }, '', location.href);
  } catch {
    /* history may be unavailable in odd webviews */
  }
}

export function installBackGuard(): void {
  if (typeof window === 'undefined') return;
  armBackGuard();
  window.addEventListener('popstate', () => {
    if (consumeInternalBack()) return;
    // System Back: consume it and stay in the app.
    armBackGuard();
  });
  window.addEventListener('pageshow', armBackGuard);
}
