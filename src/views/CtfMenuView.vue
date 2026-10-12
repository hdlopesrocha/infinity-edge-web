<!-- CTF menu: easy/normal/hard into briefings. -->
<script setup lang="ts">
import { useRouter } from 'vue-router';
import MenuShell from '../components/MenuShell.vue';
import { CTF_LEVELS } from '../game/levels';
import { audio } from '../game/audio';

const router = useRouter();
const base = (import.meta.env.BASE_URL + 'assets/textures/').replace(/([^:])\/\//g, '$1/');
const labels: Record<string, string> = { 'ctf-easy': 'EASY', 'ctf-normal': 'NORMAL', 'ctf-hard': 'HARD' };
const icons: Record<string, string> = { 'ctf-easy': '_easy.png', 'ctf-normal': '_normal.png', 'ctf-hard': '_hard.png' };

function openLevel(key: string): void {
  audio.unlock();
  void audio.sfx('button');
  void router.push('/briefing/' + key);
}
</script>

<template>
  <MenuShell>
    <template #left>
      <div class="fit-list">
        <button v-for="key in CTF_LEVELS" :key="key" class="icon-btn" @click="openLevel(key)">
          <img :src="base + icons[key]" :alt="labels[key]" />
          <span>{{ labels[key] }}</span>
        </button>
      </div>
    </template>
    <template #right>
      <div class="menu-watermark">CTF</div>
    </template>
  </MenuShell>
</template>
