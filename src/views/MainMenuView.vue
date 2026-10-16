<!-- MainMenu.xml: SINGLE PLAYER / OPTIONS / ABOUT, plus the web-only HANGAR. -->
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
  <MenuShell wide>
    <template #left>
      <div class="fit-list">
        <button class="icon-btn" @click="go('/single-player')">
          <img :src="base + '_singlePlayer.png'" alt="" />
          <span class="cap">SINGLE PLAYER</span>
        </button>
        <button class="icon-btn" @click="go('/hangar')">
          <img :src="base + 'Fighter3_icon.png'" alt="" />
          <span class="cap">HANGAR</span>
        </button>
        <button class="icon-btn" @click="go('/options')">
          <img :src="base + '_optionsIcon.png'" alt="" />
          <span class="cap">OPTIONS</span>
        </button>
        <button class="icon-btn" @click="go('/about')">
          <img :src="base + '_about.png'" alt="" />
          <span class="cap">ABOUT</span>
        </button>
      </div>
    </template>
  </MenuShell>
</template>
