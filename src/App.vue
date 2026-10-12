<script setup>
// Root app: 3D viewport layer + HTML UI layer (Vue screens mounted on top).
</script>

<template>
  <div class="app-root">
    <div class="viewport-layer" />
    <div class="ui-layer" />
  </div>
</template>

<style>
.app-root { position: absolute; inset: 0; }
.viewport-layer { position: absolute; inset: 0; }
.ui-layer { position: absolute; inset: 0; pointer-events: none; }
.ui-layer :deep(button) { pointer-events: auto; }
</style>
