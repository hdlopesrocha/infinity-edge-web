<!-- GenericMenu chrome (from Import/GenericMenu.xml values):
     _window backWindow 0|0|0|100 full body -96px; four 160x48 corners;
     back label exit at root else back (commandTextIfRoot). -->
<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { audio } from '../game/audio';
import { goBack } from '../game/nav';

const props = withDefaults(
  defineProps<{ primary?: string; primaryTo?: string; onPrimary?: (() => void) | null; wide?: boolean }>(),
  { primary: '', primaryTo: '', onPrimary: null, wide: false },
);

const router = useRouter();
const route = useRoute();
const backText = computed(() => (String(route.name) === 'menu' ? 'exit' : 'back'));

function onBack(): void {
  audio.unlock();
  void audio.sfx('button');
  goBack(router, '/menu');
}

function goPrimary(): void {
  audio.unlock();
  void audio.sfx('button');
  if (props.onPrimary) {
    props.onPrimary();
    return;
  }
  if (props.primaryTo) void router.push(props.primaryTo);
}
</script>

<template>
  <div class="menu-window" @pointerdown="audio.unlock()">
    <div class="menu-left" :class="{ wide: wide }"><slot name="left" /></div>
    <div v-if="!wide" class="menu-right"><slot name="right" /></div>
  </div>
  <button class="corner-btn lu" @click="onBack">{{ backText }}</button>
  <button v-if="primary" class="corner-btn ru go" @click="goPrimary">{{ primary }}</button>
  <div class="corner-btn rd" aria-hidden="true"></div>
  <div class="corner-btn ld" aria-hidden="true"></div>
</template>
