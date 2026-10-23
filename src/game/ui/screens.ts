// Declarative content for every menu screen, painted by menuui.ts in WebGL.
// Navigation items use route paths as ids; the view dispatches them.

import { store } from '../store';
import { audio } from '../audio';
import { CTF_LEVELS, KOTS_LEVELS, MODE_CAPS, MODE_ICONS, SURV_LEVELS, TT_GROUPS } from '../levels';
import { MODELS, SKIRMISH_TEAMS } from '../config';
import { BOT_AIS } from '../ai';
import type { AgentConfig } from '../agents';
import { resolveAimbot } from '../aimbot';
import { shortKey } from '../social';
import { SHOP_ITEMS, SHOP_SELLER_LUD16, availableAimbotPresets, resolveUnlockedAimbot } from '../shop';
import { satsLabel } from '../wallet';
import { teamDisplayName } from '../team';
import { teamDefaultColor } from '../colors';
import { P } from '../physics';
import type { MenuPanel, MenuRow, MenuScreen, MenuTab, PanelLine } from './menuui';
import type { RosterEntry } from './rosterui';

/** TEAMS / SOLO switch on the King of the System and Survival menus. */
let teamsMode = true;
export function toggleTeamsMode(): void {
  teamsMode = !teamsMode;
}

/** SETTINGS tab: the settings, or the controls reference moved out of the hangar. */
export type OptionsTab = 'settings' | 'controls';
let optionsTab: OptionsTab = 'settings';
export function setOptionsTab(tab: OptionsTab): void {
  optionsTab = tab;
}

/** Keyboard / gamepad / VR reference shown on Settings → Controls. */
const KEYBOARD_CONTROLS: [string, string][] = [
  ['Thrust', 'C'],
  ['Turn / pitch', 'W A S D or arrows'],
  ['Fire cannon', 'Space'],
  ['Homing missile', 'M'],
  ['Nitro', 'Shift or N'],
  ['Back', 'Esc or Backspace'],
];
const GAMEPAD_CONTROLS: [string, string][] = [
  ['Steer', 'Left stick'],
  ['Thrust', 'RT (or A)'],
  ['Fire cannon', 'A'],
  ['Homing missile', 'B'],
  ['Nitro', 'X'],
  ['Pause', 'Start'],
];
const VR_CONTROLS: [string, string][] = [
  ['Look around', 'Move / rotate the device'],
  ['Re-centre', 'Tap the scene'],
  ['Input', 'Gamepad, keyboard or touch'],
];

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
    left: {
      icons: [
        icon('/single-player', 'SINGLE PLAYER', '_singlePlayer.png'),
        icon('/multiplayer', 'MULTIPLAYER', '_multiPlayer.png'),
        icon('/social', 'SOCIAL', '_multiPlayer.png'),
        icon('/hangar', 'HANGAR', 'Fighter3_icon.png'),
        icon('/settings', 'SETTINGS', '_optionsIcon.png'),
        icon('/about', 'ABOUT', '_about.png'),
      ],
    },
  };
}

export function singlePlayer(): MenuScreen {
  return {
    title: 'SINGLE PLAYER',
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
    left: {
      buttons: group.tracks.map((key, i) => ({ id: '/briefing/' + key, label: labels[group.id][i] })),
    },
    right: { watermark: MODE_ICONS[group.id] },
  };
}

// ---------------------------------------------------------------- briefing
/**
 * The briefing carries the whole roster (players + bots) as one shared list —
 * the same roster component the multiplayer waiting room paints. The team
 * filter above it narrows the visible entries to one team; the player's own
 * team is editable, bots keep their AI/TEAM dropdowns and remove control.
 */
let briefingTeamFilter: string | null = 'team1';

/** Set (or clear with null) the briefing roster's team filter. */
export function setBriefingTeamFilter(team: string | null): void {
  briefingTeamFilter = team;
}

export function briefingScreen(
  levelKey: string, text: string, rows: string[], roster: AgentConfig[],
): MenuScreen {
  const players = roster.filter((a) => a.role === 'player');
  const bots = roster.filter((a) => a.role === 'bot' && a.enabled);
  const aiOptions = BOT_AIS.map((a) => ({ value: a.id, label: a.label }));
  const teamOptions = SKIRMISH_TEAMS.map((t) => ({ value: t, label: teamDisplayName(t) }));
  // One entry per combatant, players first — the shared roster component.
  const entries: RosterEntry[] = [
    ...players.map((p): RosterEntry => ({
      id: p.id, name: p.name, team: p.team, teamOptions, badges: ['YOU'],
    })),
    ...bots.map((b): RosterEntry => ({
      id: b.id, name: b.name, team: b.team, teamOptions,
      ai: b.ai, aiOptions, removable: true,
    })),
  ];
  const teamsPresent = [...new Set(entries.map((e) => e.team || SKIRMISH_TEAMS[0]))].sort();
  const active = briefingTeamFilter && teamsPresent.includes(briefingTeamFilter) ? briefingTeamFilter : null;
  const visible = entries.filter((e) => active === null || (e.team || SKIRMISH_TEAMS[0]) === active);
  const rosterRows: MenuRow[] = [
    ...visible.map((e): MenuRow => ({ kind: 'roster', id: e.id, entry: e })),
    { kind: 'button', id: 'agent:add', label: 'Add Bot' },
  ];
  const scores = rows.filter((r) => r.trim().length > 0);
  return {
    title: 'BRIEFING',
    left: {
      heading: `ROSTER · ${visible.length}/${entries.length}`,
      filter: { teams: teamsPresent, active },
      rows: rosterRows,
    },
    right: {
      heading: 'MISSION',
      lines: [
        { text: text || 'No briefing text.', wrap: true, size: 14 },
        { text: 'HIGH SCORES', size: 14, gapBefore: 16, color: 'rgba(255,255,255,0.8)' },
        ...(scores.length > 0
          ? scores.map((r) => ({ text: r, size: 12, gapBefore: 2, color: 'rgba(255,255,255,0.72)' }))
          : [{ text: 'no scores yet', size: 12, gapBefore: 2, color: 'rgba(255,255,255,0.45)' }]),
      ],
      footer: levelKey.startsWith('tt-') ? 'beat the clock, collect the gates' : '',
    },
    primary: { id: 'start', label: 'start' },
  };
}

export function briefingLoading(): MenuScreen {
  return {
    title: 'BRIEFING',
    left: {},
  };
}

// ----------------------------------------------------------------- options
export function optionsMenu(): MenuScreen {
  const tabs: MenuTab[] = [
    { id: 'options-tab:settings', label: 'GENERAL', active: optionsTab === 'settings' },
    { id: 'options-tab:controls', label: 'CONTROLS', active: optionsTab === 'controls' },
  ];
  if (optionsTab === 'controls') {
    const c = store.options;
    return {
      title: 'SETTINGS',
      tabs,
      left: {
        heading: 'CONTROLS',
        rows: [
          {
            kind: 'slider', id: 'dwellTime', label: 'VR Dwell Time', value: c.dwellTime,
            min: 0.5, max: 5, step: 0.1, display: (v) => v.toFixed(1) + ' s',
          },
          { kind: 'check', id: 'axisX', label: 'Invert X axis', value: c.axisX },
          { kind: 'check', id: 'axisY', label: 'Invert Y axis', value: c.axisY },
        ],
        footer: 'Esc = back (unsaved changes are reverted)',
      },
      right: {
        heading: 'KEYBOARD & GAMEPAD',
        lines: [
          { text: 'KEYBOARD', size: 14, gapBefore: 2, color: 'rgba(255,255,255,0.72)' },
          ...KEYBOARD_CONTROLS.map(([left, right]) => ({ left, right, gapBefore: 2 })),
          { text: 'GAMEPAD', size: 14, gapBefore: 14, color: 'rgba(255,255,255,0.72)' },
          ...GAMEPAD_CONTROLS.map(([left, right]) => ({ left, right, gapBefore: 2 })),
          { text: 'VR MODE', size: 14, gapBefore: 14, color: 'rgba(255,255,255,0.72)' },
          ...VR_CONTROLS.map(([left, right]) => ({ left, right, gapBefore: 2 })),
        ],
      },
      primary: { id: 'save', label: 'save' },
    };
  }
  const o = store.options;
  const detailNames = ['Very High', 'High', 'Normal', 'Low', 'Very Low'];
  return {
    title: 'SETTINGS',
    tabs,
    left: {
      heading: 'SETTINGS',
      rows: [
        { kind: 'text', id: 'username', label: 'Username', value: o.username, maxLength: 12 },
        {
          kind: 'color', id: 'team1Color', label: 'Team 1 Colour (you)',
          value: o.teamColors.team1 || o.playerColor,
        },
        {
          kind: 'color', id: 'team2Color', label: 'Team 2 Colour',
          value: o.teamColors.team2 || o.enemyColor,
        },
        {
          kind: 'color', id: 'team3Color', label: 'Team 3 Colour',
          value: o.teamColors.team3 || teamDefaultColor('team3'),
        },
        {
          kind: 'color', id: 'team4Color', label: 'Team 4 Colour',
          value: o.teamColors.team4 || teamDefaultColor('team4'),
        },
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
        { kind: 'check', id: 'partyMode', label: 'Party Mode (music colour)', value: o.partyMode },
      ],
    },
    right: {
      heading: 'DATA',
      rows: [
        {
          kind: 'button', id: 'music', label: 'Music File',
          value: audio.customMusicName() ?? 'Default soundtrack',
        },
        ...(audio.hasCustomMusic()
          ? [{ kind: 'button' as const, id: 'music-reset', label: 'Reset Music' }]
          : []),
        { kind: 'button', id: 'clear', label: 'Clear All' },
        { kind: 'info', text: 'scores, settings, ghost data and the music file', small: true },
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
  // Aimbot selection lives on the ship panel: cycle the preset with the button
  // and read the tuning just above it. Locked shop presets are never selectable:
  // only the free presets plus the ones the player owns are offered.
  const owned = store.ownedItems;
  const available = availableAimbotPresets(owned);
  const aimbot = resolveUnlockedAimbot(store.options.aimbot, owned);
  const aimbotStats: PanelLine[] = [
    { text: 'AIMBOT', size: 15, gapBefore: 14, align: 'center' },
    { left: 'Preset', right: aimbot.label, gapBefore: 2 },
    { left: 'Aim cone', right: `${(Math.acos(aimbot.aimbotAngle) * (180 / Math.PI)).toFixed(0)}°`, gapBefore: 2 },
    { left: 'Range', right: `${aimbot.aimbotDistance} u`, gapBefore: 2 },
    { left: 'Engage stick', right: `≤ ${Math.round(aimbot.aimbotThreshold * 100)}%`, gapBefore: 2 },
    { left: 'Assist', right: `${Math.round(aimbot.assist * 100)}%`, gapBefore: 2 },
    { left: 'Unlocked', right: `${available.length} presets`, gapBefore: 2 },
  ];
  const left: MenuPanel = {
    icons: [{ id: 'noop', label: ship.name.replace(/(\D)(\d)/, '$1 $2').toUpperCase(), icon: 'Fighter3_icon.png' }],
    lines: [
      { text: 'multi-role interceptor', size: 13, align: 'center', color: 'rgba(255,255,255,0.6)' },
      { text: `${satsLabel(store.sats)} · ${store.walletConnected ? 'Lightning linked' : 'no wallet linked'}`, size: 12, align: 'center', gapBefore: 8, color: 'rgba(255,255,255,0.72)' },
      ...aimbotStats,
    ],
    rows: [
      { kind: 'button', id: 'aimbot', label: 'Aimbot preset', value: aimbot.label },
      { kind: 'button', id: '/shop', label: 'Shop', value: satsLabel(store.sats) },
      { kind: 'button', id: '/social', label: 'Social', value: 'identity & messages' },
    ],
  };
  const right: MenuPanel = {
    heading: 'SHIP',
    lines: [
      ...statRows.map(([leftText, rightText]) => ({ left: leftText, right: rightText, gapBefore: 3 })),
      {
        text: 'Keyboard, gamepad and VR controls live under SETTINGS > CONTROLS.',
        size: 12, gapBefore: 20, wrap: true, color: 'rgba(255,255,255,0.5)',
      },
    ],
  };
  return {
    title: 'HANGAR',
    left,
    right,
    actions: [{ id: 'refresh-wallet', label: 'refresh' }],
  };
}

// ------------------------------------------------------------------ social
/**
 * SOCIAL: the player's Nostr identity (npub/nsec, import + copy), the best run
 * of each game mode read from everyone's Nostr score profiles, and the private
 * DM inbox with a small composer.
 */
export function socialMenu(): MenuScreen {
  const scores = store.gameHighScores;
  const scoreLines: PanelLine[] = scores.length > 0
    ? scores.flatMap((s): PanelLine[] => ([
        { text: s.label, size: 13, gapBefore: 8, color: 'rgba(255,255,255,0.85)' },
        {
          left: s.value,
          right: s.name || shortKey(s.owner),
          gapBefore: 2, color: 'rgba(255,255,255,0.7)',
        },
      ]))
    : [{ text: 'no scores on Nostr yet — press refresh', size: 12, color: 'rgba(255,255,255,0.5)' }];
  const identityLines: PanelLine[] = [
    { text: 'npub (public key)', size: 11, color: 'rgba(255,255,255,0.5)' },
    { text: store.identityNpub || '(no identity yet)', wrap: true, size: 12, color: 'rgba(255,255,255,0.8)' },
    { text: 'nsec (secret key — keep private)', size: 11, gapBefore: 6, color: 'rgba(255,255,255,0.5)' },
    {
      text: store.identityRevealed ? (store.identityNsec || '—') : '•'.repeat(24),
      wrap: true, size: 12, color: 'rgba(255,255,255,0.8)',
    },
    {
      text: `${satsLabel(store.sats)} · ${store.walletConnected ? 'Lightning linked' : 'no wallet linked'}`,
      size: 12, gapBefore: 6, color: 'rgba(255,255,255,0.6)',
    },
  ];
  const inbox = store.socialInbox;
  const messageLines: PanelLine[] = inbox.length > 0
    ? inbox.slice(0, 2).flatMap((m): PanelLine[] => ([
        {
          left: shortKey(m.from),
          right: new Date(m.created * 1000).toLocaleTimeString(),
          gapBefore: 4, color: 'rgba(255,255,255,0.55)',
        },
        { text: m.text, wrap: true, size: 13 },
      ]))
    : [{ text: 'no messages yet', size: 12, color: 'rgba(255,255,255,0.5)' }];
  return {
    title: 'SOCIAL',
    left: {
      heading: 'HIGH SCORES',
      lines: [
        ...scoreLines,
        { text: 'LIGHTNING WALLET (NIP-47)', size: 13, gapBefore: 14, color: 'rgba(255,255,255,0.72)' },
        {
          text: store.walletStatus
            || (store.walletConnected ? `${satsLabel(store.sats)} · linked` : 'no wallet linked'),
          size: 12, gapBefore: 2,
          color: store.walletStatus ? '#ffd479' : 'rgba(255,255,255,0.6)',
        },
      ],
      rows: [
        { kind: 'text', id: 'nwc-uri', label: 'NWC URI (nostr+walletconnect://…)', value: store.nwcUri, maxLength: 400 },
        {
          kind: 'button', id: 'wallet-connect', label: 'Link wallet',
          value: store.walletConnected ? satsLabel(store.sats) : 'not linked',
        },
        ...(store.walletConnected
          ? [{ kind: 'button' as const, id: 'wallet-disconnect', label: 'Unlink wallet' }]
          : []),
      ],
    },
    right: {
      heading: 'NOSTR IDENTITY',
      lines: [
        ...identityLines,
        { text: 'MESSAGES', size: 13, gapBefore: 12, color: 'rgba(255,255,255,0.72)' },
        ...messageLines,
        { text: ' ', size: 10, gapBefore: 14 },
      ],
      rows: [
        { kind: 'button', id: 'identity-copy:npub', label: 'Copy npub' },
        { kind: 'button', id: 'identity-copy:nsec', label: 'Copy nsec' },
        { kind: 'text', id: 'identity-nsec', label: 'Import nsec or hex', value: store.identityInput, maxLength: 80 },
        { kind: 'button', id: 'identity-import', label: 'Use this identity' },
        ...(store.identityStatus
          ? [{ kind: 'info' as const, text: store.identityStatus, small: true }]
          : []),
        { kind: 'text', id: 'social-to', label: 'Message to (npub or hex)', value: store.socialTo, maxLength: 80 },
        { kind: 'text', id: 'social-body', label: 'Message', value: store.socialBody, maxLength: 200 },
        { kind: 'button', id: 'social-send', label: 'Send message' },
        ...(store.socialStatus
          ? [{ kind: 'info' as const, text: store.socialStatus, small: true }]
          : []),
      ],
    },
    actions: [{ id: 'refresh-social', label: 'refresh' }],
  };
}

// -------------------------------------------------------------------- shop
/** The SHOP: spend satoshis (Lightning) on stronger aimbot presets. */
export function shopMenu(): MenuScreen {
  const owned = store.ownedItems;
  const rows: MenuRow[] = [
    { kind: 'info', text: `Balance: ${satsLabel(store.sats)}` },
    {
      kind: 'info',
      small: true,
      text: store.walletConnected
        ? `paying ${SHOP_SELLER_LUD16 || 'no seller configured'} over Lightning`
        : 'link a Lightning wallet on the Social page to buy',
    },
    ...(store.shopStatus ? [{ kind: 'info' as const, text: store.shopStatus, small: true }] : []),
  ];
  for (const item of SHOP_ITEMS) {
    const has = owned.includes(item.id);
    const affordable = store.sats === null || store.sats >= item.priceSats;
    const preset = resolveAimbot(item.preset);
    rows.push({
      kind: 'button',
      id: `buy:${item.id}`,
      label: item.label,
      value: has ? 'OWNED' : `${item.priceSats} sats`,
      disabled: has,
    });
    rows.push({
      kind: 'info',
      small: true,
      text: has
        ? `${preset.label} preset unlocked.`
        : `${item.blurb}${affordable ? '' : ' — need more sats'}`,
    });
  }
  const detailLines: PanelLine[] = [
    {
      text: 'Buy premium aimbot presets with satoshis over Lightning. The shop asks the seller for a BOLT-11 invoice and pays it with the wallet linked to your npub; once the payment settles the preset unlocks in the hangar.',
      wrap: true, size: 13, color: 'rgba(255,255,255,0.72)',
    },
    { text: ' ', size: 8 },
  ];
  for (const item of SHOP_ITEMS) {
    const preset = resolveAimbot(item.preset);
    detailLines.push({ text: preset.label.toUpperCase(), size: 14, color: '#ffffff', gapBefore: 10 });
    detailLines.push({ left: 'Price', right: `${item.priceSats} sats`, gapBefore: 2 });
    detailLines.push({ left: 'Aim cone', right: `${(Math.acos(preset.aimbotAngle) * (180 / Math.PI)).toFixed(0)}°`, gapBefore: 2 });
    detailLines.push({ left: 'Range', right: `${preset.aimbotDistance} u`, gapBefore: 2 });
    detailLines.push({ left: 'Assist', right: `${Math.round(preset.assist * 100)}%`, gapBefore: 2 });
  }
  return {
    title: 'SHOP',
    left: { heading: 'ITEMS', rows },
    right: { heading: 'DETAILS', lines: detailLines },
    actions: [{ id: 'refresh-wallet', label: 'refresh' }],
  };
}

// ------------------------------------------------------------------- pause
/** The in-match pause screen: the same WebGL menu chrome as every other
 *  screen, drawn over the frozen match. HUD and flight input are hidden until
 *  the player resumes. */
export function pauseMenu(): MenuScreen {
  // The pause menu is the one runtime screen that switches the generic plane's
  // action column back on: every paused action lives there, not in the content
  // panel, so the frozen match keeps the whole left side.
  return {
    title: 'PAUSED',
    left: {
      heading: 'MATCH PAUSED',
      lines: [
        {
          text: 'The simulation is frozen. Use the actions column to resume, change settings or leave the match.',
          size: 14,
          wrap: true,
        },
      ],
    },
    primary: { id: 'pause:resume', label: 'resume' },
    actions: [{ id: 'pause:settings', label: 'settings' }],
    backLabel: 'leave match',
    showActions: true,
  };
}

// ------------------------------------------------------------------ result
export function resultMenu(won: boolean, message: string | null, medal: string | null, draw = false): MenuScreen {
  const lines = [];
  if (draw) lines.push({ text: 'The match is a draw.', size: 20, align: 'center' as const });
  else if (won) lines.push({ text: `Congratulations ${username()}!`, size: 20, align: 'center' as const });
  if (message) lines.push({ text: message, size: 17, align: 'center' as const, gapBefore: 10 });
  return {
    title: draw ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT',
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
