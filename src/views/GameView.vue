<!-- Game HUD + corner buttons (Description tag chrome). The HUD renders from
     `store.hud`, a snapshot the render loop publishes after every movement and
     draw of the frame (see GameCanvas.syncHud), so markers/aim/life never trail
     the 3D scene by a frame or by an interval tick. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { GameInstance } from '../game/instance';
import { store } from '../game/store';
import { audio } from '../game/audio';
import { goBack } from '../game/nav';

const route = useRoute();
const router = useRouter();
const base = (import.meta.env.BASE_URL + 'assets/textures/').replace(/([^:])\/\//g, '$1/');

function game(): GameInstance | null {
  return (window as unknown as { __ieGame?: GameInstance }).__ieGame ?? null;
}

const hud = store.hud;

const layerRef = ref<HTMLDivElement | null>(null);

function lifeColor(v: number, max: number): string {
  const p = max === 0 ? 0 : Math.max(0, v / max);
  const r = (((1 * (1 - p) + 0.2 * p) / 2) * 0.7 * 255) | 0;
  const gg = (((0.27 * (1 - p) + 0.8 * p) / 2) * 0.7 * 255) | 0;
  const b = (((0 * (1 - p) + 0.2 * p) / 2) * 0.7 * 255) | 0;
  return `rgb(${r},${gg},${b})`;
}

const lifeHtml = computed(() => {
  const seg = hud.life;
  if (seg.length === 0) return '';
  if (seg.length === 1) {
    return `<div style="width:50px;height:16px;background:rgba(0,0,0,0.5);padding:4px;">` +
      `<div style="width:42px;height:8px;background:${lifeColor(seg[0].value, seg[0].max)};"></div></div>`;
  }
  return `<div style="width:150px;height:16px;background:rgba(0,0,0,0.5);display:flex;gap:4px;padding:4px;">` +
    seg.map((s) => `<div style="width:44px;height:8px;background:${lifeColor(s.value, s.max)};"></div>`).join('') +
    `</div>`;
});

// Countdown badge: leaving the field of battle (the ship is destroyed when it
// runs out) or the respawn wait after the ship was destroyed.
const timer = computed(() => hud.outside ?? hud.respawn);
const timerLabel = computed(() => (hud.outside ? 'Leaving the field of battle' : 'Waiting to respawn'));
const timerSecs = computed(() => (timer.value ? Math.max(0, Math.ceil(timer.value.left / 1000)) : 0));
const timerPct = computed(() => {
  const t = timer.value;
  return t && t.total > 0 ? Math.max(0, Math.min(100, (t.left / t.total) * 100)) : 0;
});

// Match clock (CTF levels are 5 minutes): m:ss, amber in the last 30 s.
const matchClock = computed(() => {
  const ms = hud.matchLeft;
  if (ms === null) return '';
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  return `${m}:${String(total % 60).padStart(2, '0')}`;
});
const matchLow = computed(() => hud.matchLeft !== null && hud.matchLeft <= 30000);

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
  if (e.code === 'Escape') goBack(router, '/briefing/' + String(route.params.level));
}

function goBriefing(): void {
  audio.unlock();
  void audio.sfx('button');
  // LIFO: return to whatever menu we came from (the briefing), never forward.
  goBack(router, '/briefing/' + String(route.params.level));
}

onMounted(() => {
  window.addEventListener('keydown', onKey);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
});

function markerStyle(m: { color: [number, number, number]; x: number; y: number }): string {
  const c = `rgb(${(m.color[0] * 255) | 0},${(m.color[1] * 255) | 0},${(m.color[2] * 255) | 0})`;
  return `left:${m.x}px;top:${m.y}px;transform:translate(-50%,-50%);filter:drop-shadow(0 0 3px ${c});`;
}
</script>

<template>
  <div class="hud">
    <div class="hud-score">{{ hud.score }}</div>
    <div v-if="hud.matchLeft !== null" class="hud-match" :class="{ low: matchLow }">{{ matchClock }}</div>
    <div v-if="hud.notify" class="hud-notify">{{ hud.notify }}</div>
    <div v-if="timer" class="hud-timer" :class="{ warn: !!hud.outside }">
      <div class="hud-timer-label">{{ timerLabel }}</div>
      <div class="hud-timer-value">{{ timerSecs }}<span>s</span></div>
      <div class="hud-timer-bar"><i :style="`width:${timerPct}%`"></i></div>
    </div>
    <img class="hud-aim" :src="base + '_aim.png'" alt="" draggable="false" :style="`left:${hud.aimX}px;top:${hud.aimY}px;`" />
    <div class="hud-life" v-html="lifeHtml"></div>
    <div v-for="(m, i) in hud.pointers" :key="i" class="hud-marker" :style="markerStyle(m)">
      <img v-if="m.over" :src="base + '_over.png'" width="48" height="48" alt="" draggable="false" />
      <img v-else-if="m.iconUrl" :src="m.iconUrl" :width="m.w" :height="m.h" alt="" draggable="false" />
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
