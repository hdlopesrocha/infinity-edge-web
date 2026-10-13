<!-- Options (XM_Options verbatim): left Username/Draw Distance/3D detail/
     Music volume/Special Effects; right Motion Blur/Invert X/Invert Y/
     Clear All/Rotate; RU save. Ranges 128-512, 4-0, 0-1. -->
<script setup lang="ts">
import { ref } from 'vue';
import MenuShell from '../components/MenuShell.vue';
import { clearGameData, saveOptions, store } from '../game/store';
import { audio } from '../game/audio';

const o = store.options;
const showKbd = ref(false);
const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');
const detailNames = ['Very High', 'High', 'Normal', 'Low', 'Very Low'];
const base = (import.meta.env.BASE_URL + 'assets/textures/').replace(/([^:])\/\//g, '$1/');

function typeLetter(l: string): void {
  audio.unlock();
  if (o.username.length < 12) o.username += l;
}

function backspace(): void {
  o.username = o.username.slice(0, -1);
}

function save(): void {
  if (o.username === '') o.username = 'Infinity Edge Fan';
  saveOptions(o);
  if (o.username === 'suckmyrocket') o.cheats = !o.cheats;
  audio.setMusicVolume(o.musicVolume);
  const rc = (window as unknown as { __ieRC?: { options: typeof o } }).__ieRC;
  if (rc) Object.assign(rc.options, o);
  store.username = o.username;
  history.back();
}

function clearAll(): void {
  clearGameData();
  void audio.sfx('button');
}

function rotate(): void {
  void audio.sfx('button');
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => undefined);
}
</script>

<template>
  <MenuShell primary="save" :on-primary="save">
    <template #left>
      <div class="opt-row">
        <label>Username: </label>
        <input v-model="o.username" class="opt-input" maxlength="12" @click="showKbd = !showKbd" />
      </div>
      <div v-if="showKbd" class="kbd">
        <button v-for="l in letters" :key="l" @click="typeLetter(l)">{{ l }}</button>
        <button @click="backspace">⌫</button>
      </div>
      <div class="opt-row">
        <label>Draw Distance: </label>
        <input v-model.number="o.distance" type="range" class="drag" min="128" max="512" step="8" />
        <span class="f-keyboard">{{ ' ' + o.distance }}</span>
      </div>
      <div class="opt-row">
        <label>3D detail: </label>
        <input v-model.number="o.detail" type="range" class="drag" min="0" max="4" step="1" />
        <span class="f-keyboard">{{ ' ' + detailNames[o.detail] }}</span>
      </div>
      <div class="opt-row">
        <label>Music volume: </label>
        <input v-model.number="o.musicVolume" type="range" class="drag" min="0" max="1" step="0.05" @input="audio.setMusicVolume(o.musicVolume)" />
      </div>
      <div class="opt-row">
        <label>Special Effects: </label>
        <input v-model="o.billboards" type="checkbox" class="opt-check" />
      </div>
    </template>
    <template #right>
      <div class="opt-row">
        <label>Motion Blur: </label>
        <input v-model="o.motionBlur" type="checkbox" class="opt-check" />
      </div>
      <div class="opt-row">
        <label>Invert X axis: </label>
        <input v-model="o.axisX" type="checkbox" class="opt-check" />
      </div>
      <div class="opt-row">
        <label>Invert Y axis: </label>
        <input v-model="o.axisY" type="checkbox" class="opt-check" />
      </div>
      <div style="display: flex; gap: 12px;">
        <button class="track-btn menubtn-wide" :style="`background-image:url(${base}_menubtn.png);`" @click="clearAll">
          Clear All
        </button>
        <button class="track-btn menubtn-wide" :style="`background-image:url(${base}_menubtn.png);`" @click="rotate">
          Rotate
        </button>
      </div>
    </template>
  </MenuShell>
</template>
