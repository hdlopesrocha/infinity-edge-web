<!-- Root: persistent WebGL canvas behind the routed Vue UI overlay. -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterView, useRoute } from 'vue-router';
import GameCanvas from './components/GameCanvas.vue';
import { isFullscreen, toggleFullscreen } from './game/ui/fullscreen';
import { toggleVrMode } from './game/vr';
import { audio } from './game/audio';
import { store } from './game/store';

const route = useRoute();
const fullscreen = ref(false);

function onFullscreenChange(): void {
  fullscreen.value = isFullscreen();
}

/** In-match pause, the same action the old HUD corner button performed. */
function pauseGame(): void {
  audio.unlock();
  void audio.sfx('button');
  store.paused = true;
}

function toggleVr(): void {
  void toggleVrMode();
}

onMounted(() => document.addEventListener('fullscreenchange', onFullscreenChange));
onBeforeUnmount(() => document.removeEventListener('fullscreenchange', onFullscreenChange));
</script>

<template>
  <div class="app-root">
    <div class="viewport-layer">
      <GameCanvas />
    </div>
    <div class="ui-layer">
      <RouterView :key="route.fullPath" />
    </div>
    <!-- In-match chrome: back (pause), VR and fullscreen, the same cluster the
         WebGL menus paint in their action column. -->
    <div v-if="route.name === 'game' && !store.paused" class="game-chrome">
      <button class="chrome-btn" type="button" aria-label="pause" title="pause" @click="pauseGame">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            d="M14 5 7 12l7 7"
            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
          />
        </svg>
      </button>
      <button
        class="chrome-btn" :class="{ on: store.vr }" type="button"
        :aria-label="store.vr ? 'exit VR' : 'VR'" :title="store.vr ? 'exit VR' : 'VR'"
        @click="toggleVr"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <rect x="3.5" y="8" width="7" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.8" />
          <rect x="13.5" y="8" width="7" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.8" />
          <path d="M10.5 12h3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </svg>
      </button>
      <button
        class="chrome-btn" type="button"
        :aria-label="fullscreen ? 'exit fullscreen' : 'fullscreen'"
        :title="fullscreen ? 'exit fullscreen' : 'fullscreen'"
        @click="toggleFullscreen"
      >
        <svg v-if="!fullscreen" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"
            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
          />
        </svg>
        <svg v-else viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"
            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
          />
        </svg>
      </button>
    </div>
  </div>
</template>
