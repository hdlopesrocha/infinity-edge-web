<!-- Game HUD + corner buttons (Description tag chrome). -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { GameInstance, PointerMark } from '../game/instance';
import { Life3 } from '../game/life';
import { store } from '../game/store';
import { audio } from '../game/audio';

const route = useRoute();
const router = useRouter();
const base = (import.meta.env.BASE_URL + 'assets/textures/').replace(/([^:])\/\//g, '$1/');

function game(): GameInstance | null {
  return (window as unknown as { __ieGame?: GameInstance }).__ieGame ?? null;
}

const hud = reactive({
  score: '', notify: '', aimX: 0, aimY: 0, lifeHtml: '',
  homings: 0, nitroPct: 0, stickOn: false,
  backX: 0, backY: 0, knobX: 0, knobY: 0, acel: 0,
  pointers: [] as PointerMark[], canvasW: 1280, canvasH: 720,
});

const layerRef = ref<HTMLDivElement | null>(null);
let timer = 0;

function lifeBar(): string {
  const sel = game()?.selectedObject;
  if (!sel || !sel.life) return '';
  const col = (v: number, max: number) => {
    const p = max === 0 ? 0 : Math.max(0, v / max);
    const r = (((1 * (1 - p) + 0.2 * p) / 2) * 0.7 * 255) | 0;
    const gg = (((0.27 * (1 - p) + 0.8 * p) / 2) * 0.7 * 255) | 0;
    const b = (((0 * (1 - p) + 0.2 * p) / 2) * 0.7 * 255) | 0;
    return `rgb(${r},${gg},${b})`;
  };
  if (sel.life instanceof Life3) {
    const l = sel.life;
    return `<div style="width:150px;height:16px;background:rgba(0,0,0,0.5);display:flex;gap:4px;padding:4px;">` +
      `<div style="width:44px;height:8px;background:${col(l.left, l.maxLeft)};"></div>` +
      `<div style="width:44px;height:8px;background:${col(l.center, l.maxCenter)};"></div>` +
      `<div style="width:44px;height:8px;background:${col(l.right, l.maxRight)};"></div>` +
      `</div>`;
  }
  return `<div style="width:50px;height:16px;background:rgba(0,0,0,0.5);padding:4px;">` +
    `<div style="width:42px;height:8px;background:${col(sel.life.total(), sel.life instanceof Life3 ? 1 : 100)};"></div></div>`;
}

function refresh(): void {
  const g = game();
  if (!g || g.gameType === 'BACK') return;
  hud.score = g.scoreText();
  hud.notify = g.notificationText;
  const aim = g.aimPos();
  hud.aimX = aim.x;
  hud.aimY = aim.y;
  hud.lifeHtml = lifeBar();
  hud.homings = g.control.homings;
  hud.nitroPct = Math.floor(g.control.nitroFrac * 100);
  hud.stickOn = g.control.analogStick.enabled;
  hud.backX = g.control.analogStick.backX;
  hud.backY = g.control.analogStick.backY;
  hud.knobX = g.control.analogStick.stickX;
  hud.knobY = g.control.analogStick.stickY;
  hud.acel = g.control.analogAcel.value;
  hud.pointers = g.pointers();
  hud.canvasW = g.canvasW;
  hud.canvasH = g.canvasH;
}

function layerPos(e: PointerEvent): { x: number; y: number } {
  const r = layerRef.value!.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function onDown(e: PointerEvent): void {
  audio.unlock();
  const g = game();
  if (!g) return;
  g.control.touches.set(e.pointerId, layerPos(e));
  (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
}

function onMove(e: PointerEvent): void {
  const g = game();
  if (!g || !g.control.touches.has(e.pointerId)) return;
  g.control.touches.set(e.pointerId, layerPos(e));
}

function onUp(e: PointerEvent): void {
  game()?.control.touches.delete(e.pointerId);
}

function onKey(e: KeyboardEvent): void {
  if (e.code === 'Escape') void router.push('/briefing/' + route.params.level);
}

function goBriefing(): void {
  audio.unlock();
  void audio.sfx('button');
  void router.push('/briefing/' + route.params.level);
}

onMounted(() => {
  window.addEventListener('keydown', onKey);
  timer = window.setInterval(refresh, 66);
  refresh();
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  window.clearInterval(timer);
});

function markerStyle(m: PointerMark): string {
  const c = `rgb(${(m.color[0] * 255) | 0},${(m.color[1] * 255) | 0},${(m.color[2] * 255) | 0})`;
  return `left:${m.x}px;top:${m.y}px;filter:drop-shadow(0 0 3px ${c});`;
}

void store;
</script>

<template>
  <div class="hud">
    <div class="hud-score">{{ hud.score }}</div>
    <div v-if="hud.notify" class="hud-notify">{{ hud.notify }}</div>
    <img class="hud-aim" :src="base + '_aim.png'" alt="" draggable="false" :style="`left:${hud.aimX}px;top:${hud.aimY}px;`" />
    <div class="hud-life" v-html="hud.lifeHtml"></div>
    <div v-for="(m, i) in hud.pointers" :key="i" class="hud-marker" :style="markerStyle(m)">
      <img v-if="m.over" :src="base + '_over.png'" width="48" height="48" alt="" draggable="false" />
      <img v-else-if="m.iconUrl" :src="m.iconUrl" :width="Math.min(48, m.size)" :height="Math.min(48, m.size)" alt="" draggable="false" />
      <span v-if="m.label">{{ m.label }}</span>
    </div>
    <div ref="layerRef" class="touch-layer" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp">
      <template v-if="hud.stickOn">
        <img class="stick-back" :src="base + '_backAnalog.png'" alt="" draggable="false" :style="`left:${hud.backX}px;top:${hud.backY}px;`" />
        <img class="stick-knob" :src="base + '_stickAnalog.png'" alt="" draggable="false" :style="`left:${hud.knobX}px;top:${hud.knobY}px;`" />
      </template>
      <div class="accel-bar" :style="`left:${hud.canvasW - 96 + 40}px;top:${hud.canvasH - 400 + 48}px;height:${400 - 96}px;`"></div>
      <img
        class="accel-knob"
        :src="base + '_accelAnalog.png'"
        alt=""
        draggable="false"
        :style="`left:${hud.canvasW - 96 + 48 - 48}px;top:${hud.canvasH - 400 + 48 + (400 - 96) * (1 - hud.acel) - 48}px;`"
      />
      <div class="tbtn" :style="`left:${hud.canvasW - 96 - 128}px;top:${hud.canvasH - (96 + 32) * 1}px;`">
        <img :src="base + '_accelAnalog.png'" alt="" draggable="false" />
        <img :src="base + '_fireButton.png'" alt="" draggable="false" style="position:absolute;inset:0;" />
      </div>
      <div class="tbtn" :class="{ dim: hud.homings === 0 }" :style="`left:${hud.canvasW - 96 - 128}px;top:${hud.canvasH - (96 + 32) * 2}px;`">
        <img :src="base + '_accelAnalog.png'" alt="" draggable="false" />
        <img :src="base + '_fireButtonHM.png'" alt="" draggable="false" style="position:absolute;inset:0;" />
        <div class="count">{{ hud.homings }}</div>
      </div>
      <div class="tbtn" :class="{ dim: hud.nitroPct <= 0 }" :style="`left:${hud.canvasW - 96 - 128}px;top:${hud.canvasH - (96 + 32) * 3}px;`">
        <img :src="base + '_accelAnalog.png'" alt="" draggable="false" />
        <img :src="base + '_nitro.png'" alt="" draggable="false" style="position:absolute;inset:0;" />
        <div class="count">{{ hud.nitroPct }}</div>
      </div>
    </div>
  </div>
  <button class="corner-btn lu" @click="goBriefing">back</button>
  <div class="corner-btn ru" aria-hidden="true"></div>
  <div class="corner-btn rd" aria-hidden="true"></div>
  <div class="corner-btn ld" aria-hidden="true"></div>
</template>
