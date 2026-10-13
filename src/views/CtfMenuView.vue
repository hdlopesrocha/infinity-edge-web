<!-- CTF/Menu.xml: PEGASUS / LEO / DRACO. -->
<script setup lang="ts">
import { useRouter } from 'vue-router';
import MenuShell from '../components/MenuShell.vue';
import { CTF_LEVELS } from '../game/levels';
import { audio } from '../game/audio';

const router = useRouter();
const base = (import.meta.env.BASE_URL + 'assets/textures/').replace(/([^:])\/\//g, '$1/');
const caps: Record<string, string> = { 'ctf-easy': 'PEGASUS', 'ctf-normal': 'LEO', 'ctf-hard': 'DRACO' };
const icons: Record<string, string> = { 'ctf-easy': '_easy.png', 'ctf-normal': '_normal.png', 'ctf-hard': '_hard.png' };

function openLevel(key: string): void {
  audio.unlock();
  void audio.sfx('button');
  void router.push('/briefing/' + key);
}
</script>

<template>
  <MenuShell wide>
    <template #left>
      <div class="fit-list">
        <button v-for="key in CTF_LEVELS" :key="key" class="icon-btn" @click="openLevel(key)">
          <img :src="base + icons[key]" alt="" />
          <span class="cap">{{ caps[key] }}</span>
        </button>
      </div>
    </template>
  </MenuShell>
</template>
