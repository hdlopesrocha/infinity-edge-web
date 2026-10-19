<!-- Persistent WebGL host: Renderer + RC + active GameInstance. -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref , watch } from 'vue';
import { useRouter } from 'vue-router';
import { Renderer } from '../engine/renderer';
import { ZOOM_BLUR } from '../engine/post';
import { mat4, vec3 } from '../engine/math';
import { GameInstance } from '../game/instance';
import { NetGame, resolveGameWsUrl } from '../game/netgame';
import { mp } from '../game/mp/manager';
import { RC } from '../game/resources';
import { loadLevel } from '../game/levels';
import { ensureManifests, warmManifests } from '../game/assetmanifest';
import { store, syncOptionsFromRC } from '../game/store';
import { calibrateVr, dragLook, setVr, vrLook } from '../game/vr';
import { enterXr, leaveXr } from '../game/xr';
import { syncHud } from '../game/hud';
import { audio } from '../game/audio';
import { loadWordmarkFont } from '../game/fonts';

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
    // A multiplayer match (browser host or guest) replaces whatever ran
    // before: close the previous session, keeping the result frames flowing
    // for a moment when the match just ended.
    const previous = instance;
    const grace = previous && (previous.finished || previous.result) ? 1200 : 0;
    const joinIntent = mp.consumeJoin();
    let gi: GameInstance | null = null;
    if (joinIntent) {
      // A guest loads nothing: the host's Scene frame carries the map, the
      // model table, teams and decor, and the snapshots carry every object.
      // The level file is never fetched on this page.
      mp.endSession(grace, false);
      try {
        gi = await NetGame.openTransport(renderer, rc, joinIntent.transport, joinIntent.room.game);
      } catch (e) {
        // A guest whose room is gone must not silently fall back to a local
        // match: leave the dead connection and return to the room list.
        console.warn('[mp] joining the room failed:', e);
        mp.leaveGuest();
        try { joinIntent.transport.close(); } catch { /* already closed */ }
        void router.replace('/multiplayer');
        return;
      }
    } else {
      const def = await loadLevel(key);
      // A room this browser created and is opening right now: consume the
      // intent before the old session is torn down (it must not clear the
      // new room).
      const hostIntent = store.route === 'game' ? mp.consumeHostIntent() : null;
      mp.endSession(grace, !!hostIntent);
      // With a game server configured the C++ side owns the match: the client
      // renders its frames and streams the player's input. A missing or dead
      // server falls back to the local simulation on the same level.
      const wsUrl = resolveGameWsUrl();
      if (wsUrl) {
        try {
          gi = await NetGame.open(renderer, rc, wsUrl, def.key);
        } catch (e) {
          console.warn('[net] game server unavailable, running the local simulation:', e);
        }
      }
      if (!gi) gi = await GameInstance.create(renderer, rc, def, store.levelText);
      // A room this browser created and is now opening: become its host.
      if (!(gi instanceof NetGame) && hostIntent) mp.attachHost(gi);
    }
    // Stale-build drop: a newer rebuild started while we were loading.
    if (gen !== buildGen) {
      if (gi instanceof NetGame) gi.dispose();
      return;
    }
    gi.canvasW = canvasRef.value?.clientWidth || 1280;
    gi.canvasH = canvasRef.value?.clientHeight || 720;
    // The replaced instance may own a server session: leave the match first.
    if (instance instanceof NetGame) instance.dispose();
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

/** In VR a tap on the scene re-centres the view on the current heading. */
/** Stage 5 gets the live HUD in matches; menus keep the DOM UI. */
function uiHud(): typeof store.hud | null {
  return instance && instance.gameType !== 'BACK' ? store.hud : null;
}

function onVrTap(): void {
  if (store.vr) calibrateVr();
}

/** VR fallback: dragging across the scene looks around (touch or mouse). */
let dragging = false;
let lastX = 0;
let lastY = 0;
const VR_CONTROL_SELECTOR = '.stick-back, .stick-knob, .accel-knob, .accel-bar, .tbtn, button';
function onVrDown(e: PointerEvent): void {
  if (!store.vr) return;
  // Controls keep their own drags (stick, accel knob, HUD buttons); anywhere
  // else on the scene the drag looks around.
  const t = e.target as HTMLElement | null;
  if (t && t.closest && t.closest(VR_CONTROL_SELECTOR)) return;
  // Any click on the scene re-centres the view on the current heading.
  calibrateVr();
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
}
function onVrMove(e: PointerEvent): void {
  if (!store.vr || !dragging) return;
  dragLook(e.clientX - lastX, e.clientY - lastY);
  lastX = e.clientX;
  lastY = e.clientY;
}
function onVrUp(): void {
  dragging = false;
}

function onKeyDown(e: KeyboardEvent): void {
  audio.unlock();
  if (e.code === 'Backspace' && (e.target as HTMLElement)?.tagName !== 'INPUT') {
    router.back();
    return;
  }
  instance?.control.keys.add(e.code);
  if (store.interactive) {
    const gameKeys = ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyC', 'KeyM', 'KeyN', 'KeyB'];
    if (gameKeys.includes(e.code)) e.preventDefault();
  }
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
  if (renderer?.uiOverlay) {
    return; // a full-screen GL UI (multiplayer lobby) handles the pointer
  }
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

/**
 * Immersive sessions hide the page DOM (menus, HUD, score), so menus take over
 * with the split view: pausing ends the session, resuming or starting a match
 * opens a new one. Both happen inside a user gesture, as requestSession needs.
 */
/** Leave VR and go back to the menus: ends the session, drops the head-look
 *  offsets and clears the flag, so the screens that follow behave exactly
 *  like they do outside VR (no stuck, tilted camera). */
function exitVr(): void {
  if (!store.vr && !renderer?.xrActive) return;
  leaveXr();
  setVr(false);
  if (renderer) {
    renderer.camera.vrYaw = 0;
    renderer.camera.vrPitch = 0;
  }
}

function tryImmersive(): void {
  if (!renderer || !instance) return;
  if (!store.vr || !store.interactive || store.paused || renderer.xrActive) return;
  void enterXr(renderer, () => instance, () => undefined);
}
watch(() => store.paused, (p) => {
  if (!renderer || !store.vr) return;
  if (!store.interactive) return;
  // There is no separate VR pause menu: the pause panel belongs to the new
  // (DOM) HUD. Ending the immersive session makes it reachable; VR mode stays
  // on and resuming re-enters the session, exactly like the menus do.
  if (p) leaveXr(true);
  else tryImmersive();
});
watch(() => store.interactive, (on) => {
  if (!renderer) return;
  if (on) {
    if (store.vr && !store.paused) tryImmersive();
  } else {
    // The match is over (or the player left): VR ends with it.
    exitVr();
  }
});

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
      // The context was restored: the engine dropped its GPU caches, but the
      // ResourceCenter still hands out ModelData/TexEntry wrappers around the
      // *lost* context's objects, and the boot wheel scene holds its own. Drop
      // both and stop drawing until the async rebuild has re-uploaded
      // everything (drawing the old instance meanwhile spams GL errors).
      rc?.clearCaches();
      engineScene = null;
      if (instance instanceof NetGame) instance.dispose();
      instance = null;
      (window as unknown as { __ieGame?: GameInstance | null }).__ieGame = null;
      building = '';
      void rebuild();
    };
    // Boot wordmarks are text in Airstrike: start the face before the heavy
    // assets (index.html also preloads it) so the first screens use it.
    void loadWordmarkFont();
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
      // Zoom blur from the ship's velocity: radius = speed fraction, centre =
      // the screen point its velocity vector projects to (the vanishing point
      // of the flight path). Falls back to the screen centre.
      renderer.renderOptions.zoom = 0;
      renderer.renderOptions.zoomCenterX = 0.5;
      renderer.renderOptions.zoomCenterY = 0.5;
      if (instance) {
        const sel = instance.selectedObject;
        if (sel) {
          const speed = Math.hypot(sel.vel[0], sel.vel[1], sel.vel[2]);
          const cap = Math.max(1e-3, sel.physics.velMax * Math.max(1, sel.multiplier));
          const f = Math.min(1.2, speed / cap);
          if (f > 0.02 && speed > 1e-3) {
            renderer.renderOptions.zoom = rc.options.zoomBlur ? f * ZOOM_BLUR.maxRadiusUV : 0;
            const cam = renderer.camera;
            const p = instance.project(
              cam.position[0] + (sel.vel[0] / speed) * 1000,
              cam.position[1] + (sel.vel[1] / speed) * 1000,
              cam.position[2] + (sel.vel[2] / speed) * 1000,
            );
            renderer.renderOptions.zoomCenterX = p.x / Math.max(1, instance.canvasW);
            renderer.renderOptions.zoomCenterY = p.y / Math.max(1, instance.canvasH);
          }
        }
      }
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
        // The boot wheel has no sky sphere: clear the sky target so the
        // composite shows black behind it rather than whatever the last scene
        // left there, then keep drawing into the scene target.
        renderer.post.beginSky();
        renderer.gl.clearColor(0, 0, 0, 1);
        renderer.gl.clear(renderer.gl.COLOR_BUFFER_BIT);
        renderer.post.bindScene();
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
      // Stereo VR (no WebXR headset): two eyes side by side. Each half is a
      // full render with the camera shifted along its right axis, which is
      // what makes the depth read in a phone viewer.
      if (store.vr && !renderer.xrActive) {
        instance.canvasW = canvasRef.value?.clientWidth || 1280;
        instance.canvasH = canvasRef.value?.clientHeight || 720;
        // While paused only the simulation stops; the eyes keep drawing so the
        // background, the world and the HUD stay visible in the headset.
        if (!store.paused) instance.update(dtMs);
        // Stereo VR draws with the same far view distance as the settings.
        renderer.camera.far = store.options.distance;
        const gl = renderer.gl;
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        const half = Math.floor(w / 2);
        const fullW = canvasRef.value?.clientWidth || 1280;
        const fullH = canvasRef.value?.clientHeight || 720;
        const eyeCssW = fullW / 2;
        const ipd = 0.25;                       // world units between the eyes
        const cam = renderer.camera;
        const base: [number, number, number] = [cam.position[0], cam.position[1], cam.position[2]];
        const side: [number, number, number] = [cam.side[0], cam.side[1], cam.side[2]];
        const finite = (v: number[]): boolean => v.every((n) => Number.isFinite(n));
        const offset = finite(side) && finite(base) ? ipd : 0;   // never offset into NaN
        for (let eye = 0; eye < 2; eye++) {
          const sign = eye === 0 ? -1 : 1;
          cam.position[0] = base[0] + side[0] * offset * sign;
          cam.position[1] = base[1] + side[1] * offset * sign;
          cam.position[2] = base[2] + side[2] * offset * sign;
          cam.updateMatrices();
          renderer.viewport = { x: eye * half, y: 0, w: half, h };
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(eye * half, 0, half, h);
          gl.clearColor(0, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          renderer.beginFrame();
          instance.draw();
          // Per-eye HUD: markers/aim projected with this eye's camera into
          // the eye's own rect, so both eyes show the UI at the same relative
          // position instead of a squeezed full-screen copy each.
          instance.canvasW = eyeCssW;
          instance.canvasH = fullH;
          syncHud(instance);
          renderer.endFrame(null);
          if (renderer.renderOptions.zoom > 0) {
            instance.drawShipsSharp(null, { x: eye * half, y: 0, w: half, h });
          }
          // HUD last, straight into this eye's rectangle: score, clock,
          // respawn timer, aim, life, markers - one copy per eye.
          renderer.drawHudTo(null, { x: eye * half, y: 0, w: half, h }, uiHud());
          gl.disable(gl.SCISSOR_TEST);
        }
        renderer.viewport = null;
        cam.position[0] = base[0];
        cam.position[1] = base[1];
        cam.position[2] = base[2];
        cam.updateMatrices();
        instance.canvasW = fullW;
        instance.canvasH = fullH;
        syncHud(instance);
        return;
      }
      if (renderer.xrActive) {
        // The XR session loop owns simulation and drawing (see game/xr.ts);
        // head tracking comes from the pose, so drop the gyro look here.
        renderer.camera.vrYaw = 0;
        renderer.camera.vrPitch = 0;
        return;
      }
      if (store.paused) {
        // Paused: the world stands still but the frame keeps drawing, so the
        // pause panel can show live option changes behind it.
        instance.canvasW = canvasRef.value?.clientWidth || 1280;
        instance.canvasH = canvasRef.value?.clientHeight || 720;
        renderer.beginFrame();
        instance.draw();
        renderer.endFrame(uiHud());
        syncHud(instance);
        return;
      }
      if (instance.control.pauseRequested) {
        instance.control.pauseRequested = false;
        store.paused = !store.paused;
      }
      // VR: gyroscope drives the view, gamepad drives the ship.
      const look = store.vr ? vrLook() : { yaw: 0, pitch: 0, tracking: false };
      renderer.camera.vrYaw = look.tracking ? look.yaw : 0;
      renderer.camera.vrPitch = look.tracking ? look.pitch : 0;
      mp.preTick(dtMs);
      instance.update(dtMs);
      mp.postTick(dtMs);
      renderer.beginFrame();
      instance.draw();
      renderer.endFrame(null);
      if (renderer.renderOptions.zoom > 0) instance.drawShipsSharp();
      // HUD on top of everything, in its own padded layer (16px from the
      // border, baked into the overlay canvas).
      renderer.drawHudTo(null, { x: 0, y: 0, w: renderer.gl.drawingBufferWidth, h: renderer.gl.drawingBufferHeight }, uiHud());
      // After zoom blur: the ships are drawn sharp on top of the blurred view.
      if (renderer.renderOptions.zoom > 0) instance.drawShipsSharp();
      // After all movements of the frame: publish the HUD snapshot the DOM
      // overlay renders from.
      syncHud(instance);
      if (instance.result && store.route === 'game') {
        const lv = store.levelKey;
        const won = instance.result.won;
        // A finished match must not leave a head-tracked camera over the
        // result screens: leave VR, then hand over to the menu route.
        exitVr();
        store.result = { ...instance.result, level: lv };
        instance.result = null;
        // Replace: a finished match must not stay in the stack, or back
        // from the result screen would re-enter the game.
        void router.replace((won ? '/victory/' : '/defeat/') + lv);
      }
    };
    void rebuild();
    renderer.start();
    sceneTimer = window.setInterval(() => {
      void rebuild();
      // The far plane follows the settings' draw distance unconditionally
      // (the old check only synced when the two mirrors disagreed, so a
      // restored session could keep the 192 default forever).
      if (renderer) renderer.camera.far = store.options.distance;
    }, 300);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onVrDown, true);
    window.addEventListener('pointerup', onVrUp, true);
    window.addEventListener('pointermove', onVrMove, true);
    window.addEventListener('pointercancel', onVrUp, true);
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
  mp.endSession();
  if (instance instanceof NetGame) instance.dispose();
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
