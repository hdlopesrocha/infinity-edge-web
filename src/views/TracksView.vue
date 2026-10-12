<!-- Track list (TT Easy/Normal/Hard): VerticalFitList of _menubtn buttons on
     the left, difficulty watermark on the right. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import MenuShell from '../components/MenuShell.vue';
import { TT_GROUPS, trackLabel } from '../game/levels';
import { audio } from '../game/audio';

const route = useRoute();
const router = useRouter();
const diff = computed(() => String(route.params.diff ?? 'easy'));
const group = computed(() => TT_GROUPS.find((g) => g.id === diff.value) ?? TT_GROUPS[0]);
const base = import.meta.env.BASE_URL + 'assets/textures/';

function openTrack(key: string): void {
  audio.unlock();
  void audio.play('button');
  void router.push('/briefing/' + key);
}
void base;
</script>

<template>
  <MenuShell>
    <template #left>
      <div class="menu-title">{{ group.label }}</div>
      <div class="vlist">
        <button
          v-for="key in group.tracks"
          :key="key"
          class="track-btn"
          @click="openTrack(key)"
        >
          {{ trackLabel(key) }}
        </button>
      </div>
    </template>
    <template #right>
      <div class="menu-watermark">{{ group.id }}</div>
    </template>
  </MenuShell>
</template>
