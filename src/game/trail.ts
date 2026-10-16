// Navigation trail for the menu breadcrumb.
//
// The router only exposes the immediate back entry, so the clickable path is
// tracked here: screens are appended as they are visited and truncated back to
// the matching entry when you return to one. The trail mirrors the LIFO stack,
// so a breadcrumb click is a router.go(-n) pop rather than a push.
import { reactive } from 'vue';

export interface TrailEntry {
  path: string;
  label: string;
  /** True for entries rebuilt from a deep link: they are not in the browser's
   *  history, so clicking them pushes instead of popping. */
  synth?: boolean;
}

const STORAGE_KEY = 'ie3d.trail';

export const trail = reactive<{ items: TrailEntry[] }>({ items: [] });

/** Short, human labels for the routes that appear in the menus. */
export function trailLabel(name: string, param?: string): string {
  switch (name) {
    case 'boot': case 'engine': case 'start': return 'ENGINE';
    case 'menu': return 'MAIN MENU';
    case 'single': return 'SINGLE PLAYER';
    case 'ctf': return 'CAPTURE THE FLAG';
    case 'tt': return 'TIME TRIAL';
    case 'tracks': return param ? param.toUpperCase() : 'TRACKS';
    case 'kots': return 'KING OF THE SYSTEM';
    case 'survival': return 'SURVIVAL';
    case 'briefing': return 'BRIEFING';
    case 'game': return 'MATCH';
    case 'hangar': return 'HANGAR';
    case 'options': case 'settings': return 'OPTIONS';
    case 'about': return 'ABOUT';
    case 'victory': return 'VICTORY';
    case 'defeat': return 'DEFEAT';
    default: return name.toUpperCase();
  }
}

function persist(): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(trail.items));
  } catch { /* private mode */ }
}

/** Record a visit: append, or truncate back to an entry we are returning to. */
export function visitTrail(path: string, label: string): void {
  const at = trail.items.findIndex((e) => e.path === path);
  if (at >= 0) {
    trail.items.splice(at + 1);
    trail.items[at].label = label;
    delete trail.items[at].synth;
    persist();
    return;
  }
  trail.items.push({ path, label });
  if (trail.items.length > 12) trail.items.shift();
  persist();
}

/** The mode menu for a level key, e.g. 'tt-easy-01' -> ['/tt', 'TIME TRIAL']. */
export function modeForLevel(level: string): { path: string; label: string } {
  if (level.startsWith('tt-')) return { path: '/tt', label: 'TIME TRIAL' };
  if (level.startsWith('ctf-')) return { path: '/ctf', label: 'CAPTURE THE FLAG' };
  if (level.startsWith('kots-')) return { path: '/kots', label: 'KING OF THE SYSTEM' };
  if (level.startsWith('surv-')) return { path: '/survival', label: 'SURVIVAL' };
  return { path: '/single-player', label: 'SINGLE PLAYER' };
}

/**
 * Rebuild the trail after a page load. The in-memory trail is gone, but the
 * browser history and its state survive, so:
 *  - a stored trail (sessionStorage) is used when it still ends at this route
 *    (or contains it earlier: the user pressed reload after going back),
 *  - a deep link that has no trail gets its ancestry synthesised from the
 *    route itself, so the breadcrumb is complete and clickable again.
 * Boot/engine screens are ignored.
 */
export function restoreTrail(path: string, name: string, param?: string, diff?: string): void {
  if (trail.items.length > 0) { visitTrail(path, trailLabel(name, diff ?? param)); return; }
  let stored: TrailEntry[] = [];
  try {
    stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]') as TrailEntry[];
  } catch { stored = []; }
  const known = stored.filter((e) => e && typeof e.path === 'string' && typeof e.label === 'string');
  const at = known.findIndex((e) => e.path === path);
  if (at >= 0) {
    // Reloaded on a screen we had already visited: keep the trail up to it.
    trail.items.push(...known.slice(0, at).map((e) => ({ ...e, synth: false })));
    visitTrail(path, trailLabel(name, diff ?? param));
    return;
  }
  if (known.length > 0) {
    // Reloaded elsewhere: keep what we know, then continue from here.
    trail.items.push(...known.map((e) => ({ ...e, synth: false })));
    visitTrail(path, trailLabel(name, diff ?? param));
    return;
  }
  // Cold deep link: synthesise the ancestry.
  const ancestry: TrailEntry[] = [];
  const add = (p: string, l: string) => ancestry.push({ path: p, label: l, synth: true });
  if (name !== 'menu' && name !== 'boot' && name !== 'engine' && name !== 'start') add('/menu', 'MAIN MENU');
  if (name === 'briefing' || name === 'game') {
    const level = param ?? '';
    const mode = modeForLevel(level);
    if (level.startsWith('tt-')) {
      const parts = level.split('-');
      add('/single-player', 'SINGLE PLAYER');
      add('/tt', 'TIME TRIAL');
      add('/tt/' + (parts[1] ?? ''), (parts[1] ?? '').toUpperCase());
    } else {
      add('/single-player', 'SINGLE PLAYER');
      add(mode.path, mode.label);
    }
  } else if (name === 'tracks') {
    add('/single-player', 'SINGLE PLAYER');
    add('/tt', 'TIME TRIAL');
  } else if (name === 'ctf' || name === 'tt' || name === 'kots' || name === 'survival') {
    add('/single-player', 'SINGLE PLAYER');
  }
  trail.items.push(...ancestry);
  visitTrail(path, trailLabel(name, diff ?? param));
}
