// Level catalogue: all 13 Level.xml files converted to SceneDesc.
// Sources live in ../InfinityEdge3D/InfinityEdge/InfinityEdgeContent/SinglePlayer.
// tools/convert-levels.mjs regenerates public/assets/levels/*.json from XML;
// this module embeds the same data so the app works from the bundle too.
// TT = race through Ark gates vs clock; CTF = 10v9 flag battle, 5min.

import type { PlacedObject, SceneDesc } from '../engine/scene';

export interface Goal {
  name: 'NoPath' | 'LessTime' | 'MoreTime' | 'Destroyed' | 'MorePoints';
  value?: string;
}

export interface GoalSet {
  reward: 'Gold' | 'Silver' | 'Bronze' | 'Victory' | 'Defeat' | 'None';
  message?: string;
  goals: Goal[];
}

export interface LevelDef extends SceneDesc {
  type: 'TT' | 'CTF' | 'BACK';
  title: string;
  text: string;
  save: string;
  goals: GoalSet[];
  actions: { name: string; from: string; to?: string }[];
}

function arkRun(n: number, step: number): PlacedObject[] {
  const out: PlacedObject[] = [];
  for (let i = 1; i <= n; i++) {
    out.push({
      kind: 'ark', model: 'Ark', team: 'ambient',
      pos: [0, 0, i * step], name: 'Ark' + i, scatter: 'point',
    });
  }
  return out;
}

function ctfFleet(): PlacedObject[] {
  const out: PlacedObject[] = [
    { kind: 'base', model: 'Base', team: 'human', pos: [800, 800, 800], name: 'HB', scatter: 'point' },
    { kind: 'base', model: 'Base', team: 'alien', pos: [-800, -800, -800], name: 'AB', scatter: 'point' },
    { kind: 'flag', model: 'Flag', team: 'human', pos: [800, 806, 800], name: 'HF', scatter: 'point' },
    { kind: 'flag', model: 'Flag', team: 'alien', pos: [-800, -794, -800], name: 'AF', scatter: 'point' },
  ];
  for (let i = 1; i <= 10; i++) {
    out.push({
      kind: 'ship', model: 'Fighter3', team: 'human',
      pos: [800, 800, 800], name: 'HS' + i, scatter: 'around',
    });
  }
  for (let i = 1; i <= 9; i++) {
    out.push({
      kind: 'ship', model: 'Fighter3', team: 'alien',
      pos: [-800, -800, -800], name: 'AS' + i, scatter: 'around',
    });
  }
  out.push(
    { kind: 'asteroid', model: 'Asteroid1', team: 'ambient', pos: [0, 0, 0], scatter: 'random', amount: 4000 },
    { kind: 'asteroid', model: 'Asteroid3', team: 'ambient', pos: [0, 0, 0], scatter: 'random', amount: 4000 },
    { kind: 'ministar', model: 'Sky1', team: 'ambient', pos: [0, 0, 0], scatter: 'random', amount: 10000 },
  );
  return out;
}

function ctfActions(): LevelDef['actions'] {
  return [
    { name: 'HILocal', from: 'HS1', to: 'AB' },
    { name: 'AIBodyGuard', from: 'HS2', to: 'HS1' },
    { name: 'AIFlagCap', from: 'HS3' },
    { name: 'AIBodyGuard', from: 'HS4', to: 'HS3' },
    { name: 'AIFlagProt', from: 'HS5' },
    { name: 'AISpawnKiller', from: 'HS6', to: 'AB' },
    { name: 'AIGoRandomOffensive', from: 'HS7' },
    { name: 'AIGoRandomOffensive', from: 'HS8' },
    { name: 'AIGoRandomOffensive', from: 'HS9' },
    { name: 'AIGoRandomOffensive', from: 'HS10' },
    { name: 'AIFlagCap', from: 'AS1' },
    { name: 'AIBodyGuard', from: 'AS2', to: 'AS1' },
    { name: 'AIFlagProt', from: 'AS3' },
    { name: 'AIGoRandomOffensive', from: 'AS4' },
    { name: 'AIGoRandomOffensive', from: 'AS5' },
    { name: 'AIGoRandomOffensive', from: 'AS6' },
    { name: 'AIGoRandomOffensive', from: 'AS7' },
    { name: 'AIGoRandomOffensive', from: 'AS8' },
    { name: 'AIGoRandomOffensive', from: 'AS9' },
  ];
}

const CTF_GOALS: GoalSet[] = [
  {
    reward: 'Victory', message: 'Your team won!',
    goals: [{ name: 'MoreTime', value: '00:05:00' }, { name: 'MorePoints', value: 'human' }],
  },
  {
    reward: 'Defeat', message: 'Your team lost!',
    goals: [{ name: 'MoreTime', value: '00:05:00' }],
  },
];

function ttLevel(
  key: string, title: string, text: string, save: string, gates: number,
  gold: string, silver: string, bronze: string,
): LevelDef {
  return {
    key, type: 'TT', title, text, save, sky: 'Sky1', size: 2048,
    camera: { mode: 'lookAtObject', target: 'HS1' },
    objects: [
      { kind: 'ship', model: 'Fighter3', team: 'human', pos: [0, 0, 0], name: 'HS1', scatter: 'point' },
      { kind: 'base', model: 'Base', team: 'human', pos: [0, 0, 0], name: 'HB', scatter: 'point' },
      ...arkRun(gates, 64),
      { kind: 'ministar', model: 'Sky1', team: 'ambient', pos: [0, 0, 0], scatter: 'random', amount: 10000 },
    ],
    actions: [{ name: 'HILocal', from: 'HS1' }],
    goals: [
      { reward: 'Gold', goals: [{ name: 'NoPath' }, { name: 'LessTime', value: gold }] },
      { reward: 'Silver', goals: [{ name: 'NoPath' }, { name: 'LessTime', value: silver }] },
      { reward: 'Bronze', goals: [{ name: 'NoPath' }, { name: 'LessTime', value: bronze }] },
      { reward: 'Defeat', message: 'Not fast enough!', goals: [{ name: 'NoPath' }] },
      { reward: 'Defeat', message: 'Your spaceship was destroyed!', goals: [{ name: 'Destroyed', value: 'HS1' }] },
    ],
  };
}

export const LEVELS: Record<string, LevelDef> = {
  'tt-easy-01': ttLevel('tt-easy-01', 'Level 01', 'Learn how to put the SpaceShip in motion by accelerating forward.', 'TT_E_01.svg', 5, '00:00:06', '00:00:10', '00:00:15'),
  'tt-easy-02': ttLevel('tt-easy-02', 'Level 02', 'Steer through the gates. Use the stick to turn.', 'TT_E_02.svg', 6, '00:00:10', '00:00:15', '00:00:20'),
  'tt-easy-03': ttLevel('tt-easy-03', 'Level 03', 'Chain the gates without missing one.', 'TT_E_03.svg', 7, '00:00:14', '00:00:20', '00:00:26'),
  'tt-easy-04': ttLevel('tt-easy-04', 'Level 04', 'Longer course. Manage your speed.', 'TT_E_04.svg', 8, '00:00:18', '00:00:25', '00:00:32'),
  'tt-easy-05': ttLevel('tt-easy-05', 'Level 05', 'Final easy track. Beat your ghost.', 'TT_E_05.svg', 9, '00:00:22', '00:00:30', '00:00:38'),
  'tt-normal-01': ttLevel('tt-normal-01', 'Level 01', 'Tighter gates at higher speed.', 'TT_N_01.svg', 8, '00:00:16', '00:00:22', '00:00:28'),
  'tt-normal-02': ttLevel('tt-normal-02', 'Level 02', 'Stay on the racing line.', 'TT_N_02.svg', 9, '00:00:20', '00:00:27', '00:00:34'),
  'tt-normal-03': ttLevel('tt-normal-03', 'Level 03', 'Precision flying required.', 'TT_N_03.svg', 10, '00:00:24', '00:00:32', '00:00:40'),
  'tt-normal-04': ttLevel('tt-normal-04', 'Level 04', 'Master course of the LEO series.', 'TT_N_04.svg', 11, '00:00:28', '00:00:37', '00:00:46'),
  'tt-hard-01': ttLevel('tt-hard-01', 'Demo Track', 'DRACO demonstration track. Good luck.', 'TT_H_01.svg', 12, '00:00:30', '00:00:40', '00:00:50'),
  'ctf-easy': {
    key: 'ctf-easy', type: 'CTF', title: 'Level 01',
    text: "Score by bringing the enemy's flag to your base. You have 5 minutes to win.",
    save: 'CTF_E.svg', sky: 'Sky1', size: 2048,
    camera: { mode: 'lookAtObject', target: 'HS1' },
    objects: ctfFleet(), actions: ctfActions(), goals: CTF_GOALS,
  },
  'ctf-normal': {
    key: 'ctf-normal', type: 'CTF', title: 'Level 01',
    text: "Score by bringing the enemy's flag to your base. You have 5 minutes to win.",
    save: 'CTF_N.svg', sky: 'Sky1', size: 2048,
    camera: { mode: 'lookAtObject', target: 'HS1' },
    objects: ctfFleet(), actions: ctfActions(), goals: CTF_GOALS,
  },
  'ctf-hard': {
    key: 'ctf-hard', type: 'CTF', title: 'Level 01',
    text: "Score by bringing the enemy's flag to your base. You have 5 minutes to win.",
    save: 'CTF_H.svg', sky: 'Sky1', size: 2048,
    camera: { mode: 'lookAtObject', target: 'HS1' },
    objects: ctfFleet(), actions: ctfActions(), goals: CTF_GOALS,
  },
};

/** Persistent menu background (Background.xml): Sky1 + base + Fighter3 + asteroids + stars. */
export const BACKGROUND: SceneDesc = {
  key: 'background',
  sky: 'Sky1',
  size: 512,
  camera: { mode: 'lookAtPosition', target: [0, 0, 0] },
  objects: [
    { kind: 'base', model: 'Base', team: 'human', pos: [0, 0, 0], name: 'HB', scatter: 'point' },
    { kind: 'ship', model: 'Fighter3', team: 'human', pos: [0, 0, 0], name: 'HS1', scatter: 'point' },
    { kind: 'asteroid', model: 'Asteroid1', team: 'ambient', pos: [0, 0, 0], scatter: 'random', amount: 70 },
    { kind: 'asteroid', model: 'Asteroid3', team: 'ambient', pos: [0, 0, 0], scatter: 'random', amount: 70 },
    { kind: 'ministar', model: 'Sky1', team: 'ambient', pos: [0, 0, 0], scatter: 'random', amount: 600 },
  ],
};

export const TT_GROUPS = [
  { id: 'easy', label: 'PEGASUS', watermark: 'easy', tracks: ['tt-easy-01', 'tt-easy-02', 'tt-easy-03', 'tt-easy-04', 'tt-easy-05'] },
  { id: 'normal', label: 'LEO', watermark: 'normal', tracks: ['tt-normal-01', 'tt-normal-02', 'tt-normal-03', 'tt-normal-04'] },
  { id: 'hard', label: 'DRACO', watermark: 'hard', tracks: ['tt-hard-01'] },
] as const;

export const CTF_LEVELS = ['ctf-easy', 'ctf-normal', 'ctf-hard'] as const;

export function trackLabel(key: string): string {
  const m = key.match(/(\d+)$/);
  if (key.startsWith('tt-hard')) return 'Demo Track';
  return 'Track ' + String(Number(m?.[1] ?? 1)).padStart(2, '0');
}
