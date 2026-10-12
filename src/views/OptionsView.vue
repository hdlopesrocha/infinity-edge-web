<!-- MenuOptions: username + keyboard, distance/detail/music drags,
     billboard/motion/invX/invY checks, clear-all, save (verbatim rules). -->
<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import MenuShell from '../components/MenuShell.vue';
import { clearGameData, saveOptions, store } from '../game/store';
import { audio } from '../game/audio';

const router = useRouter();
const o = store.options;
const saved = ref(false);
const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');
const detailNames = ['VeryHigh', 'High', 'Medium', 'Low', 'VeryLow'];

function typeLetter(l: string): void {
  audio.unlock();
  if (o.username.length < 12) o.username += l;
}

function backspace(): void {
  o.username = o.username.slice(0, -1);
}

function save(): void {
  // CommandSaveOptions verbatim
  if (o.username === '') o.username = 'Infinity Edge Fan';
  if (o.username === 'suckmyrocket') o.cheats = !o.cheats;
  saveOptions(o);
  audio.setMusicVolume(o.musicVolume);
  const rc = (window as unknown as { __ieRC?: { options: typeof o } }).__ieRC;
  if (rc) {
    rc.options.username = o.username;
    rc.options.distance = o.distance;
    rc.options.detail = o.detail;
    rc.options.musicVolume = o.musicVolume;
    rc.options.billboards = o.billboards;
    rc.options.motionBlur = o.motionBlur;
    rc.options.axisX = o.axisX;
    rc.options.axisY = o.axisY;
  }
  store.username = o.username;
  saved.value = true;
  window.setTimeout(() => {
    saved.value = false;
  }, 1500);
}

function clearAll(): void {
  clearGameData();
  void audio.sfx('button');
  store.options = { ...store.options };
  void router;
}
</script>

<template>
  <MenuShell primary="save" :on-primary="save">
    <template #left>
      <div class="menu-title">Options</div>
      <div class="opt-row"><label>Player name</label><input v-model="o.username" type="text" maxlength="12" /></div>
      <div class="kbd">
        <button v-for="l in letters" :key="l" @click="typeLetter(l)">{{ l }}</button>
        <button @click="backspace">⌫</button>
      </div>
      <div class="opt-row"><label>View distance {{ o.distance }}</label><input v-model.number="o.distance" type="range" min="128" max="512" step="8" /></div>
      <div class="opt-row"><label>Detail {{ detailNames[o.detail] }}</label><input v-model.number="o.detail" type="range" min="0" max="4" step="1" /></div>
      <div class="opt-row"><label>Music {{ Math.round(o.musicVolume * 100) }}%</label><input v-model.number="o.musicVolume" type="range" min="0" max="1" step="0.05" @input="audio.setMusicVolume(o.musicVolume)" /></div>
      <div class="opt-row"><label>Billboards</label><input v-model="o.billboards" type="checkbox" class="opt-check" /></div>
    </template>
    <template #right>
      <div class="opt-row"><label>Motion blur</label><input v-model="o.motionBlur" type="checkbox" class="opt-check" /></div>
      <div class="opt-row"><label>Invert X</label><input v-model="o.axisX" type="checkbox" class="opt-check" /></div>
      <div class="opt-row"><label>Invert Y</label><input v-model="o.axisY" type="checkbox" class="opt-check" /></div>
      <button class="track-btn" @click="clearAll">CLEAR ALL DATA</button>
      <div v-if="saved" class="menu-text small">Options saved.</div>
    </template>
  </MenuShell>
</template>
