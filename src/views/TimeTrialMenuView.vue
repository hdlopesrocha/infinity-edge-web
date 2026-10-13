<!-- TT/Menu.xml: PEGASUS / LEO / DRACO. -->
<script setup lang="ts">
import { useRouter } from 'vue-router';
import MenuShell from '../components/MenuShell.vue';
import { audio } from '../game/audio';

const router = useRouter();
const base = (import.meta.env.BASE_URL + 'assets/textures/').replace(/([^:])\/\//g, '$1/');

function go(diff: string): void {
  audio.unlock();
  void audio.sfx('button');
  void router.push('/tt/' + diff);
}
</script>

<template>
  <MenuShell wide>
    <template #left>
      <div class="fit-list">
        <button class="icon-btn" @click="go('easy')">
          <img :src="base + '_easy.png'" alt="" />
          <span class="cap">PEGASUS</span>
        </button>
        <button class="icon-btn" @click="go('normal')">
          <img :src="base + '_normal.png'" alt="" />
          <span class="cap">LEO</span>
        </button>
        <button class="icon-btn" @click="go('hard')">
          <img :src="base + '_hard.png'" alt="" />
          <span class="cap">DRACO</span>
        </button>
      </div>
    </template>
  </MenuShell>
</template>
