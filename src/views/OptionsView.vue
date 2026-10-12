<!-- MenuOptions: username + ScreenKeyboard, InputDrag(distance/detail/music),
     InputCheck(billboards/motionBlur/invX/invY), Clear All, save. -->
<script setup lang="ts">
import { ref } from 'vue';
import MenuShell from '../components/MenuShell.vue';
import { clearGameData, saveOptions, store } from '../game/store';
import { audio } from '../game/audio';

const o = store.options;
const saved = ref(false);
const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

function typeLetter(l: string): void {
  audio.unlock();
  if (o.username.length < 12) o.username += l;
}

function backspace(): void {
  o.username = o.username.slice(0, -1);
}

function save(): void {
  saveOptions();
  audio.setMusicVolume(o.musicVolume);
  saved.value = true;
  window.setTimeout(() => {
    saved.value = false;
  }, 1500);
}

function clearAll(): void {
  clearGameData();
  void audio.play('button');
}

const detailName = ['VeryHigh', 'High', 'Medium', 'Low', 'VeryLow'];
</script>

<template>
  <MenuShell primary="save" :on-primary="save">
    <template #left>
      <div class="menu-title">Options</div>
      <div class="opt-row"><label>Player name</label><input v-model="o.username" type="text" maxlength="12" placeholder="Pilot" /></div>
      <div class="kbd">
        <button v-for="l in letters" :key="l" @click="typeLetter(l)">{{ l }}</button>
        <button @click="backspace">⌫</button>
      </div>
      <div class="opt-row"><label>View distance {{ o.distance }}</label><input v-model.number="o.distance" type="range" min="128" max="512" step="16" /></div>
      <div class="opt-row"><label>Detail {{ detailName[o.detail] }}</label><input v-model.number="o.detail" type="range" min="0" max="4" step="1" /></div>
      <div class="opt-row"><label>Music {{ Math.round(o.musicVolume * 100) }}%</label><input v-model.number="o.musicVolume" type="range" min="0" max="1" step="0.05" @input="audio.setMusicVolume(o.musicVolume)" /></div>
      <div class="opt-row"><label>Billboards</label><input v-model="o.billboards" type="checkbox" class="opt-check" /></div>
    </template>
    <template #right>
      <div class="opt-row"><label>Motion blur</label><input v-model="o.motionBlur" type="checkbox" class="opt-check" /></div>
      <div class="opt-row"><label>Invert X</label><input v-model="o.invX" type="checkbox" class="opt-check" /></div>
      <div class="opt-row"><label>Invert Y</label><input v-model="o.invY" type="checkbox" class="opt-check" /></div>
      <button class="track-btn" @click="clearAll">CLEAR ALL SCORES</button>
      <div v-if="saved" class="menu-text small">Options saved.</div>
    </template>
  </MenuShell>
</template>
