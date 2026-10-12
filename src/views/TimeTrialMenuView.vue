<!-- TimeTrial.Menu: PEGASUS(easy) / LEO(normal) / DRACO(hard). -->
<script setup lang="ts">
import { useRouter } from 'vue-router';
import MenuShell from '../components/MenuShell.vue';
import { audio } from '../game/audio';

const router = useRouter();
const base = import.meta.env.BASE_URL + 'assets/textures/';

function go(diff: string): void {
  audio.unlock();
  void audio.play('button');
  void router.push('/tt/' + diff);
}
</script>

<template>
  <MenuShell>
    <template #left>
      <div class="fit-list">
        <button class="icon-btn" @click="go('easy')">
          <img :src="base + '_easy.png'" alt="Pegasus easy" />
          <span>PEGASUS</span>
        </button>
        <button class="icon-btn" @click="go('normal')">
          <img :src="base + '_normal.png'" alt="Leo normal" />
          <span>LEO</span>
        </button>
        <button class="icon-btn" @click="go('hard')">
          <img :src="base + '_hard.png'" alt="Draco hard" />
          <span>DRACO</span>
        </button>
      </div>
    </template>
    <template #right>
      <div class="menu-watermark">TT</div>
    </template>
  </MenuShell>
</template>
