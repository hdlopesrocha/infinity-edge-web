<!-- Persistent WebGL host: Renderer + RC + active GameInstance. -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Renderer } from '../engine/renderer';
import { GameInstance } from '../game/instance';
import { RC } from '../game/resources';
import { loadLevel } from '../game/levels';
import { store, syncOptionsFromRC } from '../game/store';
import { audio } from '../game/audio';

const canvasRef = ref<HTMLCanvasElement | null>(null);
const glError = ref('');
const router = useRouter();

let renderer: Renderer | null = null;
let rc: RC | null = null;
let instance: GameInstance | null = null;
let building = '';
let buildGen = 0;
let sceneTimer = 0;
let menuDrag: { x: number; y: number } | null = null;

async function rebuild(): Promise<void> {
  if (!renderer || !rc) return;
  const key = store.sceneKey;
  const token = key + '|' + store.options.billboards;
  if (building === token) return;
  building = token;
  const gen = ++buildGen;
  try {
    const def = await loadLevel(key);
    const gi = await GameInstance.create(renderer, rc, def, store.levelText);
    // Stale-build drop: a newer rebuild started while we were loading.
    if (gen !== buildGen) return;
    gi.canvasW = canvasRef.value?.clientWidth || 1280;
    gi.canvasH = canvasRef.value?.clientHeight || 720;
    instance = gi;
    (window as unknown as { __ieGame?: GameInstance }).__ieGame = gi;
  } catch (e) {
    glError.value = 'Scene failed: ' + (e as Error).message;
    if (gen === buildGen) building = '';
  }
}

function onKeyDown(e: KeyboardEvent): void {
  audio.unlock();
  if (e.code === 'Backspace' && (e.target as HTMLElement)?.tagName !== 'INPUT') {
    router.back();
    return;
  }
  instance?.control.keys.add(e.code);
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
}

function onKeyUp(e: KeyboardEvent): void {
  instance?.control.keys.delete(e.code);
}

function canvasPos(e: PointerEvent): { x: number; y: number } {
  const r = (e.target as HTMLElement).getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function onPointerDown(e: PointerEvent): void {
  audio.unlock();
  rc?.startMusic();
  if (!instance || !canvasRef.value) return;
  const p = canvasPos(e);
  if (instance.gameType === 'BACK') {
    menuDrag = p;
  } else {
    instance.control.touches.set(e.pointerId, p);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }
}

function onPointerMove(e: PointerEvent): void {
  if (!instance || !renderer) return;
  const p = canvasPos(e);
  if (menuDrag && instance.gameType === 'BACK') {
    const dx = p.x - menuDrag.x;
    renderer.camera.orbitAngle = (renderer.camera.orbitAngle + dx * 0.3) % 360;
    menuDrag = p;
  } else if (instance.control.touches.has(e.pointerId)) {
    instance.control.touches.set(e.pointerId, p);
  }
}

function onPointerUp(e: PointerEvent): void {
  menuDrag = null;
  instance?.control.touches.delete(e.pointerId);
}

onMounted(() => {
  try {
    if (!canvasRef.value) return;
    renderer = new Renderer(canvasRef.value);
    rc = new RC(renderer);
    syncOptionsFromRC(rc.options);
    audio.setMusicVolume(rc.options.musicVolume);
    (window as unknown as { __ieRenderer?: Renderer }).__ieRenderer = renderer;
    (window as unknown as { __ieStore?: typeof store }).__ieStore = store;
    (window as unknown as { __ieRC?: RC }).__ieRC = rc;
    renderer.onRebuilt = () => {
      building = '';
      void rebuild();
    };
    renderer.onFrame = (dtMs) => {
      if (!instance || !renderer) return;
      instance.canvasW = canvasRef.value?.clientWidth || 1280;
      instance.canvasH = canvasRef.value?.clientHeight || 720;
      instance.update(dtMs);
      renderer.beginFrame();
      instance.draw();
      if (instance.result && store.route === 'game') {
        const lv = store.levelKey;
        const won = instance.result.won;
        store.result = { ...instance.result, level: lv };
        instance.result = null;
        void router.push((won ? '/victory/' : '/defeat/') + lv);
      }
    };
    void rebuild();
    renderer.start();
    sceneTimer = window.setInterval(() => {
      void rebuild();
      if (renderer && rc && store.options.distance !== rc.options.distance) {
        renderer.camera.far = store.options.distance;
      }
    }, 300);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
  } catch (e) {
    glError.value = (e as Error).message || 'WebGL2 unavailable';
  }
});

onBeforeUnmount(() => {
  window.clearInterval(sceneTimer);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  renderer?.dispose();
  renderer = null;
  instance = null;
});
</script>

<template>
  <canvas
    ref="canvasRef"
    aria-label="Infinity Edge 3D scene"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  ></canvas>
  <div v-if="glError" class="hud">
    <div class="hud-notify">{{ glError }}</div>
  </div>
</template>
