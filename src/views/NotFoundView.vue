<!-- Unknown route: empty chrome only (no invented text). -->
<script setup lang="ts">
import MenuShell from '../components/MenuShell.vue';
</script>

<template>
  <MenuShell wide primary="menu" primary-to="/menu">
    <template #left></template>
  </MenuShell>
</template>
