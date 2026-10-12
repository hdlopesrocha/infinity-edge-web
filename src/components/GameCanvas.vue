<!-- Persistent WebGL canvas: context lives across route changes; only the
     scene description swaps (background <-> level), like rc._background vs
     GameInstance maps. UI interactions never reach the canvas (overlay). -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { Renderer } from '../engine/scene';
import type { SceneDesc } from '../engine/scene';
import { BACKGROUND, LEVELS } from '../game/levels';
import { store } from '../game/store';

const canvasRef = ref<HTMLCanvasElement | null>(null);
let renderer: Renderer | null = null;
const route = useRoute();
let stopWatch: (() => void) | null = null;
const glError = ref('');

async function applyScene(): Promise<void> {
  if (!renderer) return;
  const key = store.sceneKey;
  const desc: SceneDesc = key === 'background' ? BACKGROUND : (LEVELS[key] ?? BACKGROUND);
  renderer.interactive = store.interactive;
  renderer.wireframe = false;
  renderer.billboards = store.options.billboards;
  renderer.motionBlur = store.options.motionBlur;
  renderer.detail = store.options.detail;
  renderer.camera.far = 512 + store.options.distance * 8;
  await renderer.setScene(desc);
}

onMounted(async () => {
  // Lazy import keeps first paint fast; canvas exists by now.
  try {
    if (!canvasRef.value) return;
    renderer = new Renderer(canvasRef.value);
    (window as unknown as { __ieRenderer?: Renderer }).__ieRenderer = renderer;
    await applyScene();
    renderer.start();
    // React to store-driven scene changes (router.afterEach -> syncSceneState).
    stopWatch = watchScene();
  } catch (e) {
    glError.value = (e as Error).message || 'WebGL2 unavailable';
  }
});

function watchScene(): () => void {
  let last = store.sceneKey + '|' + store.interactive;
  const id = window.setInterval(() => {
    const cur = store.sceneKey + '|' + store.interactive;
    if (cur !== last) {
      last = cur;
      void applyScene();
    }
    // Live option sync without scene rebuild.
    if (renderer) {
      renderer.billboards = store.options.billboards;
      renderer.motionBlur = store.options.motionBlur;
      renderer.detail = store.options.detail;
      renderer.camera.far = 512 + store.options.distance * 8;
    }
  }, 250);
  void route;
  return () => window.clearInterval(id);
}

onBeforeUnmount(() => {
  stopWatch?.();
  renderer?.dispose();
  renderer = null;
});
</script>

<template>
  <canvas ref="canvasRef" aria-label="Infinity Edge 3D scene"></canvas>
  <div v-if="glError" class="hud">
    <div class="hud-msg">{{ glError }} — UI remains usable.</div>
  </div>
</template>
