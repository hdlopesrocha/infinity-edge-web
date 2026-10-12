<!-- Victory ("Congratulations <user>!" + message + medal unless
     Victory/None/Defeat) / Defeat (message only). Medal click -> back. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import MenuShell from '../components/MenuShell.vue';
import { store } from '../game/store';
import { audio } from '../game/audio';

const route = useRoute();
const router = useRouter();
const res = computed(() => store.result);
const won = computed(() => String(route.name) === 'victory');
const base = (import.meta.env.BASE_URL + 'assets/textures/').replace(/([^:])\/\//g, '$1/');
const medal = computed(() => {
  const r = res.value?.reward;
  if (r === 'Gold') return base + '_gold.png';
  if (r === 'Silver') return base + '_silver.png';
  if (r === 'Bronze') return base + '_bronze.png';
  return null;
});

function back(): void {
  void audio.sfx('button');
  const lv = String(route.params.level ?? '');
  void router.push(lv ? '/briefing/' + lv : '/menu');
}
</script>

<template>
  <MenuShell>
    <template #left>
      <div v-if="won" class="menu-title">Congratulations {{ store.username || 'Infinity Fan' }}!</div>
      <div v-else class="menu-title">{{ res?.message ?? 'Defeat' }}</div>
      <div v-if="won && res?.message" class="menu-text">{{ res.message }}</div>
      <div v-if="won && medal" class="fit-list">
        <img class="medal" :src="medal" alt="medal" @click="back" />
      </div>
    </template>
    <template #right>
      <div class="menu-text small">Press the medal or back to return to the briefing.</div>
    </template>
  </MenuShell>
</template>
