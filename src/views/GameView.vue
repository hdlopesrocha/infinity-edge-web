<!-- Game HUD + corner buttons (Description tag chrome). The HUD renders from
     `store.hud`, a snapshot the render loop publishes after every movement and
     draw of the frame (see GameCanvas.syncHud), so markers/aim/life never trail
     the 3D scene by a frame or by an interval tick. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { GameInstance } from '../game/instance';
import { clearGameData, saveOptions, store } from '../game/store';
import { audio } from '../game/audio';
import { goBack } from '../game/nav';
import { enableVr, gamepadConnected, setVr, vrState } from '../game/vr';
import GazeCursor from '../components/GazeCursor.vue';

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
  if (e.code === 'Escape') (store.paused ? resume() : goBriefing());
}

const paused = computed(() => store.paused);
const showSettings = ref(false);
const o = store.options;
const detailNames = ['Very High', 'High', 'Normal', 'Low', 'Very Low'];
const pad = ref(gamepadConnected());
const vr = computed(() => store.vr);
const padPoll = window.setInterval(() => { const now = gamepadConnected(); if (now !== pad.value) pad.value = now; }, 1000);
onBeforeUnmount(() => window.clearInterval(padPoll));
/** The pause settings mirror the Options screen: live apply, snapshot on
 *  open, and closing without SAVE rolls everything back. */
const snapshot = ref<Record<string, unknown> | null>(null);
function openSettings(): void {
  snapshot.value = { ...o };
  showSettings.value = true;
}
function closeSettings(): void {
  if (snapshot.value) Object.assign(o, snapshot.value);
  snapshot.value = null;
  showSettings.value = false;
  applyLive();
}
function saveSettings(): void {
  if (snapshot.value) Object.assign(o, snapshot.value);
  snapshot.value = null;
  saveOptions(o);
  applyLive();
  audio.unlock();
  void audio.sfx('button');
}
function clearAll(): void {
  clearGameData();
  void audio.sfx('button');
}
function volumePct(): string {
  return Math.round(o.musicVolume * 100) + '%';
}

async function toggleVr(): Promise<void> {
  audio.unlock();
  void audio.sfx('button');
  if (store.vr) {
    const { leaveXr } = await import('../game/xr');
    leaveXr();
    setVr(false);
    return;
  }
  await enableVr();
  // Leave the pause so the view is live: otherwise enabling VR looks like a
  // no-op because the frozen scene sits behind the panel.
  if (store.vr) {
    store.paused = false;
    showSettings.value = false;
    snapshot.value = null;
  }
}
const vrStatusTextRaw = (): string => {
  if (vrState.status === 'unsupported') return 'No motion sensor in this browser';
  if (!store.vr) return 'Needs a phone or tablet with a gyroscope (over https)';
  if (vrState.tracking && vrState.dragLook) return 'Active - drag the scene to look, tap to re-centre';
  if (vrState.tracking) return 'Active - move the device to look, tap the scene to re-centre';
  return 'Switched on: move the device, or drag the scene to look (sensor blocked?)';
};
const vrStatusText = (): string =>
  vrState.lastError ? 'error: ' + vrState.lastError : vrStatusTextRaw();

/** In-game pause: the back button (or Escape) pauses instead of leaving. */
function goBriefing(): void {
  audio.unlock();
  void audio.sfx('button');
  store.paused = true;
  if (showSettings.value) closeSettings();
}

function resume(): void {
  audio.unlock();
  void audio.sfx('button');
  store.paused = false;
  showSettings.value = false;
}

/** Leave for good: LIFO back to whatever menu we came from. */
function leaveMatch(): void {
  audio.unlock();
  void audio.sfx('button');
  store.paused = false;
  goBack(router, '/briefing/' + String(route.params.level));
}

/** Options apply live to the running game (rc.options is read every frame)
 *  and are persisted straight away. */
function applyLive(): void {
  const rc = (window as unknown as { __ieRC?: { options: typeof o } }).__ieRC;
  if (rc) Object.assign(rc.options, o);
  saveOptions(o);
  audio.setMusicVolume(o.musicVolume);
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
  <div class="hud" @contextmenu.prevent>
    <div v-if="!store.glUi" class="hud-dom">
    <div v-if="!store.glUi" class="hud-score">{{ hud.score }}</div>
    <div v-if="!store.glUi && hud.matchLeft !== null" class="hud-match" :class="{ low: matchLow }">{{ matchClock }}</div>
    <div v-if="!store.glUi && hud.notify" class="hud-notify">{{ hud.notify }}</div>
    <div v-if="!store.glUi && timer" class="hud-timer" :class="{ warn: !!hud.outside }">
      <div class="hud-timer-label">{{ timerLabel }}</div>
      <div class="hud-timer-value">{{ timerSecs }}<span>s</span></div>
      <div class="hud-timer-bar"><i :style="`width:${timerPct}%`"></i></div>
    </div>
    <img v-if="!store.glUi" class="hud-aim" :src="base + '_aim.png'" alt="" draggable="false" :style="`left:${hud.aimX}px;top:${hud.aimY}px;`" />
    <div v-if="!store.glUi" class="hud-life" v-html="lifeHtml"></div>
    <div v-if="!store.glUi" v-for="(m, i) in hud.pointers" :key="i" class="hud-marker" :style="markerStyle(m)">
      <img v-if="m.over" :src="base + '_over.png'" width="48" height="48" alt="" draggable="false" />
      <img v-else-if="m.iconUrl" :src="m.iconUrl" :width="m.w" :height="m.h" alt="" draggable="false" />
      <span v-if="m.label">{{ m.label }}</span>
    </div>
    </div>
    <div ref="layerRef" class="touch-layer" :class="{ 'gl-hidden': store.glUi }" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp">
      <template v-if="hud.stickOn">
        <img class="stick-back" draggable="false" :src="base + '_backAnalog.png'" alt="" :style="`left:${hud.backX}px;top:${hud.backY}px;`" />
        <img class="stick-knob" draggable="false" :src="base + '_stickAnalog.png'" alt="" :style="`left:${hud.knobX}px;top:${hud.knobY}px;`" />
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
  <GazeCursor />
  <div v-if="paused" class="pause-backdrop">
    <div class="pause-panel">
      <div class="pause-title">PAUSED</div>
      <button class="pause-btn primary" @click="resume">RESUME</button>
      <button class="pause-btn" @click="showSettings ? closeSettings() : openSettings()">
        {{ showSettings ? 'CLOSE SETTINGS' : 'SETTINGS' }}
      </button>
      <div v-if="showSettings" class="pause-settings">
        <div class="pause-cols">
          <div class="opt-list">
            <div class="opt-row">
              <label>Username: </label>
              <input v-model="o.username" class="opt-input" maxlength="12" />
            </div>
            <div class="opt-row">
              <label>Draw Distance: </label>
              <input v-model.number="o.distance" type="range" class="drag" min="128" max="512" step="1" @input="applyLive" />
              <span class="opt-value">{{ ' ' + o.distance }}</span>
            </div>
            <div class="opt-row">
              <label>3D detail: </label>
              <input v-model.number="o.detail" type="range" class="drag" min="0" max="4" step="1" @input="applyLive" />
              <span class="opt-value">{{ ' ' + detailNames[o.detail] }}</span>
            </div>
            <div class="opt-row">
              <label>Music volume: </label>
              <input v-model.number="o.musicVolume" type="range" class="drag" min="0" max="1" step="0.05" @input="applyLive" />
              <span class="opt-value">{{ ' ' + volumePct() }}</span>
            </div>
            <div class="opt-row">
              <label class="opt-check-label">
                <span>Special Effects: </span>
                <input v-model="o.billboards" type="checkbox" class="opt-check" @change="applyLive" />
              </label>
            </div>
          </div>
          <div class="opt-list">
            <div class="opt-row">
              <label class="opt-check-label">
                <span>Invert X axis: </span>
                <input v-model="o.axisX" type="checkbox" class="opt-check" @change="applyLive" />
              </label>
            </div>
            <div class="opt-row">
              <label class="opt-check-label">
                <span>Invert Y axis: </span>
                <input v-model="o.axisY" type="checkbox" class="opt-check" @change="applyLive" />
              </label>
            </div>
            <div class="opt-row">
              <span>VR mode <span class="c-white50">(gyroscope)</span></span>
              <button class="pause-btn" style="padding: 4px 10px;"
                      title="Move the device to look; tap the scene to re-centre"
                      @click="toggleVr">{{ vr ? 'ON' : 'OFF' }}</button>
            </div>
            <div v-if="vr" class="opt-row">
              <span class="c-white50">{{ vrStatusText() }}
            <div v-if="store.vr" class="opt-row">
              <span class="c-white50" style="font-size: 12px;">
                sensor: {{ vrState.events }} events &middot; yaw {{ vrState.yaw }}&deg; &middot; pitch {{ vrState.pitch }}&deg; &middot; {{ vrState.dragLook ? 'drag look on' : 'drag look off' }}
              </span>
            </div></span>
            </div>
            <button class="track-btn menubtn-wide opt-clear" :style="`background-image:url(${base}_menubtn.png);`" @click="clearAll">
              Clear All
            </button>
          </div>
        </div>
        <div class="pause-cols">
          <button class="pause-btn primary" @click="saveSettings">SAVE</button>
          <button class="pause-btn" @click="closeSettings">CANCEL (REVERT)</button>
        </div>
      </div>
      <button class="pause-btn leave" @click="leaveMatch">LEAVE MATCH</button>
    </div>
  </div>
  <button class="corner-btn lu" @click="goBriefing">back</button>
  <div class="corner-btn ru" aria-hidden="true"></div>
  <div class="corner-btn rd" aria-hidden="true"></div>
  <div class="corner-btn ld" aria-hidden="true"></div>
</template>
