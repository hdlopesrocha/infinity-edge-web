<!-- VR gaze cursor: in VR mode a dot follows the head (yaw/pitch from the
     gyroscope, mapped across the screen) and dwelling on a button for one
     second clicks it, with a ring that fills as the second passes. Menus keep
     the 3D view still, so the dot sweeps a fixed screen and staring at a
     button is unambiguous. -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { store } from '../game/store';
import { vrLook } from '../game/vr';

/** Pixels of screen travel per degree of head turn. */
const PX_PER_DEG = 9;
/** Dwell needed to click, in ms. */
const DWELL_MS = 1000;
const RADIUS = 18;

const x = ref(-100);
const y = ref(-100);
const progress = ref(0);
const visible = ref(false);

let raf = 0;
let lastT = 0;
let held: Element | null = null;
let heldFor = 0;
let cooldown = 0;

/** Nearest clickable ancestor of whatever sits under the dot. */
function pick(el: Element | null): HTMLElement | null {
  for (let e: Element | null = el; e; e = e.parentElement) {
    if (e instanceof HTMLElement && (e.tagName === 'BUTTON' || e.getAttribute('role') === 'button')) {
      return (e as HTMLButtonElement).disabled ? null : e;
    }
  }
  return null;
}

function loop(now: number): void {
  raf = requestAnimationFrame(loop);
  const dt = Math.min(50, lastT ? now - lastT : 16);
  lastT = now;
  if (!store.vr) {
    visible.value = false;
    held = null;
    heldFor = 0;
    progress.value = 0;
    return;
  }
  const look = vrLook();
  if (!look.tracking) {
    visible.value = false;
    return;
  }
  visible.value = true;
  const cx = window.innerWidth / 2 + look.yaw * PX_PER_DEG;
  const cy = window.innerHeight / 2 - look.pitch * PX_PER_DEG;
  x.value = Math.max(RADIUS, Math.min(window.innerWidth - RADIUS, cx));
  y.value = Math.max(RADIUS, Math.min(window.innerHeight - RADIUS, cy));
  if (cooldown > 0) {
    cooldown -= dt;
    progress.value = 0;
    return;
  }
  // elementFromPoint ignores anything with pointer-events: none, which the
  // cursor itself sets, so the dot never blocks its own target.
  const el = pick(document.elementFromPoint(x.value, y.value));
  if (el !== held) {
    held = el;
    heldFor = 0;
  }
  if (!el) {
    progress.value = 0;
    return;
  }
  heldFor += dt;
  progress.value = Math.min(1, heldFor / DWELL_MS);
  if (heldFor >= DWELL_MS) {
    heldFor = 0;
    held = null;
    progress.value = 0;
    cooldown = 400;
    el.click();
  }
}

onMounted(() => { raf = requestAnimationFrame(loop); });
onBeforeUnmount(() => cancelAnimationFrame(raf));
</script>

<template>
  <div v-if="visible" class="gaze" :style="`left:${x}px;top:${y}px;--r:${RADIUS}px;`">
    <svg :width="RADIUS * 2 + 8" :height="RADIUS * 2 + 8" :viewBox="`0 0 ${RADIUS * 2 + 8} ${RADIUS * 2 + 8}`">
      <circle :cx="RADIUS + 4" :cy="RADIUS + 4" :r="RADIUS" class="gaze-ring" />
      <circle :cx="RADIUS + 4" :cy="RADIUS + 4" :r="RADIUS" class="gaze-fill"
              :stroke-dasharray="2 * Math.PI * RADIUS"
              :stroke-dashoffset="2 * Math.PI * RADIUS * (1 - progress)" />
    </svg>
    <span class="gaze-dot" />
  </div>
</template>

<style scoped>
.gaze {
  position: fixed; left: 0; top: 0; z-index: 60; pointer-events: none;
  transform: translate(-50%, -50%); width: calc(var(--r) * 2 + 8px); height: calc(var(--r) * 2 + 8px);
}
.gaze svg { display: block; transform: rotate(-90deg); }
.gaze-ring { fill: none; stroke: rgba(255, 255, 255, 0.35); stroke-width: 3; }
.gaze-fill { fill: none; stroke: var(--accent); stroke-width: 4; stroke-linecap: round; }
.gaze-dot {
  position: absolute; left: 50%; top: 50%; width: 6px; height: 6px; margin: -3px 0 0 -3px;
  border-radius: 50%; background: var(--accent); box-shadow: 0 0 8px var(--accent);
}
</style>
