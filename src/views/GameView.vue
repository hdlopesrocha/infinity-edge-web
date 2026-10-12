<!-- GameInstance HUD: scoreboard, aim reticle, timer, addons, touch controls.
     Drives the renderer via keyboard (WASD/arrows + Space nitro + F fire)
     and touch buttons. Victory/Defeat push result routes like the original. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { LEVELS } from '../game/levels';
import { audio } from '../game/audio';
import { recordScore, store } from '../game/store';
import { GhostRecorder } from '../game/ghost';

const route = useRoute();
const router = useRouter();
const levelKey = String(route.params.level ?? '');
const level = computed(() => LEVELS[levelKey]);
let finished = false;
const base = import.meta.env.BASE_URL + 'assets/textures/';

const elapsed = ref(0);
const timerId = ref(0);
const nitro = ref(100);
const message = ref('');
const timerText = computed(() => {
  const s = Math.floor(elapsed.value);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
});

function renderer(): RendererLike | null {
  return (window as unknown as { __ieRenderer?: RendererLike }).__ieRenderer ?? null;
}

interface RendererLike {
  input: { fwd: number; strafe: number; up: number; yaw: number; pitch: number; fire: boolean; nitro: boolean };
  camera: { h: number; v: number; orbit(dh: number, dv: number): void };
  player(): { pos: { [i: number]: number } } | undefined;
}

const ghost = new GhostRecorder();

const keys = new Set<string>();

function onKeyDown(e: KeyboardEvent): void {
  if (e.repeat) return;
  keys.add(e.code);
  audio.unlock();
  if (e.code === 'Escape') void router.push('/briefing/' + levelKey);
  pushInput();
}

function onKeyUp(e: KeyboardEvent): void {
  keys.delete(e.code);
  pushInput();
}

function pushInput(): void {
  const r = renderer();
  if (!r) return;
  const k = keys;
  r.input.fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) + (k.has('KeyS') || k.has('ArrowDown') ? -1 : 0);
  r.input.strafe = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) + (k.has('KeyA') || k.has('ArrowLeft') ? -1 : 0);
  r.input.up = (k.has('KeyR') || k.has('Space') ? 1 : 0) + (k.has('KeyF') ? -1 : 0);
  let yaw = 0;
  if (k.has('KeyQ')) yaw -= 1;
  if (k.has('KeyE')) yaw += 1;
  const inv = store.options.invX ? -1 : 1;
  r.camera.h = (r.camera.h + yaw * 3 * inv + 360) % 360;
  r.input.nitro = k.has('ShiftLeft') || k.has('ShiftRight');
  r.input.fire = k.has('KeyX') || k.has('ControlLeft');
  if (r.input.fire) void audio.play('bulletSound', 0.5);
  if (r.input.nitro && nitro.value > 0) nitro.value = Math.max(0, nitro.value - 1);
}

let drag: { x: number; y: number } | null = null;

function onPointerDown(e: PointerEvent): void {
  drag = { x: e.clientX, y: e.clientY };
}

function onPointerMove(e: PointerEvent): void {
  if (!drag) return;
  const r = renderer();
  if (!r) return;
  const dx = (e.clientX - drag.x) * (store.options.invX ? -1 : 1);
  const dy = (e.clientY - drag.y) * (store.options.invY ? -1 : 1);
  drag = { x: e.clientX, y: e.clientY };
  r.camera.orbit(dx * 0.25, dy * 0.25);
}

function onPointerUp(): void {
  drag = null;
}

function touchBtn(prop: 'fwd' | 'nitro' | 'fire', v: number | boolean): void {
  const r = renderer();
  audio.unlock();
  if (!r) return;
  if (prop === 'fwd') r.input.fwd = v as number;
  if (prop === 'nitro') r.input.nitro = v as boolean;
  if (prop === 'fire') {
    r.input.fire = v as boolean;
    if (v) void audio.play('bulletSound', 0.5);
  }
}

function finish(won: boolean): void {
  if (finished) return;
  finished = true;
  window.clearInterval(timerId.value);
  const user = store.options.username || 'Pilot';
  recordScore(level.value.save, user, timerText.value);
  ghost.save(levelKey);
  void audio.speak(won ? 'ObjectiveCompleted' : 'YouLost');
  void router.push((won ? '/victory/' : '/defeat/') + levelKey);
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  message.value = level.value?.text ?? '';
  window.setTimeout(() => {
    message.value = '';
  }, 6000);
  ghost.begin();
  timerId.value = window.setInterval(() => {
    elapsed.value += 1;
    // Sample the player ship for the ghost file (GhostRecord port).
    const p = renderer()?.player();
    if (p) ghost.sample([p.pos[0], p.pos[1], p.pos[2]]);
    // Demo goal evaluation: TT gold time -> victory; CTF 5:00 -> victory.
    if (level.value?.type === 'TT') {
      const gold = level.value.goals.find((g) => g.reward === 'Gold');
      const need = gold?.goals.find((g) => g.name === 'LessTime')?.value ?? '00:01:00';
      const parts = need.split(':').map(Number);
      const limit = parts[0] * 3600 + parts[1] * 60 + parts[2];
      if (elapsed.value >= limit * 3) finish(true);
    } else if (elapsed.value >= 300) {
      finish(true);
    }
  }, 1000);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  window.clearInterval(timerId.value);
  // Persist ghost on exit too (quits still record, like .ghs autosave).
  if (ghost.count > 0) ghost.save(levelKey);
  const r = renderer();
  if (r) r.input = { fwd: 0, strafe: 0, up: 0, yaw: 0, pitch: 0, fire: false, nitro: false };
});
</script>

<template>
  <div
    class="hud"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    style="pointer-events: auto"
  >
    <div class="hud-top">
      <span>{{ level?.type }} {{ level?.title }} — {{ store.options.username || 'Pilot' }}</span>
      <span>{{ timerText }}</span>
    </div>
    <div class="hud-scores">
      <div>Nitro {{ nitro }}%</div>
      <div>Ship HS1 · Shield 100</div>
    </div>
    <img class="hud-aim" :src="base + '_aim.png'" alt="" draggable="false" />
    <div v-if="message" class="hud-msg">{{ message }}</div>
    <div class="touch-controls">
      <div style="display: flex; gap: 8px">
        <button class="track-btn" @pointerdown="touchBtn('fwd', 1)" @pointerup="touchBtn('fwd', 0)">▲</button>
        <button class="track-btn" @pointerdown="touchBtn('fwd', -1)" @pointerup="touchBtn('fwd', 0)">▼</button>
      </div>
      <div style="display: flex; gap: 8px">
        <button class="track-btn" @pointerdown="touchBtn('nitro', true)" @pointerup="touchBtn('nitro', false)">NITRO</button>
        <button class="track-btn" @pointerdown="touchBtn('fire', true)" @pointerup="touchBtn('fire', false)">FIRE</button>
      </div>
    </div>
  </div>
</template>
