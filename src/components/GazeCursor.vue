<!-- VR gaze cursor: in VR mode a dot follows the head (yaw/pitch from the
     gyroscope, mapped across the screen) and dwelling on a button clicks it,
     with a ring that fills over the configured time. Menus keep the 3D view
     still, so the dot sweeps a fixed screen and staring at a button is
     unambiguous. The dwell lives in Options (VR Dwell Time, 2 s default). -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { store } from '../game/store';
import { vrLook } from '../game/vr';

/** 0.5x the previous cursor. */
const RADIUS = 9;
const AIM_SRC = (import.meta.env.BASE_URL + 'assets/textures/_aim.png')
  .replace(/([^:])\/\//g, '$1/');

/** Screen pixels per degree, derived from the live chase camera projection. */
function pxPerDeg(): { x: number; y: number } {
  const r = (window as unknown as {
    __ieRenderer?: { camera?: { fov?: number; aspect?: number } };
  }).__ieRenderer;
  const fov = r?.camera?.fov && Number.isFinite(r.camera.fov)
    ? r.camera.fov
    : Math.PI / 4;
  const aspect = r?.camera?.aspect && r.camera.aspect > 0
    ? r.camera.aspect
    : Math.max(1, window.innerWidth) / Math.max(1, window.innerHeight);
  const half = Math.tan(fov / 2);
  const rad = Math.PI / 180;
  return {
    x: (window.innerWidth / 2) / (half * aspect) * rad,
    y: (window.innerHeight / 2) / half * rad,
  };
}

/** Current dwell from Options, clamped to the same range as the menu. */
function dwellMs(): number {
  const seconds = Number(store.options.dwellTime);
  return (Number.isFinite(seconds) ? Math.max(0.5, Math.min(5, seconds)) : 2) * 1000;
}

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
  const ppd = pxPerDeg();
  const cx = window.innerWidth / 2 + look.yaw * ppd.x;
  const cy = window.innerHeight / 2 - look.pitch * ppd.y;
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
  const dwell = dwellMs();
  progress.value = Math.min(1, heldFor / dwell);
  if (heldFor >= dwell) {
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
      <circle :cx="RADIUS + 4" :cy="RADIUS + 4" :r="RADIUS" class="gaze-fill"
              :stroke-dasharray="2 * Math.PI * RADIUS"
              :stroke-dashoffset="2 * Math.PI * RADIUS * (1 - progress)" />
    </svg>
    <!-- Same crosshair art as the in-game spaceship HUD. -->
    <img class="gaze-aim" :src="AIM_SRC" alt="" draggable="false" />
  </div>
</template>

<style scoped>
.gaze {
  position: fixed; left: 0; top: 0; z-index: 60; pointer-events: none;
  transform: translate(-50%, -50%); width: calc(var(--r) * 2 + 8px); height: calc(var(--r) * 2 + 8px);
}
.gaze svg { display: block; transform: rotate(-90deg); }
.gaze-fill { fill: none; stroke: var(--accent); stroke-width: 4; stroke-linecap: round; opacity: 0.8; }
.gaze-aim {
  position: absolute; left: 50%; top: 50%; width: calc(var(--r) * 2); height: calc(var(--r) * 2);
  transform: translate(-50%, -50%); filter: drop-shadow(0 0 4px rgba(0,0,0,0.8));
}
</style>
