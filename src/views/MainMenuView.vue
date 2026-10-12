<!-- MainMenu: singlePlayer / options / about icons (multiplayer disabled). -->
<script setup lang="ts">
import { useRouter } from 'vue-router';
import MenuShell from '../components/MenuShell.vue';
import { audio } from '../game/audio';

const router = useRouter();
const base = (import.meta.env.BASE_URL + 'assets/textures/').replace(/([^:])\/\//g, '$1/');

function go(path: string): void {
  audio.unlock();
  void audio.sfx('button');
  void router.push(path);
}
</script>

<template>
  <MenuShell no-back>
    <template #left>
      <div class="menu-title">Infinity Edge</div>
      <div class="fit-list">
        <button class="icon-btn" @click="go('/single-player')">
          <img :src="base + '_singlePlayer.png'" alt="Single player" />
          <span>SINGLE PLAYER</span>
        </button>
        <button class="icon-btn" @click="go('/options')">
          <img :src="base + '_optionsIcon.png'" alt="Options" />
          <span>OPTIONS</span>
        </button>
        <button class="icon-btn" @click="go('/about')">
          <img :src="base + '_about.png'" alt="About" />
          <span>ABOUT</span>
        </button>
      </div>
    </template>
    <template #right>
      <div class="menu-text small">
        3D space combat — time trials and capture-the-flag across the galaxy.
        Select SINGLE PLAYER to fly.
      </div>
    </template>
  </MenuShell>
</template>
