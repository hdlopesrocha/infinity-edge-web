<!-- About credits (About.cs). -->
<script setup lang="ts">
import MenuShell from '../components/MenuShell.vue';
</script>

<template>
  <MenuShell>
    <template #left>
      <div class="menu-title">Infinity Edge 1.0.0.2</div>
      <div class="menu-text small">
        <div>Graphics: Goncalo Rocha, Nikhil Bhatt, Henrique Rocha</div>
        <div>Sounds: Ricardo Abreu</div>
        <div>Programmers: Henrique Rocha, Nikhil Bhatt</div>
        <div>Thanks: Microsoft Lisbon</div>
      </div>
    </template>
    <template #right>
      <div class="menu-text small">
        Web migration of the XNA space combat game — Vue 3 + TypeScript +
        raw WebGL2. Original content by the Infinity Edge team.
      </div>
    </template>
  </MenuShell>
</template>
