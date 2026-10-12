<!-- Root: persistent WebGL canvas behind the routed Vue UI overlay. -->
<script setup lang="ts">
import { RouterView } from 'vue-router';
import GameCanvas from './components/GameCanvas.vue';
</script>

<template>
  <div class="app-root">
    <div class="viewport-layer">
      <GameCanvas />
    </div>
    <div class="ui-layer">
      <RouterView />
    </div>
  </div>
</template>
