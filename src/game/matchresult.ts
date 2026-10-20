// A finished match is signalled by GameInstance.result. The simulation can
// finish in the page frame loop or in the WebXR session loop, so both paths
// must take the pending result exactly once before navigating to the results
// screen.

export interface PendingMatchResult {
  won: boolean;
  reward: string;
  message: string | null;
}

export interface FinishedMatch extends PendingMatchResult {
  level: string;
}

/**
 * Take (and clear) the instance's pending match result. Returns null when the
 * match is not over or the game route is no longer active, so a late frame can
 * never replace a menu the player already navigated to.
 */
export function takeMatchResult(
  instance: { result: PendingMatchResult | null } | null,
  route: string,
  level: string,
): FinishedMatch | null {
  if (!instance?.result || route !== 'game') return null;
  const result = instance.result;
  instance.result = null;
  return { ...result, level };
}
