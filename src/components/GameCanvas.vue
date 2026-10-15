<!-- Persistent WebGL host: Renderer + RC + active GameInstance. -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Renderer } from '../engine/renderer';
import { mat4, vec3 } from '../engine/math';
import { GameInstance } from '../game/instance';
import { RC } from '../game/resources';
import { loadLevel } from '../game/levels';
import { ensureManifests, warmManifests } from '../game/assetmanifest';
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
// EngineScreen: wheel model on black, CommandLookAtPositionAuto camera
// (angle++ per 30 fps frame, radius 6, height 3, lookAt target + Up).
let engineScene: { gpu: import('../engine/model').GpuModel; tex: import('../engine/texture').TexEntry | null; t: number } | null = null;
let engineBuilding = false;

async function buildEngineScene(): Promise<void> {
  if (!rc || engineBuilding || engineScene) return;
  engineBuilding = true;
  try {
    await rc.preload(['Wheel'], []);
    const m = rc.model('Wheel');
    const gpu = m?.solid[0] ?? m?.color[0] ?? null;
    if (gpu) engineScene = { gpu, tex: m?.tex ?? null, t: 0 };
  } finally {
    engineBuilding = false;
  }
}

async function rebuild(): Promise<void> {
  if (!renderer || !rc) return;
  // Asset manifests first: with them the loaders request exactly the files that
  // exist instead of probing candidates (which logged 404s).
  await ensureManifests();
  const key = store.sceneKey;
  if (key === 'engine') {
    void buildEngineScene();
    return;
  }
  engineScene = null;
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

/**
 * Losing the window while a turn key (or a drag) is held used to leave the input
 * stuck: the browser never delivers the matching keyup/pointerup, so the ship
 * kept turning in one direction forever. Clearing the held inputs on blur /
 * hidden-tab fixes it (the player just presses the key again).
 */
function clearHeldInputs(): void {
  instance?.control.keys.clear();
  instance?.control.touches.clear();
}

function onWindowBlur(): void {
  clearHeldInputs();
}

function onVisibilityChange(): void {
  if (document.hidden) clearHeldInputs();
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
    warmManifests();
    syncOptionsFromRC(rc.options);
    audio.setMusicVolume(rc.options.musicVolume);
    (window as unknown as { __ieRenderer?: Renderer }).__ieRenderer = renderer;
    (window as unknown as { __ieStore?: typeof store }).__ieStore = store;
    (window as unknown as { __ieRC?: RC }).__ieRC = rc;
    renderer.onRebuilt = () => {
      building = '';
      void rebuild();
    };
    // Boot: load every model, texture and level up front (the boot screens show
    // a Floating-Gear loading bar until this finishes).
    store.loading.active = true;
    store.loading.done = 0;
    store.loading.total = 0;
    store.loading.failed = 0;
    void rc
      .preloadAll((done, total) => {
        store.loading.done = done;
        store.loading.total = total;
      })
      .catch((e) => {
        store.loading.failed++;
        console.warn('[boot] preload finished with errors:', e);
      })
      .finally(() => {
        store.loading.done = store.loading.total;
        store.loading.active = false;
      });
    renderer.onFrame = (dtMs) => {
      if (!renderer || !rc) return;
      // Live render options: the post chain reads them every frame, so the
      // Options screen changes take effect immediately (and roll back on
      // cancel).
      renderer.renderOptions.motionBlur = rc.options.motionBlur;
      renderer.renderOptions.flareTex = rc.tex('flare2');
      // Lens flare belongs to the game/menu scenes; the boot wheel stays crisp.
      renderer.renderOptions.flare = rc.options.billboards && store.sceneKey !== 'engine' ? 0.45 : 0;
      if (store.sceneKey === 'engine') {
        if (!engineScene) {
          void buildEngineScene();
          renderer.beginFrame();
          renderer.endFrame();
          return;
        }
        const s = engineScene;
        s.t += dtMs;
        const total = 3000, trans = 500;
        const a = Math.max(0, Math.min(1, Math.min(s.t / trans, (total - s.t) / trans)));
        const rad = ((s.t / (1000 / 30)) * Math.PI) / 180;
        const cam = renderer.camera;
        vec3.set(cam.position, -6 * Math.sin(rad), 3, -6 * Math.cos(rad));
        vec3.set(cam.lookAt, 0, 1, 0);
        vec3.set(cam.up, 0, 1, 0);
        cam.updateMatrices();
        renderer.beginFrame();
        const draw = renderer.draw;
        draw.setOpaque();
        const world = mat4.create();
        draw.drawModel(s.gpu, s.tex, world, cam.view, cam.proj, cam.position, {
          alpha: a, emissive: [0.5019608, 0.5019608, 0.5019608], light: true,
        });
        draw.flushBillboards();
        draw.flushSmoke();
        renderer.endFrame();
        return;
      }
      if (!instance || !renderer) return;
      instance.canvasW = canvasRef.value?.clientWidth || 1280;
      instance.canvasH = canvasRef.value?.clientHeight || 720;
      instance.update(dtMs);
      renderer.beginFrame();
      instance.draw();
      renderer.endFrame();
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
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);
  } catch (e) {
    glError.value = (e as Error).message || 'WebGL2 unavailable';
  }
});

onBeforeUnmount(() => {
  window.clearInterval(sceneTimer);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  window.removeEventListener('blur', onWindowBlur);
  document.removeEventListener('visibilitychange', onVisibilityChange);
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
