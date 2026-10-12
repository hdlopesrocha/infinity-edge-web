<!-- Victory/Defeat screens (GameInstance reward flow): medal click -> back. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import MenuShell from '../components/MenuShell.vue';
import { LEVELS } from '../game/levels';
import { store } from '../game/store';
import { audio } from '../game/audio';

const route = useRoute();
const router = useRouter();
const key = computed(() => String(route.params.level ?? ''));
const won = computed(() => String(route.name) === 'victory');
const level = computed(() => LEVELS[key.value]);
const base = import.meta.env.BASE_URL + 'assets/textures/';

function back(): void {
  void audio.play('button');
  void router.push('/briefing/' + key.value);
}
</script>

<template>
  <MenuShell>
    <template #left>
      <div v-if="won" class="menu-title">Congratulations {{ store.options.username || 'Pilot' }}</div>
      <div v-else class="menu-title">{{ level?.goals.find((g) => g.reward === 'Defeat')?.message ?? 'Defeat' }}</div>
      <div class="fit-list">
        <button class="icon-btn" @click="back"><img :src="base + '_gold.png'" alt="gold" /><span>GOLD</span></button>
        <button class="icon-btn" @click="back"><img :src="base + '_silver.png'" alt="silver" /><span>SILVER</span></button>
        <button class="icon-btn" @click="back"><img :src="base + '_bronze.png'" alt="bronze" /><span>BRONZE</span></button>
      </div>
    </template>
    <template #right>
      <div class="menu-text">{{ won ? 'Objective completed!' : 'Try again, pilot.' }}</div>
    </template>
  </MenuShell>
</template>
