<!-- Boot splashes: EngineScreen (wheel scene + engineLogo) then StartScreen
     (gameLogo), 3000ms + 500ms fades, then MainMenu. -->
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { audio } from '../game/audio';

const router = useRouter();
const route = useRoute();
const fading = ref(false);
const base = (import.meta.env.BASE_URL + 'assets/textures/').replace(/([^:])\/\//g, '$1/');

function logo(): string {
  const n = String(route.name ?? 'boot');
  if (n === 'engine') return base + '_engineLogo.png';
  return base + '_gameLogo.png';
}

onMounted(() => {
  const n = String(route.name ?? 'boot');
  if (n === 'boot') {
    window.setTimeout(() => void router.replace('/engine'), 60);
    return;
  }
  if (n === 'engine') void audio.voice('welcome');
  window.setTimeout(() => {
    fading.value = true;
  }, 3000);
  window.setTimeout(() => void router.replace(n === 'engine' ? '/start' : '/menu'), 3500);
});
</script>

<template>
  <div class="splash" :class="{ fade: fading }">
    <img :src="logo()" alt="Infinity Edge" />
  </div>
</template>
