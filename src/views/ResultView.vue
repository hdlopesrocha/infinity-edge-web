<!-- Victory / Defeat (37_T): "Congratulations <user>!" + message +
     medal 128px (Gold/Silver/Bronze only) -> back. -->
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
const user = computed(() => store.username || store.options.username || 'Infinity Fan');

function back(): void {
  void audio.sfx('button');
  const lv = String(route.params.level ?? '');
  void router.push(lv ? '/briefing/' + lv : '/menu');
}
</script>

<template>
  <MenuShell wide>
    <template #left>
      <div v-if="won" class="f-default c-white">Congratulations {{ user }}!</div>
      <div v-if="won && res?.message" class="f-default c-white">{{ res.message }}</div>
      <div v-if="!won && res?.message" class="f-default c-white">{{ res.message }}</div>
      <div v-if="won && medal">
        <img class="medal" :src="medal" alt="" @click="back" />
      </div>
    </template>
  </MenuShell>
</template>
