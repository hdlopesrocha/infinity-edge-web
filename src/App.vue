<!-- Root: persistent WebGL canvas behind the routed Vue UI overlay. -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterView, useRoute } from 'vue-router';
import GameCanvas from './components/GameCanvas.vue';
import { isFullscreen, toggleFullscreen } from './game/ui/fullscreen';
import { store } from './game/store';

const route = useRoute();
const fullscreen = ref(false);

function onFullscreenChange(): void {
  fullscreen.value = isFullscreen();
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
    <button
      v-if="route.name === 'game' && !store.paused"
      class="fs-btn"
      type="button"
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
</template>
