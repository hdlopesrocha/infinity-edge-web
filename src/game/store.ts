// Vue store: options mirror, nav state, scores (LoadScores/AddScore).

import { reactive } from 'vue';
import { defaultOptions, clearGameData as rcClearGameData, saveOptions as rcSaveOptions } from './resources';
import type { Options } from './resources';
import { GameScore } from './team';
import type { ScoreEntry, ScoreType } from './team';

/** One life-bar segment (the HUD builds the coloured bar from these). */
export interface HudLifeSegment {
  value: number;
  max: number;
}

/** Marker drawn over another ship / base / goal (PointerMark, plain copy). */
export interface HudPointer {
  x: number;
  y: number;
  w: number;
  h: number;
  iconUrl: string | null;
  over: boolean;
  color: [number, number, number];
  label: string | null;
}

export const store = reactive({
  options: defaultOptions() as Options,
  route: 'boot' as string,
  sceneKey: 'background' as string,
  levelKey: '' as string,
  interactive: false,
  /** True while the in-game pause overlay is open: the world stops, the
   *  scene keeps rendering so option changes are visible behind it. */
  paused: false,
  username: '' as string,
  levelText: '' as string,
  result: null as { won: boolean; reward: string; message: string | null; level: string } | null,
  /** Eager asset load (all models/textures/levels) shown by the boot screens. */
  loading: { active: true, done: 0, total: 0, failed: 0 },
  /**
   * HUD snapshot, written by the render loop *after* the frame's movements and
   * draw (see GameCanvas.syncHud). The DOM overlay renders straight from this,
   * so the markers/aim/life are never a frame (or an interval tick) behind.
   */
  hud: {
    score: '',
    notify: '',
    aimX: 0,
    aimY: 0,
    life: [] as HudLifeSegment[],
    /** Countdown before the player's ship is destroyed for leaving the arena. */
    outside: null as { left: number; total: number } | null,
    /** Countdown until the destroyed player's ship respawns at its base. */
    respawn: null as { left: number; total: number } | null,
    /** Time left in the match (null for untimed levels like time trials). */
    matchLeft: null as number | null,
    homings: 0,
    nitroPct: 0,
    stickOn: false,
    backX: 0,
    backY: 0,
    knobX: 0,
    knobY: 0,
    acel: 0,
    pointers: [] as HudPointer[],
    canvasW: 1280,
    canvasH: 720,
    frame: 0,
  },
});

export function saveOptions(o: Options): void {
  rcSaveOptions(o);
}

export function clearGameData(): string[] {
  return rcClearGameData();
}

export function sceneForRoute(routeName: string, param?: string): string {
  if (routeName === 'game' && param) return param;
  if (routeName === 'engine') return 'engine';
  return 'background';
}

export function syncSceneState(routeName: string, param?: string): void {
  store.route = routeName;
  store.sceneKey = sceneForRoute(routeName, param);
  store.levelKey =
    routeName === 'game' || routeName === 'briefing' || routeName === 'victory' || routeName === 'defeat'
      ? (param ?? '')
      : '';
  store.interactive = routeName === 'game';
}

export function syncOptionsFromRC(o: Options): void {
  store.options = { ...o };
  store.username = o.username;
}

function readScores(savefile: string): GameScore[] {
  try {
    const raw = localStorage.getItem(savefile);
    if (!raw) return [];
    return (JSON.parse(raw) as { scores: ScoreEntry[] }[]).map((g) => new GameScore(g.scores));
  } catch {
    return [];
  }
}

function writeScores(savefile: string, list: GameScore[]): void {
  try {
    localStorage.setItem(savefile, JSON.stringify(list.slice(0, 10).map((g) => ({ scores: g.scores }))));
  } catch { /* ignore */ }
}

export function loadScores(type: ScoreType, savefile: string): GameScore[] {
  const list = readScores(savefile);
  list.sort((a, b) => a.hashCode(type) - b.hashCode(type));
  return list.slice(0, 10);
}

export function addScore(gs: GameScore, type: ScoreType, savefile: string): boolean {
  const list = readScores(savefile);
  list.push(gs);
  list.sort((a, b) => a.hashCode(type) - b.hashCode(type));
  writeScores(savefile, list);
  return list.length > 0 && list[0].scores === gs.scores;
}
