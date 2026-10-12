// Static game data ported from Import/*.xml.
// ModelConfig.xml (~28 models), TextureConfig.xml (~40 aliases), TeamConfig.xml.

export interface ModelCfg {
  name: string;
  detail: number;
  directory: string;
  engineFlares: [number, number, number][];
  colorFlares: [number, number, number][];
}

// detail + flare offsets verbatim from ModelConfig.xml (comma decimals -> dots).
export const MODELS: ModelCfg[] = [
  { name: 'Ark', detail: 1, directory: 'Objects/Ark', engineFlares: [], colorFlares: [] },
  { name: 'AddonHomingMissile', detail: 1, directory: 'Objects/AddonHomingMissile', engineFlares: [], colorFlares: [] },
  { name: 'AddonRepair', detail: 1, directory: 'Objects/AddonRepair', engineFlares: [], colorFlares: [] },
  { name: 'AddonNitro', detail: 1, directory: 'Objects/AddonNitro', engineFlares: [], colorFlares: [] },
  { name: 'AddonShield', detail: 1, directory: 'Objects/AddonShield', engineFlares: [], colorFlares: [] },
  { name: 'Asteroid1', detail: 4, directory: 'Objects/Asteroid1', engineFlares: [], colorFlares: [] },
  { name: 'Asteroid2', detail: 4, directory: 'Objects/Asteroid2', engineFlares: [], colorFlares: [] },
  { name: 'Asteroid3', detail: 4, directory: 'Objects/Asteroid3', engineFlares: [], colorFlares: [] },
  { name: 'Asteroid4', detail: 4, directory: 'Objects/Asteroid4', engineFlares: [], colorFlares: [] },
  { name: 'Base', detail: 1, directory: 'Objects/Base', engineFlares: [], colorFlares: [] },
  { name: 'Bullet', detail: 1, directory: 'Objects/Bullet', engineFlares: [], colorFlares: [] },
  { name: 'HomingMissile', detail: 1, directory: 'Objects/HomingMissile', engineFlares: [], colorFlares: [] },
  { name: 'HomingMissile2', detail: 1, directory: 'Objects/HomingMissile2', engineFlares: [], colorFlares: [] },
  { name: 'Flag', detail: 1, directory: 'Objects/Flag', engineFlares: [], colorFlares: [] },
  { name: 'Wheel', detail: 1, directory: 'Objects/Wheel', engineFlares: [], colorFlares: [] },
  { name: 'Planet1', detail: 2, directory: 'Objects/Planet1', engineFlares: [], colorFlares: [] },
  { name: 'Planet2', detail: 2, directory: 'Objects/Planet2', engineFlares: [], colorFlares: [] },
  { name: 'Planet3', detail: 3, directory: 'Objects/Planet3', engineFlares: [], colorFlares: [] },
  { name: 'Sky1', detail: 1, directory: 'Objects/Sky1', engineFlares: [], colorFlares: [] },
  { name: 'Sky2', detail: 1, directory: 'Objects/Sky2', engineFlares: [], colorFlares: [] },
  { name: 'Sky3', detail: 1, directory: 'Objects/Sky3', engineFlares: [], colorFlares: [] },
  { name: 'adMultiply2X', detail: 1, directory: 'Objects/AddonMultiply2', engineFlares: [], colorFlares: [] },
  { name: 'adRepair', detail: 1, directory: 'Objects/AddonRepair', engineFlares: [], colorFlares: [] },
  { name: 'adShield', detail: 1, directory: 'Objects/AddonShield', engineFlares: [], colorFlares: [] },
  { name: 'adTime', detail: 1, directory: 'Objects/AddonTime', engineFlares: [], colorFlares: [] },
  { name: 'adNitro', detail: 1, directory: 'Objects/AddonNitro', engineFlares: [], colorFlares: [] },
  { name: 'adHomingMissile', detail: 1, directory: 'Objects/AddonHomingMissile', engineFlares: [], colorFlares: [] },
  {
    name: 'Fighter1', detail: 1, directory: 'Objects/Fighter1',
    engineFlares: [[0, 0.1, -0.7]],
    colorFlares: [[0.8, 0.05, -0.45], [-0.8, 0.05, -0.45]],
  },
  {
    name: 'Fighter2', detail: 1, directory: 'Objects/Fighter2',
    engineFlares: [[0, 0.1, -0.9]],
    colorFlares: [[0.6, 0.05, -0.65], [-0.6, 0.05, -0.65]],
  },
  {
    name: 'Fighter3', detail: 1, directory: 'Objects/Fighter3',
    engineFlares: [[0.1, -0.05, -0.6], [-0.1, -0.05, -0.6]],
    colorFlares: [[0.7, -0.05, -0.3], [-0.7, -0.05, -0.3]],
  },
];

/** Texture alias -> original content path (TextureConfig.xml). */
export const TEXTURES: Record<string, string> = {
  _menubtn: 'System/menubtn',
  _buttonLU: 'System/buttonLU',
  _buttonRU: 'System/buttonRU',
  _buttonLD: 'System/buttonLD',
  _buttonRD: 'System/buttonRD',
  _backGame: 'System/backGame',
  _aim: 'System/aim',
  _flag: 'System/flag',
  _flare1: 'System/flare1',
  _flare2: 'System/flare2',
  _flare3: 'System/flare3',
  _gold: 'System/gold',
  _silver: 'System/silver',
  _bronze: 'System/bronze',
  _ball: 'System/ball',
  _backWindow: 'System/backWindow',
  _singlePlayer: 'System/singlePlayer',
  _multiPlayer: 'System/multiPlayer',
  _optionsIcon: 'System/options',
  _about: 'System/about',
  _back: 'System/back',
  _timeTrial: 'System/timeTrial',
  _challenge: 'System/challenge',
  _ctf: 'System/ctf',
  _hex: 'System/hex',
  _easy: 'System/easy',
  _normal: 'System/normal',
  _hard: 'System/hard',
  _key: 'System/key',
  _over: 'System/over',
  _engineLogo: 'System/engineLogo',
  _gameLogo: 'System/logo',
  _backAnalog: 'Control/backAnalog',
  _stickAnalog: 'Control/stickAnalog',
  _fireButton: 'Control/fire',
  _fireButtonHM: 'Control/fireHM',
  _accelAnalog: 'Control/accelAnalog',
  _nitro: 'Control/nitro',
  _pixel: 'System/pixel',
};

export interface TeamCfg {
  name: string;
  color: [number, number, number]; // 0..1
}

// TeamConfig.xml: human 64|224|208 (turquoise), ambient 50|205|50, alien 255|0|0.
export const TEAMS: TeamCfg[] = [
  { name: 'human', color: [64 / 255, 224 / 255, 208 / 255] },
  { name: 'ambient', color: [50 / 255, 205 / 255, 50 / 255] },
  { name: 'alien', color: [1, 0, 0] },
];

export const DIPLOMACIES: { is: string; stance: 'enemy' | 'ally'; of: string }[] = [
  { is: 'human', stance: 'enemy', of: 'alien' },
  { is: 'alien', stance: 'enemy', of: 'human' },
];

export function areEnemies(a: string, b: string): boolean {
  if (a === b) return false;
  return DIPLOMACIES.some((d) => d.is === a && d.of === b && d.stance === 'enemy');
}
