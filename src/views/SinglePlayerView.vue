<!-- SinglePlayer/Menu.xml: CAPTURE THE FLAG / TIME TRIAL. -->
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
        <button class="icon-btn" @click="go('/ctf')">
          <img :src="base + '_ctf.png'" alt="" />
          <span class="cap">CAPTURE THE FLAG</span>
        </button>
        <button class="icon-btn" @click="go('/tt')">
          <img :src="base + '_timeTrial.png'" alt="" />
          <span class="cap">TIME TRIAL</span>
        </button>
      </div>
    </template>
  </MenuShell>
</template>
