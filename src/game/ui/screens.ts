// Declarative content for every menu screen, painted by menuui.ts in WebGL.
// Navigation items use route paths as ids; the view dispatches them.

import { store } from '../store';
import { audio } from '../audio';
import { CTF_LEVELS, KOTS_LEVELS, MODE_CAPS, MODE_ICONS, SURV_LEVELS, TT_GROUPS } from '../levels';
import { MODELS } from '../config';
import { P } from '../physics';
import type { MenuPanel, MenuScreen } from './menuui';

/** TEAMS / SOLO switch on the King of the System and Survival menus. */
let teamsMode = true;
export function toggleTeamsMode(): void {
  teamsMode = !teamsMode;
}

function icon(id: string, label: string, file: string) {
  return { id, label, icon: file };
}

function username(): string {
  return store.username || store.options.username || 'Infinity Fan';
}

// --------------------------------------------------------------- main menus
export function mainMenu(): MenuScreen {
  return {
    title: 'MAIN MENU',
    subtitle: `pilot ${username()} · Infinity Edge 3.7`,
    left: {
      icons: [
        icon('/single-player', 'SINGLE PLAYER', '_singlePlayer.png'),
        icon('/hangar', 'HANGAR', 'Fighter3_icon.png'),
        icon('/options', 'OPTIONS', '_optionsIcon.png'),
        icon('/about', 'ABOUT', '_about.png'),
      ],
      buttons: [{ id: '/multiplayer', label: 'MULTIPLAYER' }],
    },
  };
}

export function singlePlayer(): MenuScreen {
  return {
    title: 'SINGLE PLAYER',
    subtitle: `pilot ${username()}`,
    left: {
      icons: [
        icon('/ctf', 'CAPTURE THE FLAG', '_ctf.png'),
        icon('/tt', 'TIME TRIAL', '_timeTrial.png'),
        icon('/kots', 'KING OF THE SYSTEM', '_kots.png'),
        icon('/survival', 'SURVIVAL', '_survival.png'),
      ],
    },
  };
}

export function ctfMenu(): MenuScreen {
  return {
    title: 'CAPTURE THE FLAG',
    subtitle: 'choose a difficulty',
    left: {
      icons: [
        icon('/briefing/' + CTF_LEVELS[0], 'PEGASUS', '_easy.png'),
        icon('/briefing/' + CTF_LEVELS[1], 'LEO', '_normal.png'),
        icon('/briefing/' + CTF_LEVELS[2], 'DRACO', '_hard.png'),
      ],
    },
  };
}

export function timeTrialMenu(): MenuScreen {
  return {
    title: 'TIME TRIAL',
    subtitle: 'choose a race class',
    left: {
      icons: [
        icon('/tt/easy', 'PEGASUS', '_easy.png'),
        icon('/tt/normal', 'LEO', '_normal.png'),
        icon('/tt/hard', 'DRACO', '_hard.png'),
      ],
    },
  };
}

export function modeMenu(mode: 'kots' | 'surv'): MenuScreen {
  const levels = mode === 'surv' ? SURV_LEVELS : KOTS_LEVELS;
  const keys = teamsMode ? levels.teams : levels.solo;
  const diffs = ['easy', 'normal', 'hard'] as const;
  return {
    title: mode === 'surv' ? 'SURVIVAL' : 'KING OF THE SYSTEM',
    subtitle: teamsMode ? 'teams' : 'solo',
    left: {
      icons: keys.map((key, i) =>
        icon('/briefing/' + key, MODE_CAPS[diffs[i]], MODE_ICONS[diffs[i]])),
      buttons: [{ id: 'mode-toggle', label: teamsMode ? 'TEAMS' : 'SOLO' }],
    },
  };
}

export function tracksMenu(diff: string): MenuScreen {
  const group = TT_GROUPS.find((g) => g.id === diff) ?? TT_GROUPS[0];
  const labels: Record<string, string[]> = {
    easy: ['Track 01', 'Track 02', 'Track 03', 'Track 04', 'Track 05'],
    normal: ['Track 01', 'Track 02', 'Track 03', 'Track 04'],
    hard: ['Demo Track'],
  };
  return {
    title: 'TIME TRIAL · ' + group.label,
    subtitle: 'choose a track',
    left: {
      buttons: group.tracks.map((key, i) => ({ id: '/briefing/' + key, label: labels[group.id][i] })),
    },
    right: { watermark: MODE_ICONS[group.id] },
  };
}

// ---------------------------------------------------------------- briefing
export function briefingScreen(levelKey: string, text: string, rows: string[]): MenuScreen {
  return {
    title: 'BRIEFING',
    subtitle: levelKey,
    left: {
      heading: 'High Scores',
      table: { rows: rows.length > 0 ? rows : [''] },
      footer: levelKey.startsWith('tt-') ? 'beat the clock, collect the gates' : '',
    },
    right: {
      heading: 'MISSION',
      lines: [{ text: text || 'No briefing text.', wrap: true, size: 14 }],
    },
    primary: { id: 'start', label: 'start' },
  };
}

export function briefingLoading(): MenuScreen {
  return {
    title: 'BRIEFING',
    subtitle: 'loading…',
    left: {},
  };
}

// ----------------------------------------------------------------- options
export function optionsMenu(): MenuScreen {
  const o = store.options;
  const detailNames = ['Very High', 'High', 'Normal', 'Low', 'Very Low'];
  return {
    title: 'OPTIONS',
    subtitle: 'changes apply live — SAVE keeps them',
    left: {
      heading: 'SETTINGS',
      rows: [
        { kind: 'text', id: 'username', label: 'Username', value: o.username, maxLength: 12 },
        {
          kind: 'slider', id: 'distance', label: 'Draw Distance', value: o.distance,
          min: 128, max: 512, step: 1, display: (v) => String(Math.round(v)),
        },
        {
          kind: 'slider', id: 'detail', label: '3D Detail', value: o.detail,
          min: 0, max: 4, step: 1, display: (v) => detailNames[Math.round(v)] ?? '',
        },
        {
          kind: 'slider', id: 'musicVolume', label: 'Music Volume', value: o.musicVolume,
          min: 0, max: 1, step: 0.05, display: (v) => Math.round(v * 100) + '%',
        },
        { kind: 'check', id: 'billboards', label: 'Special Effects', value: o.billboards },
        { kind: 'check', id: 'zoomBlur', label: 'Speed Blur', value: o.zoomBlur },
        { kind: 'check', id: 'showMs', label: 'Frame Time (ms)', value: o.showMs },
      ],
    },
    right: {
      heading: 'CONTROLS & DATA',
      rows: [
        { kind: 'button', id: 'vr', label: 'VR Mode', value: store.vr ? 'ON' : 'OFF' },
        { kind: 'check', id: 'axisX', label: 'Invert X axis', value: o.axisX },
        { kind: 'check', id: 'axisY', label: 'Invert Y axis', value: o.axisY },
        {
          kind: 'button', id: 'music', label: 'Music File',
          value: audio.customMusicName() ?? 'Default soundtrack',
        },
        ...(audio.hasCustomMusic()
          ? [{ kind: 'button' as const, id: 'music-reset', label: 'Reset Music' }]
          : []),
        { kind: 'button', id: 'clear', label: 'Clear All' },
        { kind: 'info', text: 'scores, options, ghost data and the music file', small: true },
      ],
      footer: 'Esc = back (unsaved changes are reverted)',
    },
    primary: { id: 'save', label: 'save' },
  };
}

// ------------------------------------------------------------------- about
export function aboutMenu(): MenuScreen {
  return {
    title: 'ABOUT',
    left: {
      lines: [
        { text: 'Infinity Edge (1.0.1)', color: '#32cd32', size: 20, align: 'center' },
        { text: ' ', size: 10 },
        { text: '=== GRAPHICS ===', color: '#ffff00', size: 16, align: 'center' },
        { text: 'Goncalo Rocha', size: 13, align: 'center' },
        { text: 'Nikhil Bhatt', size: 13, align: 'center' },
        { text: 'Henrique Rocha', color: 'rgba(255,255,255,0.6)', size: 13, align: 'center' },
        { text: ' ', size: 10 },
        { text: '=== SOUNDS ===', color: '#ffff00', size: 16, align: 'center' },
        { text: 'Ricardo Abreu', size: 13, align: 'center' },
        { text: ' ', size: 10 },
        { text: '=== PROGRAMMERS ===', color: '#ffff00', size: 16, align: 'center' },
        { text: 'Henrique Rocha', size: 13, align: 'center' },
        { text: 'Nikhil Bhatt', color: 'rgba(255,255,255,0.6)', size: 13, align: 'center' },
        { text: ' ', size: 10 },
        { text: '=== SPECIAL THANKS ===', color: '#ffff00', size: 16, align: 'center' },
        { text: 'Microsoft @ Lisbon Experience', size: 13, align: 'center' },
        { text: ' ', size: 10 },
        { text: 'web migration: WebGL2, Vue 3, WebRTC multiplayer', color: 'rgba(255,255,255,0.45)', size: 12, align: 'center' },
      ],
    },
  };
}

// ------------------------------------------------------------------ hangar
export function hangarMenu(): MenuScreen {
  const ship = MODELS.find((m) => m.name === 'Fighter3') ?? MODELS[0];
  const phys = P.SS1;
  const statRows = [
    ['Hull', '100 | 100 | 100'],
    ['Top speed', `${phys.velMax} u/s`],
    ['Thrust', `${phys.accelMax} u/s²`],
    ['Turn rate', `${(phys.maxAngular * (180 / Math.PI)).toFixed(1)}° / frame`],
    ['Cannon', '2 mounts, 200 ms cycle'],
    ['Homing missiles', '2 carried, 2 per pickup'],
    ['Nitro', '3 s burn at 7.5× thrust'],
    ['Shield', 'absorbs 10 hits'],
    ['Repair', 'restores the full hull'],
  ];
  const controls = [
    ['Thrust', 'C'],
    ['Turn / pitch', 'W A S D or arrows'],
    ['Fire cannon', 'Space'],
    ['Homing missile', 'M'],
    ['Nitro', 'Shift or N'],
    ['Back', 'Esc or Backspace'],
  ];
  const padControls = [
    ['Steer', 'Left stick'],
    ['Thrust', 'RT (or A)'],
    ['Fire cannon', 'A'],
    ['Homing missile', 'B'],
    ['Nitro', 'X'],
    ['Pause', 'Start'],
  ];
  const left: MenuPanel = {
    icons: [{ id: 'noop', label: ship.name.replace(/(\D)(\d)/, '$1 $2').toUpperCase(), icon: 'Fighter3_icon.png' }],
    lines: [
      { text: 'multi-role interceptor', size: 13, align: 'center', color: 'rgba(255,255,255,0.6)' },
    ],
  };
  const right: MenuPanel = {
    heading: 'SHIP',
    lines: [
      ...statRows.map(([leftText, rightText]) => ({ left: leftText, right: rightText, gapBefore: 3 })),
      { text: 'CONTROLS', size: 15, gapBefore: 16, align: 'center' },
      ...controls.map(([leftText, rightText]) => ({ left: leftText, right: rightText, gapBefore: 2 })),
      { text: 'GAMEPAD', size: 15, gapBefore: 16, align: 'center' },
      ...padControls.map(([leftText, rightText]) => ({ left: leftText, right: rightText, gapBefore: 2 })),
      { text: 'VR MODE', size: 15, gapBefore: 16, align: 'center' },
      { left: 'Look around', right: 'Move / rotate the device', gapBefore: 2 },
      { left: 'Re-centre', right: 'Tap the scene', gapBefore: 2 },
      { left: 'Input', right: 'Gamepad, keyboard or touch', gapBefore: 2 },
    ],
  };
  return { title: 'HANGAR', subtitle: 'your ship and its numbers', left, right };
}

// ------------------------------------------------------------------ result
export function resultMenu(won: boolean, message: string | null, medal: string | null): MenuScreen {
  const lines = [];
  if (won) lines.push({ text: `Congratulations ${username()}!`, size: 20, align: 'center' as const });
  if (message) lines.push({ text: message, size: 17, align: 'center' as const, gapBefore: 10 });
  return {
    title: won ? 'VICTORY' : 'DEFEAT',
    left: { lines },
    right: medal
      ? { icons: [{ id: 'medal', label: '', icon: medal }] }
      : undefined,
  };
}

// ------------------------------------------------------------------ misc
export function notFound(): MenuScreen {
  return { title: '', empty: true, primary: { id: 'menu', label: 'menu' }, backLabel: 'exit' };
}

export function bootScreen(routeName: string, loading: { done: number; total: number } | null): MenuScreen {
  return {
    title: '',
    wordmark: routeName === 'engine' ? 'Floating Gear' : 'Infinity Edge',
    loading,
    empty: true,
    hideChrome: true,
  };
}
