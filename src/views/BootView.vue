<!-- EngineScreen (wheel + engineLogo, 3s) -> StartScreen (logo over
     Background.xml, 3s). The engine screen draws the wheel over black
     (EngineScreen.xml has no background); the start screen shows the
     Background scene (StartScreen.xml -> Content/Background.xml).
     Web addition: the boot screens also show the Floating-Gear loading bar
     while every model/texture/level is fetched, and the sequence only advances
     to the menu once the load has finished. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { audio } from '../game/audio';
import { store } from '../game/store';

const router = useRouter();
const route = useRoute();
const fading = ref(false);
const base = (import.meta.env.BASE_URL + 'assets/textures/').replace(/([^:])\/\//g, '$1/');
const timers: number[] = [];

const screen = computed(() => String(route.name ?? 'boot'));
const loading = computed(() => store.loading);
const pct = computed(() => {
  const t = store.loading.total;
  return t > 0 ? Math.min(100, Math.round((store.loading.done / t) * 100)) : 0;
});

// Minimum on-screen time per splash (the original timers), the real gate is the
// asset preload: the menu only appears after everything is loaded.
const MIN_MS: Record<string, number> = { engine: 3000, start: 1500 };
const minElapsed = ref(false);

function logo(): string {
  return screen.value === 'engine' ? base + '_engineLogo.png' : base + '_gameLogo.png';
}

function tryAdvance(): void {
  const n = screen.value;
  if (n === 'boot' || fading.value) return;
  if (!minElapsed.value || store.loading.active) return;
  fading.value = true;
  timers.push(window.setTimeout(() => {
    if (n === 'engine') {
      void audio.voice('welcome');
      void router.replace('/start');
    } else {
      void router.replace('/menu');
    }
  }, 500));
}

watch(() => store.loading.active, () => tryAdvance());

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
    minElapsed.value = true;
    tryAdvance();
  }, MIN_MS[n] ?? 3000));
  tryAdvance();
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
  <div v-if="loading.active" class="fg-loading" role="status" aria-live="polite">
    <div class="fg-loading-panel">
      <div class="fg-loading-title">loading</div>
      <div class="fg-loading-track">
        <div class="fg-loading-fill" :style="`width:${pct}%`"></div>
      </div>
      <div class="fg-loading-count">{{ loading.done }} / {{ loading.total || '…' }}</div>
    </div>
  </div>
</template>
