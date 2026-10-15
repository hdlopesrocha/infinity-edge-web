<!-- King of the System / Survival menu: the three difficulties (PEGASUS /
     LEO / DRACO, same as CTF) plus a TEAMS / SOLO switch that swaps which set
     of levels the difficulty buttons open. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import MenuShell from '../components/MenuShell.vue';
import { KOTS_LEVELS, MODE_CAPS, MODE_ICONS, SURV_LEVELS } from '../game/levels';
import { audio } from '../game/audio';

const route = useRoute();
const router = useRouter();
const base = (import.meta.env.BASE_URL + 'assets/textures/').replace(/([^:])\/\//g, '$1/');
const teams = ref(true);

const mode = computed(() => (route.name === 'survival' ? 'surv' : 'kots'));
const levels = computed(() => (mode.value === 'surv' ? SURV_LEVELS : KOTS_LEVELS));
const keys = computed(() => (teams.value ? levels.value.teams : levels.value.solo));
const diffs = ['easy', 'normal', 'hard'] as const;

function open(key: string): void {
  audio.unlock();
  void audio.sfx('button');
  void router.push('/briefing/' + key);
}

function toggle(): void {
  audio.unlock();
  void audio.sfx('button');
  teams.value = !teams.value;
}
</script>

<template>
  <MenuShell wide>
    <template #left>
      <div class="vlist">
        <div class="fit-list">
          <button v-for="(key, i) in keys" :key="key" class="icon-btn" @click="open(key)">
            <img :src="base + MODE_ICONS[diffs[i]]" alt="" />
            <span class="cap">{{ MODE_CAPS[diffs[i]] }}</span>
          </button>
        </div>
        <button
          class="track-btn menubtn-wide"
          :style="`background-image:url(${base}_menubtn.png);`"
          @click="toggle"
        >
          {{ teams ? 'TEAMS' : 'SOLO' }}
        </button>
      </div>
    </template>
  </MenuShell>
</template>
