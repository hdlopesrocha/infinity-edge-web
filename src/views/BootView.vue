<!-- EngineScreen (wheel + engineLogo, 3s) -> StartScreen (logo over
     Background.xml, 3s). The engine screen draws the wheel over black
     (EngineScreen.xml has no background); the start screen shows the
     Background scene (StartScreen.xml -> Content/Background.xml). -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { audio } from '../game/audio';

const router = useRouter();
const route = useRoute();
const fading = ref(false);
const base = (import.meta.env.BASE_URL + 'assets/textures/').replace(/([^:])\/\//g, '$1/');
const timers: number[] = [];

const screen = computed(() => String(route.name ?? 'boot'));

function logo(): string {
  return screen.value === 'engine' ? base + '_engineLogo.png' : base + '_gameLogo.png';
}

onMounted(() => {
  const n = screen.value;
  // Music starts with the app (Game1.LoadContent); autoplay policies may
  // defer it to the first gesture, handled globally.
  audio.unlock();
  if (n === 'boot') {
    timers.push(window.setTimeout(() => void router.replace('/engine'), 60));
    return;
  }
  timers.push(window.setTimeout(() => {
    fading.value = true;
  }, 3000));
  timers.push(window.setTimeout(() => {
    if (n === 'engine') {
      void audio.voice('welcome');
      void router.replace('/start');
    } else {
      void router.replace('/menu');
    }
  }, 3500));
});

// Leaving the screen early (deep link, back button, menu click) must cancel
// the scheduled transitions, otherwise the timer yanks the app back to /menu.
onBeforeUnmount(() => {
  for (const t of timers) window.clearTimeout(t);
  timers.length = 0;
});
</script>

<template>
  <div class="splash" :class="{ fade: fading }">
    <img :src="logo()" alt="" />
  </div>
</template>
