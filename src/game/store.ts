// Vue store: options mirror, nav state, scores (LoadScores/AddScore).

import { reactive } from 'vue';
import { defaultOptions, clearGameData as rcClearGameData, saveOptions as rcSaveOptions } from './resources';
import type { Options } from './resources';
import { GameScore } from './team';
import type { ScoreEntry, ScoreType } from './team';

/** Item ownership, persisted in localStorage (the Shop mirrors this list). */
const OWNED_KEY = 'ie.shop.owned';

/** Owned shop item ids, read from localStorage. */
export function loadOwnedItems(): string[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(OWNED_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Persist the owned shop item ids (deduplicated). */
export function saveOwnedItems(items: readonly string[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(OWNED_KEY, JSON.stringify([...new Set(items)]));
  } catch { /* private mode */ }
}

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
  /** Enemy marker: gets a 1 px inset border in the opposite team colour. */
  enemy: boolean;
  color: [number, number, number];
  label: string | null;
}

/** One skirmish bot roster entry is now `AgentConfig` (see game/agents.ts);
 *  the per-level rosters live in `agentRosters`, not in the store. */

export const store = reactive({
  options: defaultOptions() as Options,
  route: 'boot' as string,
  sceneKey: 'background' as string,
  levelKey: '' as string,
  interactive: false,
  /** True while the WebGL pause menu is open: the world stops, the scene
   *  keeps rendering so option changes are visible behind it. */
  paused: false,
  /** Network pause: the match is frozen because a guest disconnected. */
  netPaused: false,
  /** Names of the guests the frozen match is waiting for. */
  netPausedBy: '',
  /** True when this client is the host (it may drop a missing guest). */
  netPausedHost: false,
  /** Bumped to force GameCanvas to rebuild the NetGame (guest reconnect). */
  sceneEpoch: 0,
  /** VR mode: head-tracked view, gamepad-only input (see game/vr.ts). */
  vr: false,
  /** The HUD (score, clock, aim, life, markers) renders in GL as stage 5 of
   *  the final pass; the DOM keeps only the touch controls and the menus. */
  glUi: true,
  /** Briefing high-score board, published while the briefing is open so the
   *  GL UI can render it per eye in VR (the DOM list is hidden there). */
  scoreboard: null as { title: string; rows: string[] } | null,
  username: '' as string,
  levelText: '' as string,
  /** Social: the best run of each game mode, read from Nostr score profiles. */
  gameHighScores: [] as import('./social').GameHighScore[],
  /** Social: received human DMs, newest first. */
  socialInbox: [] as import('./social').InboxMessage[],
  /** Social: status / error line under the message composer. */
  socialStatus: '' as string,
  /** Social: recipient (npub or hex) and message body being composed. */
  socialTo: '' as string,
  socialBody: '' as string,
  result: null as { won: boolean; draw?: boolean; reward: string; message: string | null; level: string } | null,
  /** Lightning balance in satoshis of the wallet linked to our npub. */
  sats: null as number | null,
  /** True when a NIP-47 (NWC) wallet is linked. */
  walletConnected: false as boolean,
  /** Wallet status / error line. */
  walletStatus: '' as string,
  /** The `nostr+walletconnect://` URI being edited. */
  nwcUri: '' as string,
  /** Nostr identity shown on the Social page (mirrored from the mp manager). */
  identityNpub: '' as string,
  identityNsec: '' as string,
  identityRevealed: false as boolean,
  /** The nsec / hex being entered in the import field. */
  identityInput: '' as string,
  identityStatus: '' as string,
  /** Shop: status line for purchases and wallet actions. */
  shopStatus: '' as string,
  /** Owned shop item ids; each unlocks one premium aimbot preset. */
  ownedItems: loadOwnedItems() as string[],
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
    /** Live player-team accent for timers, buttons and action labels. */
    accent: [64 / 255, 224 / 255, 208 / 255] as [number, number, number],
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
    /** Ship speed in world units per second (0 = no ship). */
    speed: 0,
    /** A homing missile is locked on the player's ship. */
    missileWarn: false,
    /** An enemy is under the crosshair inside missile range. */
    lockOn: false,
    /** The spaceship auto-aim is currently steering at an enemy. */
    aimbot: false,
    /** Pre-match countdown in seconds (0 = running). */
    countdown: 0,
    /** How the player's ship was destroyed (empty when alive). */
    deathCause: '',
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
    /** Smoothed display frame interval (ms), shown on the GL HUD. */
    frameMs: 0,
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
    routeName === 'game' || routeName === 'briefing'
      || routeName === 'victory' || routeName === 'defeat' || routeName === 'draw'
      ? (param ?? '')
      : '';
  store.interactive = routeName === 'game';
}

export function syncOptionsFromRC(o: Options): void {
  // Mutate the reactive mirror instead of replacing it: the Options screen
  // and the pause menu read this object live and must see the values loaded
  // by the game canvas after they mount.
  Object.assign(store.options, o);
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
