// Navigation helpers.
//
// "Back" is always LIFO: it pops the history entry you came from. Pushing a
// parent screen instead (what the game/result screens used to do) appends a
// *new* entry, so the stack became briefing -> game -> briefing and pressing
// back from that briefing walked forward into the game again. Screens that
// finish something (a match ending) use replace(), so the finished screen
// leaves the stack instead of being re-enterable.
import type { Router } from 'vue-router';
import { markInternalBack } from './backguard';

/** Pop the history; a deep link with nothing behind it falls back to `parent`. */
export function goBack(router: Router, parent: string): void {
  const state = router.options.history.state as { back?: string | null } | null;
  if (state && state.back) {
    markInternalBack();
    router.back();
    return;
  }
  void router.replace(parent);
}
