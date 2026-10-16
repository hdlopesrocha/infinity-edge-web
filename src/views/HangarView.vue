<!-- Hangar: the player's ship and its properties. The numbers come from the
     same sources the simulation uses (Physics.SS1, Life3 100|100|100, the
     weapon/addon rules in objects.ts and the model manifest), so the panel
     cannot drift from what the ship actually does. -->
<script setup lang="ts">
import { computed } from 'vue';
import MenuShell from '../components/MenuShell.vue';
import { P } from '../game/physics';
import { MODELS } from '../game/config';

const base = (import.meta.env.BASE_URL + 'assets/textures/').replace(/([^:])\/\//g, '$1/');

/** The ship the player flies (levels use model Fighter3 with Physics.SS1). */
const ship = MODELS.find((m) => m.name === 'Fighter3') ?? MODELS[0];
const phys = P.SS1;

const rows = computed(() => [
  ['Hull', '100 | 100 | 100'],
  ['Top speed', `${phys.velMax} u/s`],
  ['Thrust', `${phys.accelMax} u/s²`],
  ['Turn rate', `${(phys.maxAngular * (180 / Math.PI)).toFixed(1)}° / frame`],
  ['Cannon', '2 mounts, 200 ms cycle'],
  ['Homing missiles', '2 carried, 2 per pickup'],
  ['Nitro', '3 s burn at 7.5× thrust'],
  ['Shield', 'absorbs 10 hits'],
  ['Repair', 'restores the full hull'],
]);

/** Keyboard controls (plain keys only: no Ctrl/Alt, so the browser keeps its
 *  own shortcuts -- Ctrl+W closes the tab and can never be intercepted). */
const controls = [
  ['Thrust', 'C'],
  ['Turn / pitch', 'W A S D or arrows'],
  ['Fire cannon', 'Space'],
  ['Homing missile', 'M'],
  ['Nitro', 'Shift or N'],
  ['Back', 'Esc or Backspace'],
];
</script>

<template>
  <MenuShell>
    <template #left>
      <div class="vlist">
        <img class="hangar-ship" :src="base + 'Fighter3_icon.png'" alt="" />
        <div class="f-middle c-white">{{ ship.name.replace(/(\D)(\d)/, '$1 $2').toUpperCase() }}</div>
        <div class="f-small c-white60">multi-role interceptor</div>
      </div>
    </template>
    <template #right>
      <div class="f-small c-white" style="text-align: left; width: 100%;">
        <div v-for="[k, v] in rows" :key="k" class="hangar-row">
          <span class="c-white70">{{ k }}</span>
          <span>{{ v }}</span>
        </div>
        <div class="f-middle c-white" style="margin-top: 14px;">CONTROLS</div>
        <div v-for="[k, v] in controls" :key="k" class="hangar-row">
          <span class="c-white70">{{ k }}</span>
          <span>{{ v }}</span>
        </div>
      </div>
    </template>
  </MenuShell>
</template>

<style scoped>
.hangar-ship { width: 160px; height: 160px; object-fit: contain; }
.hangar-row { display: flex; justify-content: space-between; gap: 24px; padding: 2px 0; }
</style>
