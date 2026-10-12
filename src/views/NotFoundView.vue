<!-- Unknown routes handled gracefully (back to menu). -->
<script setup lang="ts">
import MenuShell from '../components/MenuShell.vue';
</script>

<template>
  <MenuShell primary="menu" primary-to="/menu">
    <template #left><div class="menu-title">Unknown route</div></template>
    <template #right><div class="menu-text">This screen does not exist. The background scene is unchanged.</div></template>
  </MenuShell>
</template>
