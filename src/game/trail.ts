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
}

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

/** Record a visit: append, or truncate back to an entry we are returning to. */
export function visitTrail(path: string, label: string): void {
  const at = trail.items.findIndex((e) => e.path === path);
  if (at >= 0) {
    trail.items.splice(at + 1);
    trail.items[at].label = label;
    return;
  }
  trail.items.push({ path, label });
  if (trail.items.length > 12) trail.items.shift();
}
