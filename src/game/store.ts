// Vue-side store: UI-bound options mirror, navigation state, scores.
// The simulation (GameInstance) owns authoritative state; views read it
// directly each frame for HUD data.

import { reactive } from 'vue';
import { defaultOptions, clearGameData as rcClearGameData, saveOptions as rcSaveOptions } from './resources';
import type { Options } from './resources';
import { GameScore } from './team';
import type { ScoreEntry } from './team';

export function saveOptions(o: Options): void {
  rcSaveOptions(o);
}

export function clearGameData(): string[] {
  return rcClearGameData();
}

export const store = reactive({
  options: defaultOptions() as Options,
  route: 'boot' as string,
  sceneKey: 'background' as string,
  levelKey: '' as string,
  interactive: false,
  notification: '' as string,
  notificationVisible: false as boolean,
  username: '' as string,
  result: null as { won: boolean; reward: string; message: string | null; level: string } | null,
});

export function syncOptionsFromRC(o: Options): void {
  store.options = { ...o };
  store.username = o.username;
}

export function sceneForRoute(routeName: string, param?: string): string {
  if (routeName === 'game' && param) return param;
  return 'background';
}

export function syncSceneState(routeName: string, param?: string): void {
  store.route = routeName;
  store.sceneKey = sceneForRoute(routeName, param);
  store.levelKey = routeName === 'game' || routeName === 'briefing' || routeName === 'victory' || routeName === 'defeat'
    ? (param ?? '')
    : '';
  store.interactive = routeName === 'game';
}

// ---- scores (GameScore XML <-> JSON localStorage mapping) ----
function readScores(savefile: string): GameScore[] {
  try {
    const raw = localStorage.getItem(savefile);
    if (!raw) return [];
    const arr = JSON.parse(raw) as { scores: ScoreEntry[] }[];
    return arr.map((g) => new GameScore(g.scores));
  } catch {
    return [];
  }
}

function writeScores(savefile: string, list: GameScore[]): void {
  try {
    localStorage.setItem(savefile, JSON.stringify(list.slice(0, 10).map((g) => ({ scores: g.scores }))));
  } catch {
    /* ignore */
  }
}

/** LoadScores verbatim: sorted ascending by HashCode (best first). */
export function loadScores(type: 'TT' | 'CTF', savefile: string): GameScore[] {
  const list = readScores(savefile);
  list.sort((a, b) => a.hashCode(type) - b.hashCode(type));
  return list.slice(0, 10);
}

/** AddScore verbatim: insert, persist top 10, true if new best (Leftest). */
export function addScore(gs: GameScore, type: 'TT' | 'CTF', savefile: string): boolean {
  const list = readScores(savefile);
  list.push(gs);
  list.sort((a, b) => a.hashCode(type) - b.hashCode(type));
  writeScores(savefile, list);
  return list[0] === gs || (list.length > 0 && list[0].scores === gs.scores);
}
