// Level catalogue over converted Level.xml JSON.

import { fetchAssetJson } from './assetfetch';

export interface LevelObjectJson {
  team: string;
  type: string;
  model: string;
  position: string;
  name?: string;
  life?: string;
  amount?: number;
}

export interface LevelActionJson {
  name: string;
  from: string;
  to?: string;
}

export interface LevelGoalJson {
  name: string;
  value?: string;
}

export interface LevelGoalSetJson {
  reward: string;
  message?: string;
  goals: LevelGoalJson[];
}

export interface LevelJson {
  source: string;
  description: { type: string; name: string; save: string; sky: string; size: number; text: string };
  imports: string[];
  importGhost?: string;
  objects: LevelObjectJson[];
  camara: { name: string; value: string };
  actions: LevelActionJson[];
  goals: LevelGoalSetJson[];
  /** Briefing textBox text from the sibling Menu.xml. */
  menuText?: string;
  /** scoreBoard tag from the sibling Menu.xml. */
  scoreBoard?: { type: string; save: string };
}

export interface LevelDef extends LevelJson {
  key: string;
}

const BASE = (import.meta.env.BASE_URL + 'assets/levels/').replace(/([^:])\/\//g, '$1/');

export const LEVEL_FILES: Record<string, string> = {
  background: 'Background.json',
  'tt-easy-01': 'SinglePlayer_TT_Easy_01_Level.json',
  'tt-easy-02': 'SinglePlayer_TT_Easy_02_Level.json',
  'tt-easy-03': 'SinglePlayer_TT_Easy_03_Level.json',
  'tt-easy-04': 'SinglePlayer_TT_Easy_04_Level.json',
  'tt-easy-05': 'SinglePlayer_TT_Easy_05_Level.json',
  'tt-normal-01': 'SinglePlayer_TT_Normal_01_Level.json',
  'tt-normal-02': 'SinglePlayer_TT_Normal_02_Level.json',
  'tt-normal-03': 'SinglePlayer_TT_Normal_03_Level.json',
  'tt-normal-04': 'SinglePlayer_TT_Normal_04_Level.json',
  'tt-hard-01': 'SinglePlayer_TT_Hard_01_Level.json',
  'ctf-easy': 'SinglePlayer_CTF_Easy_Level.json',
  'ctf-normal': 'SinglePlayer_CTF_Normal_Level.json',
  'ctf-hard': 'SinglePlayer_CTF_Hard_Level.json',
};

const cache = new Map<string, LevelDef>();

export async function loadLevel(key: string): Promise<LevelDef> {
  const hit = cache.get(key);
  if (hit) return hit;
  const file = LEVEL_FILES[key];
  if (!file) throw new Error('Unknown level: ' + key);
  const def: LevelDef = { ...(await fetchAssetJson<LevelJson>(BASE + file)), key };
  cache.set(key, def);
  return def;
}

export const TT_GROUPS = [
  { id: 'easy', label: 'PEGASUS', tracks: ['tt-easy-01', 'tt-easy-02', 'tt-easy-03', 'tt-easy-04', 'tt-easy-05'] },
  { id: 'normal', label: 'LEO', tracks: ['tt-normal-01', 'tt-normal-02', 'tt-normal-03', 'tt-normal-04'] },
  { id: 'hard', label: 'DRACO', tracks: ['tt-hard-01'] },
] as const;

export const CTF_LEVELS = ['ctf-easy', 'ctf-normal', 'ctf-hard'] as const;
