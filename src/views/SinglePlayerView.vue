<!-- SinglePlayer menu: CTF vs TimeTrial (multiplayer stays disabled, as in
     the original where the button is commented out). -->
<script setup lang="ts">
import { useRouter } from 'vue-router';
import MenuShell from '../components/MenuShell.vue';
import { audio } from '../game/audio';

const router = useRouter();
const base = import.meta.env.BASE_URL + 'assets/textures/';

function go(path: string): void {
  audio.unlock();
  void audio.play('button');
  void router.push(path);
}
</script>

<template>
  <MenuShell>
    <template #left>
      <div class="fit-list">
        <button class="icon-btn" @click="go('/ctf')">
          <img :src="base + '_ctf.png'" alt="Capture the flag" />
          <span>CAPTURE THE FLAG</span>
        </button>
        <button class="icon-btn" @click="go('/tt')">
          <img :src="base + '_timeTrial.png'" alt="Time trial" />
          <span>TIME TRIAL</span>
        </button>
      </div>
    </template>
    <template #right>
      <div class="menu-text small">
        CTF: bring the enemy flag home — 5 minutes, most points win.
        Time trial: race the ghost through the Ark gates.
      </div>
    </template>
  </MenuShell>
</template>
