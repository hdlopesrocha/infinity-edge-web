import { createRouter, createWebHashHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';
import { syncSceneState } from '../game/store';
import { restoreTrail } from '../game/trail';

// Every menu route renders through MenuView (the WebGL menu host); the match
// keeps GameView (HUD) and the lobby keeps MultiplayerView.
const menu = () => import('../views/MenuView.vue');

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'boot', component: menu },
  { path: '/engine', name: 'engine', component: menu },
  { path: '/start', name: 'start', component: menu },
  { path: '/menu', name: 'menu', component: menu },
  { path: '/multiplayer', name: 'multiplayer', component: () => import('../views/MultiplayerView.vue') },
  { path: '/single-player', name: 'single', component: menu },
  { path: '/ctf', name: 'ctf', component: menu },
  { path: '/tt', name: 'tt', component: menu },
  { path: '/kots', name: 'kots', component: menu },
  { path: '/survival', name: 'survival', component: menu },
  { path: '/tt/:diff', name: 'tracks', component: menu },
  { path: '/briefing/:level', name: 'briefing', component: menu },
  { path: '/game/:level', name: 'game', component: () => import('../views/GameView.vue') },
  { path: '/hangar', name: 'hangar', component: menu },
  { path: '/options', name: 'options', component: menu },
  { path: '/settings', redirect: '/options' },
  { path: '/about', name: 'about', component: menu },
  { path: '/victory/:level', name: 'victory', component: menu },
  { path: '/defeat/:level', name: 'defeat', component: menu },
  { path: '/:pathMatch(.*)*', name: 'notfound', component: menu },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

router.afterEach((to) => {
  const name = String(to.name ?? 'notfound');
  const param = typeof to.params.level === 'string' ? to.params.level : undefined;
  syncSceneState(name, param);
  // The boot screens are transient: they should not appear in the breadcrumb.
  if (name === 'boot' || name === 'engine' || name === 'start') return;
  restoreTrail(to.path, name, param, typeof to.params.diff === 'string' ? to.params.diff : undefined);
});
