<!-- GenericMenu chrome: _backWindow + split sides + 160x48 corner buttons.
     _buttonLU pops history (exit when alone); _buttonRU is the action slot. -->
<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import { computed } from 'vue';
import { audio } from '../game/audio';

const props = withDefaults(
  defineProps<{
    primary?: string;
    primaryTo?: string;
    onPrimary?: (() => void) | null;
    ldLabel?: string;
    rdLabel?: string;
    noBack?: boolean;
  }>(),
  { primary: '', primaryTo: '', onPrimary: null, ldLabel: '', rdLabel: '', noBack: false },
);

const router = useRouter();
const route = useRoute();
const backLabel = computed(() => {
  const n = String(route.name ?? '');
  return n === 'menu' || n === 'engine' || n === 'start' || n === 'boot' ? 'exit' : 'back';
});

function goBack(): void {
  audio.unlock();
  void audio.sfx('button');
  if (backLabel.value === 'exit') void router.push('/');
  else if (window.history.length > 1) router.back();
  else void router.push('/menu');
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
    <div class="menu-left"><slot name="left" /></div>
    <div class="menu-right"><slot name="right" /></div>
  </div>
  <button v-if="!noBack" class="corner-btn lu" @click="goBack">{{ backLabel }}</button>
  <button v-if="primary" class="corner-btn ru go" @click="goPrimary">{{ primary }}</button>
  <div v-if="ldLabel" class="corner-btn ld" aria-hidden="true">{{ ldLabel }}</div>
  <div v-if="rdLabel" class="corner-btn rd" aria-hidden="true">{{ rdLabel }}</div>
</template>
