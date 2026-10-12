<!-- GenericMenu recreation: _backWindow + _leftSide/_rightSide split + four
     160x48 corner buttons. _buttonLU pops history (back/exit label like
     GenericMenu.Update), _buttonRU is the primary action slot. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { audio } from '../game/audio';
import { store } from '../game/store';

const props = withDefaults(
  defineProps<{
    /** Primary (RU) button label; empty hides it. */
    primary?: string;
    /** Route name (or path) the primary button navigates to. */
    primaryTo?: string;
    /** Called instead of navigation when provided. */
    onPrimary?: (() => void) | null;
    /** Bottom-left / bottom-right decorative labels. */
    ldLabel?: string;
    rdLabel?: string;
    /** Hide the back button (splash screens). */
    noBack?: boolean;
  }>(),
  { primary: '', primaryTo: '', onPrimary: null, ldLabel: '', rdLabel: '', noBack: false },
);

const router = useRouter();
const backLabel = computed(() =>
  window.history.length > 1 ? 'back' : 'exit',
);

function goBack(): void {
  audio.unlock();
  void audio.play('button');
  if (window.history.length > 1) router.back();
  else void router.push('/menu');
}

function goPrimary(): void {
  audio.unlock();
  void audio.play('button');
  if (props.onPrimary) {
    props.onPrimary();
    return;
  }
  if (props.primaryTo) void router.push(props.primaryTo);
}

function unlock(): void {
  audio.unlock();
}

void store;
</script>

<template>
  <div class="menu-window" @pointerdown="unlock">
    <div class="menu-left"><slot name="left" /></div>
    <div class="menu-right"><slot name="right" /></div>
  </div>
  <button v-if="!noBack" class="corner-btn lu" @click="goBack">{{ backLabel }}</button>
  <button v-if="primary" class="corner-btn ru go" @click="goPrimary">{{ primary }}</button>
  <div v-if="ldLabel" class="corner-btn ld" aria-hidden="true">{{ ldLabel }}</div>
  <div v-if="rdLabel" class="corner-btn rd" aria-hidden="true">{{ rdLabel }}</div>
</template>
