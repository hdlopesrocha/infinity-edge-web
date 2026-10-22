import { createRouter, createWebHashHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';
import { store, syncSceneState } from '../game/store';
import { restoreTrail } from '../game/trail';
import { armBackGuard } from '../game/backguard';

// Every menu route renders through MenuView (the WebGL menu host); the match
// keeps GameView (HUD), the lobby keeps MultiplayerView and browser-hosted
// rooms wait in RoomView (the room menu: roster, teams, chat, voice).
const menu = () => import('../views/MenuView.vue');

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'boot', component: menu },
  { path: '/engine', name: 'engine', component: menu },
  { path: '/start', name: 'start', component: menu },
  { path: '/menu', name: 'menu', component: menu },
  { path: '/social', name: 'social', component: menu },
  { path: '/multiplayer', name: 'multiplayer', component: () => import('../views/MultiplayerView.vue') },
  { path: '/room', name: 'room', component: () => import('../views/RoomView.vue') },
  { path: '/single-player', name: 'single', component: menu },
  { path: '/ctf', name: 'ctf', component: menu },
  { path: '/tt', name: 'tt', component: menu },
  { path: '/kots', name: 'kots', component: menu },
  { path: '/survival', name: 'survival', component: menu },
  { path: '/tt/:diff', name: 'tracks', component: menu },
  { path: '/briefing/:level', name: 'briefing', component: menu },
  { path: '/game/:level', name: 'game', component: () => import('../views/GameView.vue') },
  { path: '/hangar', name: 'hangar', component: menu },
  { path: '/shop', name: 'shop', component: menu },
  { path: '/settings', name: 'settings', component: menu },
  { path: '/options', redirect: '/settings' },
  { path: '/about', name: 'about', component: menu },
  { path: '/victory/:level', name: 'victory', component: menu },
  { path: '/defeat/:level', name: 'defeat', component: menu },
  { path: '/draw/:level', name: 'draw', component: menu },
  { path: '/:pathMatch(.*)*', name: 'notfound', component: menu },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

/**
 * Explicit leave permission. The pause menu's "leave match" sets this just
 * before navigating, so the accidental-back guard below lets it through.
 */
let gameExitAllowed = false;
export function allowGameExit(): void {
  gameExitAllowed = true;
}

// A controller button or browser Back must never drop a live match by
// accident. Leaving is only allowed from the pause menu or a finished match.
router.beforeEach((to, from) => {
  const name = String(to.name ?? '');
  if (name === 'victory' || name === 'defeat' || name === 'draw') return true;
  if (from.path.startsWith('/game') && store.interactive && !store.paused) {
    if (!gameExitAllowed) return false;
    gameExitAllowed = false;
  }
  return true;
});

router.afterEach((to) => {
  const name = String(to.name ?? 'notfound');
  const param = typeof to.params.level === 'string' ? to.params.level : undefined;
  syncSceneState(name, param);
  // The boot screens are transient: they should not appear in the breadcrumb.
  if (name === 'boot' || name === 'engine' || name === 'start') {
    armBackGuard();
    return;
  }
  restoreTrail(to.path, name, param, typeof to.params.diff === 'string' ? to.params.diff : undefined);
  armBackGuard();
});
