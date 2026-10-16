<!-- Options (XM_Options verbatim): left VerticalList with right-aligned
     Username / Draw Distance / 3D detail / Music volume / Special Effects;
     right VerticalList with Motion Blur / Invert X / Invert Y rows and the
     "Clear All" button (90% of the list width, 48 px). Ranges 128-512, 4-0,
     0-1; the RU corner saves. The controls use the browser's native widgets
     (the custom `_pixel`/`_ball` skins are gone); buttons keep their art. -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import MenuShell from '../components/MenuShell.vue';
import { clearGameData, saveOptions, store } from '../game/store';
import { audio } from '../game/audio';
import { goBack } from '../game/nav';
import { enableVr, setVr, vrState } from '../game/vr';
import type { Options } from '../game/resources';

const router = useRouter();
const o = store.options;
const vrOn = () => store.vr;
const vrStatusText = () => {
  if (vrState.status === 'denied') return 'permission denied';
  if (vrState.status === 'unsupported') return 'not supported on this device';
  if (store.vr) return 'gyroscope active - move the device to look';
  return 'gyroscope';
};
async function toggleVr(): Promise<void> {
  audio.unlock();
  void audio.sfx('button');
  if (store.vr) setVr(false);
  else await enableVr();
}
const detailNames = ['Very High', 'High', 'Normal', 'Low', 'Very Low'];
const base = (import.meta.env.BASE_URL + 'assets/textures/').replace(/([^:])\/\//g, '$1/');

// Snapshot of the saved state: every control below applies live (the renderer,
// camera far plane, music and LOD read rc.options every frame), and leaving the
// screen without pressing "save" restores this snapshot.
const saved: Options = { ...store.options };
let persisted = false;

function rcOptions(): Options | null {
  const rc = (window as unknown as { __ieRC?: { options: Options } }).__ieRC;
  return rc ? rc.options : null;
}

/** Push the live edits into the running game (no persistence). */
function applyLive(): void {
  const target = rcOptions();
  if (target) Object.assign(target, o);
  store.username = o.username;
}

watch(
  () => ({ ...o }),
  () => {
    applyLive();
    audio.setMusicVolume(o.musicVolume);
  },
  { deep: true },
);

onMounted(() => {
  applyLive();
});

onBeforeUnmount(() => {
  if (persisted) return;
  // Not saved: roll the whole screen back to the values the game started with.
  Object.assign(store.options, saved);
  applyLive();
  audio.setMusicVolume(saved.musicVolume);
});

function save(): void {
  if (o.username === '') o.username = 'Infinity Edge Fan';
  saveOptions(o);
  persisted = true;
  if (o.username === 'suckmyrocket') o.cheats = !o.cheats;
  audio.setMusicVolume(o.musicVolume);
  applyLive();
  store.username = o.username;
  goBack(router, '/menu');
}

function clearAll(): void {
  clearGameData();
  void audio.sfx('button');
}

function volumePct(): string {
  return Math.round(o.musicVolume * 100) + '%';
}
</script>

<template>
  <MenuShell primary="save" :on-primary="save">
    <template #left>
      <div class="opt-list opt-list-left">
        <div class="opt-row">
          <label>Username: </label>
          <input v-model="o.username" class="opt-input" maxlength="12" />
        </div>
        <div class="opt-row">
          <label>Draw Distance: </label>
          <input v-model.number="o.distance" type="range" class="drag" min="128" max="512" step="1" />
          <span class="opt-value">{{ ' ' + o.distance }}</span>
        </div>
        <div class="opt-row">
          <label>3D detail: </label>
          <input v-model.number="o.detail" type="range" class="drag" min="0" max="4" step="1" />
          <span class="opt-value">{{ ' ' + detailNames[o.detail] }}</span>
        </div>
        <div class="opt-row">
          <label>Music volume: </label>
          <input
            v-model.number="o.musicVolume" type="range" class="drag" min="0" max="1" step="0.05"
            @input="audio.setMusicVolume(o.musicVolume)"
          />
          <span class="opt-value">{{ ' ' + volumePct() }}</span>
        </div>
        <div class="opt-row">
          <label class="opt-check-label">
            <span>Special Effects: </span>
            <input v-model="o.billboards" type="checkbox" class="opt-check" />
          </label>
        </div>
      </div>
    </template>
    <template #right>
      <div class="opt-list opt-list-right">
        <div class="opt-row">
          <span class="opt-check-label">
            <span>VR mode: </span>
            <button class="pause-btn" style="padding: 4px 10px;" @click="toggleVr">{{ vrOn() ? 'ON' : 'OFF' }}</button>
          </span>
        </div>
        <div class="opt-row">
          <span class="c-white50" style="font-size: 12px;">{{ vrStatusText() }}</span>
        </div>
        <div class="opt-row">
          <label class="opt-check-label">
            <span>Invert X axis: </span>
            <input v-model="o.axisX" type="checkbox" class="opt-check" />
          </label>
        </div>
        <div class="opt-row">
          <label class="opt-check-label">
            <span>Invert Y axis: </span>
            <input v-model="o.axisY" type="checkbox" class="opt-check" />
          </label>
        </div>
        <button
          class="track-btn menubtn-wide opt-clear"
          :style="`background-image:url(${base}_menubtn.png);`"
          @click="clearAll"
        >
          Clear All
        </button>
      </div>
    </template>
  </MenuShell>
</template>
