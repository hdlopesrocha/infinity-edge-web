<!-- EngineScreen (wheel + engineLogo, Welcome, 3s) -> StartScreen (logo, 3s). -->
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { audio } from '../game/audio';

const router = useRouter();
const route = useRoute();
const fading = ref(false);
const base = (import.meta.env.BASE_URL + 'assets/textures/').replace(/([^:])\/\//g, '$1/');

function logo(): string {
  return String(route.name ?? 'boot') === 'engine' ? base + '_engineLogo.png' : base + '_gameLogo.png';
}

onMounted(() => {
  const n = String(route.name ?? 'boot');
  if (n === 'boot') {
    window.setTimeout(() => void router.replace('/engine'), 60);
    return;
  }
  window.setTimeout(() => {
    fading.value = true;
  }, 3000);
  window.setTimeout(() => {
    if (n === 'engine') {
      void audio.voice('welcome');
      void router.replace('/start');
    } else {
      void router.replace('/menu');
    }
  }, 3500);
});
</script>

<template>
  <div class="splash" :class="{ fade: fading }">
    <img :src="logo()" alt="" />
  </div>
</template>
