<!-- TT/{Easy,Normal,Hard}/Menu.xml: Track 01.. buttons + White20 watermark. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import MenuShell from '../components/MenuShell.vue';
import { TT_GROUPS } from '../game/levels';
import { audio } from '../game/audio';

const route = useRoute();
const router = useRouter();
const base = (import.meta.env.BASE_URL + 'assets/textures/').replace(/([^:])\/\//g, '$1/');
const diff = computed(() => String(route.params.diff ?? 'easy'));
const group = computed(() => TT_GROUPS.find((g) => g.id === diff.value) ?? TT_GROUPS[0]);
const water = computed(() => ({ easy: '_easy.png', normal: '_normal.png', hard: '_hard.png' })[group.value.id]);
const labels: Record<string, string[]> = {
  easy: ['Track 01', 'Track 02', 'Track 03', 'Track 04', 'Track 05'],
  normal: ['Track 01', 'Track 02', 'Track 03', 'Track 04'],
  hard: ['Demo Track'],
};

function openTrack(key: string): void {
  audio.unlock();
  void audio.sfx('button');
  void router.push('/briefing/' + key);
}
</script>

<template>
  <MenuShell>
    <template #left>
      <div class="vlist">
        <button
          v-for="(key, i) in group.tracks"
          :key="key"
          class="track-btn"
          :style="`background-image:url(${base}_menubtn.png);`"
          @click="openTrack(key)"
        >
          {{ labels[group.id][i] }}
        </button>
      </div>
    </template>
    <template #right>
      <div class="watermark"><img :src="base + water" alt="" /></div>
    </template>
  </MenuShell>
</template>
