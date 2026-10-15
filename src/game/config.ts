// Static data verbatim (ModelConfig/TextureConfig/TeamConfig/Engine voices).

export interface ModelCfg {
  name: string;
  detail: number;
  directory: string;
  engineFlares: [number, number, number][];
  colorFlares: [number, number, number][];
}

export const MODELS: ModelCfg[] = [
  { name: 'Ark', detail: 1, directory: 'Objects/Ark', engineFlares: [], colorFlares: [] },
  { name: 'Asteroid1', detail: 4, directory: 'Objects/Asteroid1', engineFlares: [], colorFlares: [] },
  { name: 'Asteroid2', detail: 4, directory: 'Objects/Asteroid2', engineFlares: [], colorFlares: [] },
  { name: 'Asteroid3', detail: 4, directory: 'Objects/Asteroid3', engineFlares: [], colorFlares: [] },
  { name: 'Asteroid4', detail: 4, directory: 'Objects/Asteroid4', engineFlares: [], colorFlares: [] },
  { name: 'Base', detail: 1, directory: 'Objects/Base', engineFlares: [], colorFlares: [] },
  { name: 'Bullet', detail: 1, directory: 'Objects/Bullet', engineFlares: [], colorFlares: [] },
  { name: 'HomingMissile2', detail: 1, directory: 'Objects/HomingMissile2', engineFlares: [], colorFlares: [] },
  { name: 'Flag', detail: 1, directory: 'Objects/Flag', engineFlares: [], colorFlares: [] },
  { name: 'Wheel', detail: 1, directory: 'Objects/Wheel', engineFlares: [], colorFlares: [] },
  { name: 'Sky1', detail: 1, directory: 'Objects/Sky1', engineFlares: [], colorFlares: [] },
  { name: 'Sky2', detail: 1, directory: 'Objects/Sky2', engineFlares: [], colorFlares: [] },
  { name: 'Sky3', detail: 1, directory: 'Objects/Sky3', engineFlares: [], colorFlares: [] },
  { name: 'adRepair', detail: 1, directory: 'Objects/AddonRepair', engineFlares: [], colorFlares: [] },
  { name: 'adShield', detail: 1, directory: 'Objects/AddonShield', engineFlares: [], colorFlares: [] },
  { name: 'adNitro', detail: 1, directory: 'Objects/AddonNitro', engineFlares: [], colorFlares: [] },
  { name: 'adHomingMissile', detail: 1, directory: 'Objects/AddonHomingMissile', engineFlares: [], colorFlares: [] },
  {
    name: 'Fighter3', detail: 1, directory: 'Objects/Fighter3',
    // ModelConfig.xml: 0.07|-0.02|-0.7 and -0.07|-0.02|-0.7.
    engineFlares: [[0.07, -0.02, -0.7], [-0.07, -0.02, -0.7]],
    colorFlares: [[0.7, -0.05, -0.3], [-0.7, -0.05, -0.3]],
  },
];

export const TEXTURES: Record<string, string> = {
  _menubtn: 'System/menubtn', _buttonRU: 'System/buttonRU',
  _aim: 'System/aim',
  _flare1: 'System/flare1', _flare2: 'System/flare2',
  _gold: 'System/gold', _silver: 'System/silver', _bronze: 'System/bronze',
  _backWindow: 'System/backWindow',
  _singlePlayer: 'System/singlePlayer',
  _optionsIcon: 'System/options', _about: 'System/about', _back: 'System/back',
  _timeTrial: 'System/timeTrial', _ctf: 'System/ctf', _easy: 'System/easy', _normal: 'System/normal', _hard: 'System/hard',
  _key: 'System/key', _over: 'System/over',
  _engineLogo: 'System/engineLogo', _gameLogo: 'System/logo',
  _backAnalog: 'Control/backAnalog', _stickAnalog: 'Control/stickAnalog',
  _fireButton: 'Control/fire', _fireButtonHM: 'Control/fireHM',
  _accelAnalog: 'Control/accelAnalog', _nitro: 'Control/nitro',
  _pixel: 'System/pixel', _hexagon: 'System/hexagon',
  // Web-only mode icons (authored in the repo, not from the 2013 content):
  // King of the System's crown also marks the system centre on the HUD.
  _kots: 'Web/kots', _survival: 'Web/survival',
};

export interface TeamCfg {
  name: string;
  color: [number, number, number];
}

export const TEAMS: TeamCfg[] = [
  { name: 'human', color: [64 / 255, 224 / 255, 208 / 255] },
  { name: 'ambient', color: [50 / 255, 205 / 255, 50 / 255] },
  { name: 'alien', color: [1, 0, 0] },
  // Free-for-all competitors (King of the System / Survival, solo): each one
  // fields a single ship, and every competitor is every other's enemy.
  { name: 'falcon', color: [1, 0.78, 0.24] },
  { name: 'viper', color: [0.72, 0.45, 1] },
  { name: 'raptor', color: [0.35, 0.62, 1] },
  { name: 'comet', color: [1, 0.45, 0.25] },
  { name: 'nova', color: [0.45, 1, 0.75] },
];

export const VOICES: { field: string; file: string; text: string }[] = [
  { field: 'welcome', file: 'Welcome', text: 'Welcome to Infinity Edge!' },
  { field: 'youLost', file: 'YouLost', text: 'You Lost!' },
  { field: 'objectiveCompleted', file: 'ObjectiveCompleted', text: 'Objective Completed' },
  { field: 'criticalDamage', file: 'CriticalDamage', text: 'Critical Damage!' },
  { field: 'incomingHomingMissile', file: 'IncomingHomingMissile', text: 'Incoming homing missile!' },
  { field: 'leavingFieldOfBattle', file: 'LeavingFieldOfBattle', text: 'You are leaving the field of battle!' },
  { field: 'missileIncoming', file: 'MissileIncoming', text: 'Missile incoming!' },
  { field: 'newEnemyWave', file: 'NewEnemyWave', text: 'New enemy wave!' },
  { field: 'youWereTeleported', file: 'YouWereTeleported', text: 'You were teleported!' },
  { field: 'ourFlagWasStolen', file: 'OurFlagWasStolen', text: 'Our flag was stolen!' },
  { field: 'targetAquired', file: 'TargetAquired', text: 'Target aquired!' },
  { field: 'teleported', file: 'Teleported', text: 'Teleported!' },
  { field: 'warning', file: 'Warning', text: 'Warning!' },
  { field: 'ourTeamHasTheFlag', file: 'OurTeamHasTheFlag', text: 'Our team has the flag!' },
  { field: 'enemyTeamHasTheFlag', file: 'EnemyTeamHasTheFlag', text: 'Enemy team has the flag!' },
  { field: 'ourTeamRecoveredTheFlag', file: 'OurTeamRecoveredTheFlag', text: 'Our team recovered the flag!' },
  { field: 'enemyTeamRecoveredTheFlag', file: 'EnemyTeamRecoveredTheFlag', text: 'Enemy team recovered the flag!' },
];

export const SFX = [
  'button', 'missileSound', 'bulletSound', 'hitSound', 'addonSound',
  'farExplosion', 'closeExplosion', 'absorbSound',
] as const;
