<!-- Root: persistent WebGL canvas behind the routed Vue UI overlay. -->
<script setup lang="ts">
import { RouterView, useRoute } from 'vue-router';
import GameCanvas from './components/GameCanvas.vue';

const route = useRoute();
</script>

<template>
  <div class="app-root">
    <div class="viewport-layer">
      <GameCanvas />
    </div>
    <div class="ui-layer">
      <RouterView :key="route.fullPath" />
    </div>
  </div>
</template>
