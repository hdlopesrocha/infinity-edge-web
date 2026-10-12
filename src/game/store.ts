// Central app store: options (Options.cs), navigation->scene mapping,
// scores, notifications. Vue-reactive; the Renderer reads plain snapshots.

import { reactive } from 'vue';

export interface Options {
  username: string;
  distance: number; // camera far plane (128..512, default like XM_Camara)
  detail: number; // 0..4 VeryHigh..VeryLow
  musicVolume: number; // 0..1
  billboards: boolean;
  motionBlur: boolean;
  invX: boolean;
  invY: boolean;
}

export interface ScoreEntry {
  user: string;
  time: string;
}

const OPTIONS_KEY = 'ie3d.options';
const SCORE_PREFIX = 'ie3d.score.';

function loadOptions(): Options {
  const defaults: Options = {
    username: '',
    distance: 512,
    detail: 2,
    musicVolume: 0.7,
    billboards: true,
    motionBlur: true,
    invX: false,
    invY: false,
  };
  try {
    const raw = localStorage.getItem(OPTIONS_KEY);
    if (raw) return { ...defaults, ...(JSON.parse(raw) as Partial<Options>) };
  } catch {
    /* keep defaults */
  }
  return defaults;
}

export const store = reactive({
  options: loadOptions(),
  /** Current route name (mirrors vue-router for HUD/scene mapping). */
  route: 'boot' as string,
  /** Active background scene key: 'background' | level key. */
  sceneKey: 'background' as string,
  /** Whether the 3D scene is interactive (game route) or ambient (menu). */
  interactive: false,
  notification: '' as string,
  scores: {} as Record<string, ScoreEntry[]>,
});

export function saveOptions(): void {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(store.options));
  } catch {
    /* storage may be unavailable */
  }
}

export function clearGameData(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith(SCORE_PREFIX) || k.startsWith('ie3d.ghost.'))) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
  store.scores = {};
}

export function loadScores(save: string): ScoreEntry[] {
  if (store.scores[save]) return store.scores[save];
  try {
    const raw = localStorage.getItem(SCORE_PREFIX + save);
    if (raw) {
      store.scores[save] = JSON.parse(raw) as ScoreEntry[];
      return store.scores[save];
    }
  } catch {
    /* ignore */
  }
  return [];
}

export function recordScore(save: string, user: string, time: string): void {
  const list = loadScores(save).slice();
  list.push({ user, time });
  list.sort((a, b) => (a.time < b.time ? -1 : 1));
  const top = list.slice(0, 10);
  store.scores[save] = top;
  try {
    localStorage.setItem(SCORE_PREFIX + save, JSON.stringify(top));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Navigation -> background scene mapping (explicit, single place).
// Original: GenericMenu/MenuXML draw rc._background (Background.xml);
// GameInstance draws its own level map; EngineScreen draws its own splash.
// ---------------------------------------------------------------------------

export function sceneForRoute(routeName: string, param?: string): string {
  if (routeName === 'game' && param) return param; // level key
  return 'background';
}

export function isInteractiveRoute(routeName: string): boolean {
  return routeName === 'game';
}

export function syncSceneState(routeName: string, param?: string): void {
  store.route = routeName;
  store.sceneKey = sceneForRoute(routeName, param);
  store.interactive = isInteractiveRoute(routeName);
}
