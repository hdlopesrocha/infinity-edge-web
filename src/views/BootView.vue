<!-- Boot splash sequence: EngineScreen (3000ms + 500ms fade) then StartScreen
     (3000ms + fade), then MainMenu. Mirrors Game1.LoadContent scene stack. -->
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { audio } from '../game/audio';

const router = useRouter();
const route = useRoute();
const fading = ref(false);

function logoFor(): string {
  const name = String(route.name ?? 'boot');
  // /engine shows engineLogo; /start and / show gameLogo.
  if (name === 'engine') return import.meta.env.BASE_URL + 'assets/textures/_engineLogo.png';
  return import.meta.env.BASE_URL + 'assets/textures/_gameLogo.png';
}

onMounted(() => {
  const name = String(route.name ?? 'boot');
  if (name === 'boot') {
    // Root URL: play the full stack quickly (engine -> start -> menu).
    window.setTimeout(() => void router.replace('/engine'), 50);
    return;
  }
  if (name === 'engine') {
    void audio.speak('Welcome');
    window.setTimeout(() => {
      fading.value = true;
    }, 3000);
    window.setTimeout(() => void router.replace('/start'), 3500);
    return;
  }
  window.setTimeout(() => {
    fading.value = true;
  }, 3000);
  window.setTimeout(() => void router.replace('/menu'), 3500);
});
</script>

<template>
  <div class="splash" :class="{ fade: fading }">
    <img :src="logoFor()" alt="Infinity Edge" />
  </div>
</template>
