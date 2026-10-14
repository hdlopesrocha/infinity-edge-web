// Vue store: options mirror, nav state, scores (LoadScores/AddScore).

import { reactive } from 'vue';
import { defaultOptions, clearGameData as rcClearGameData, saveOptions as rcSaveOptions } from './resources';
import type { Options } from './resources';
import { GameScore } from './team';
import type { ScoreEntry } from './team';

export const store = reactive({
  options: defaultOptions() as Options,
  route: 'boot' as string,
  sceneKey: 'background' as string,
  levelKey: '' as string,
  interactive: false,
  username: '' as string,
  levelText: '' as string,
  result: null as { won: boolean; reward: string; message: string | null; level: string } | null,
  /** Eager asset load (all models/textures/levels) shown by the boot screens. */
  loading: { active: true, done: 0, total: 0, failed: 0 },
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

export function loadScores(type: 'TT' | 'CTF', savefile: string): GameScore[] {
  const list = readScores(savefile);
  list.sort((a, b) => a.hashCode(type) - b.hashCode(type));
  return list.slice(0, 10);
}

export function addScore(gs: GameScore, type: 'TT' | 'CTF', savefile: string): boolean {
  const list = readScores(savefile);
  list.push(gs);
  list.sort((a, b) => a.hashCode(type) - b.hashCode(type));
  writeScores(savefile, list);
  return list.length > 0 && list[0].scores === gs.scores;
}
