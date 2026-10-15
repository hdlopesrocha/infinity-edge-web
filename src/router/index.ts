import { createRouter, createWebHashHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';
import { syncSceneState } from '../game/store';

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'boot', component: () => import('../views/BootView.vue') },
  { path: '/engine', name: 'engine', component: () => import('../views/BootView.vue') },
  { path: '/start', name: 'start', component: () => import('../views/BootView.vue') },
  { path: '/menu', name: 'menu', component: () => import('../views/MainMenuView.vue') },
  { path: '/single-player', name: 'single', component: () => import('../views/SinglePlayerView.vue') },
  { path: '/ctf', name: 'ctf', component: () => import('../views/CtfMenuView.vue') },
  { path: '/tt', name: 'tt', component: () => import('../views/TimeTrialMenuView.vue') },
  { path: '/kots', name: 'kots', component: () => import('../views/ModeMenuView.vue') },
  { path: '/survival', name: 'survival', component: () => import('../views/ModeMenuView.vue') },
  { path: '/tt/:diff', name: 'tracks', component: () => import('../views/TracksView.vue') },
  { path: '/briefing/:level', name: 'briefing', component: () => import('../views/BriefingView.vue') },
  { path: '/game/:level', name: 'game', component: () => import('../views/GameView.vue') },
  { path: '/options', name: 'options', component: () => import('../views/OptionsView.vue') },
  { path: '/settings', redirect: '/options' },
  { path: '/about', name: 'about', component: () => import('../views/AboutView.vue') },
  { path: '/victory/:level', name: 'victory', component: () => import('../views/ResultView.vue') },
  { path: '/defeat/:level', name: 'defeat', component: () => import('../views/ResultView.vue') },
  { path: '/:pathMatch(.*)*', name: 'notfound', component: () => import('../views/NotFoundView.vue') },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

router.afterEach((to) => {
  const name = String(to.name ?? 'notfound');
  const param = typeof to.params.level === 'string' ? to.params.level : undefined;
  syncSceneState(name, param);
});
