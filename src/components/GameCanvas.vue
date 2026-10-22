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
import { attachWallet } from '../game/wallet';
import { RC } from '../game/resources';
import { loadLevel } from '../game/levels';
import { ensureManifests, warmManifests } from '../game/assetmanifest';
import { store, syncOptionsFromRC } from '../game/store';
import { applyTeamColors } from '../game/colors';
import { partyPlayerColor, updateParty } from '../game/party';
import { cssColor, readableAccent } from '../game/ui/theme';
import { calibrateVr, dragLook, isVrLongPress, vrLook, VR_LONG_PRESS_MS } from '../game/vr';
import { enterXr, setXrMatchEndHandler } from '../game/xr';
import { takeMatchResult } from '../game/matchresult';
import { syncHud } from '../game/hud';
import { HUD_PADDING } from '../engine/hud3d';
import { audio } from '../game/audio';
import { loadWordmarkFont } from '../game/fonts';
import { PauseMenuUi } from '../game/ui/pauseui';
import { goBack } from '../game/nav';
import { allowGameExit } from '../router';
import { markInternalBack } from '../game/backguard';

const canvasRef = ref<HTMLCanvasElement | null>(null);
const glError = ref('');
const router = useRouter();

let renderer: Renderer | null = null;
let rc: RC | null = null;
let instance: GameInstance | null = null;
let pauseMenu: PauseMenuUi | null = null;
let building = '';
let buildGen = 0;
let sceneTimer = 0;
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
  const token = key + '|' + store.options.billboards + '|' + store.sceneEpoch;
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
    let hostIntent: ReturnType<typeof mp.consumeHostIntent> = null;
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
      hostIntent = store.route === 'game' ? mp.consumeHostIntent() : null;
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
    }
    // Colour preferences are presentation-only: apply them before a browser
    // host publishes its Scene so guests inherit the host's chosen colours.
    updateParty(store.options, 16);
    applyTeamColors(gi, store.options, partyPlayerColor(store.options));
    // A room this browser created and is now opening: become its host.
    if (!(gi instanceof NetGame) && hostIntent) mp.attachHost(gi);
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
  resetVrPress();
}

function onVisibilityChange(): void {
  if (document.hidden) {
    clearHeldInputs();
    resetVrPress();
  }
}

/** In VR a tap on the scene re-centres the view on the current heading. */
/** Stage 5 gets the live HUD in matches. While paused the pause menu is the
 *  only overlay: score, life, markers and touch controls stay disabled until
 *  the player resumes. */
function uiHud(): typeof store.hud | null {
  return instance && instance.gameType !== 'BACK' && !store.paused ? store.hud : null;
}

/**
 * The HUD's painting island: everything inside the same 64px padding the HUD
 * painter uses. The post-process blurs/tints only the border outside it, with
 * zero blur at the rectangle edge. Coordinates are normalized per view.
 */
function setHudFocus(cssW: number, cssH: number): void {
  if (!renderer) return;
  const w = Math.max(1, cssW), h = Math.max(1, cssH);
  const px = Math.min(0.45, HUD_PADDING / w);
  const py = Math.min(0.45, HUD_PADDING / h);
  renderer.focusRect = { x: px, y: py, w: Math.max(0.1, 1 - px * 2), h: Math.max(0.1, 1 - py * 2) };
}

/** The player's chosen colour, remembered across result/menu routes. */
let lastAccentCss = '';
function syncAccentCss(color: readonly [number, number, number]): void {
  const accent = cssColor(color);
  const text = cssColor(readableAccent([color[0], color[1], color[2]]));
  const key = accent + '|' + text;
  if (key === lastAccentCss) return;
  lastAccentCss = key;
  const root = document.documentElement.style;
  root.setProperty('--accent', accent);
  root.setProperty('--accent-text', text);
  root.setProperty('--accent-soft', cssColor(color, 0.35));
}

function syncFocusTint(): void {
  if (!renderer) return;
  const color = instance?.selectedObject?.team?.color
    ?? partyPlayerColor(store.options);
  renderer.focusTint[0] = color[0];
  renderer.focusTint[1] = color[1];
  renderer.focusTint[2] = color[2];
  // DOM chrome (corner/back and fullscreen buttons, timer bars, native inputs)
  // follows the same player colour as the GL menus and HUD.
  syncAccentCss(color);
}

function onVrTap(): void {
  if (store.vr) calibrateVr();
}

/**
 * VR fallback: dragging across the scene looks around (touch or mouse).
 * Holding still for VR_LONG_PRESS_MS in a live match pauses instead. The pause
 * menu is the same WebGL ScreenUi panel as every other menu, so an immersive
 * session can stay live while it is open.
 */
let dragging = false;
let lastX = 0;
let lastY = 0;
let vrPressId: number | null = null;
let vrPressX = 0;
let vrPressY = 0;
let vrPressStarted = 0;
let vrPressMoved = false;
let vrLongPress = false;
let vrPressTimer = 0;
/** Movement (CSS px) that makes the press a drag instead of a tap/hold. */
const VR_TAP_SLOP = 10;
const VR_CONTROL_SELECTOR = '.stick-back, .stick-knob, .accel-knob, .accel-bar, .tbtn, button';

function clearVrPressTimer(): void {
  if (vrPressTimer) {
    window.clearTimeout(vrPressTimer);
    vrPressTimer = 0;
  }
}

/** Drop the in-flight press without calibrating (cancel/blur/unmount). */
function resetVrPress(): void {
  clearVrPressTimer();
  vrPressId = null;
  vrPressMoved = false;
  vrLongPress = false;
  dragging = false;
}

function onVrDown(e: PointerEvent): void {
  if (!store.vr || store.paused) return;
  // Controls keep their own drags (stick, accel knob, HUD buttons); anywhere
  // else on the scene the drag looks around.
  const t = e.target as HTMLElement | null;
  if (t && t.closest && t.closest(VR_CONTROL_SELECTOR)) return;
  // One press owns the long-press timer: a second finger cannot add another.
  if (vrPressId !== null) return;
  vrPressId = e.pointerId;
  vrPressX = e.clientX;
  vrPressY = e.clientY;
  vrPressStarted = performance.now();
  vrPressMoved = false;
  vrLongPress = false;
  // Drag-look starts immediately so normal drags stay responsive; moving past
  // the tap slop below cancels the long-press timer.
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  if (!store.interactive || store.paused) return;
  vrPressTimer = window.setTimeout(() => {
    vrPressTimer = 0;
    if (vrPressId !== e.pointerId || vrPressMoved || vrLongPress) return;
    if (!isVrLongPress(performance.now() - vrPressStarted)) return;
    if (!store.vr || !store.interactive || store.paused) return;
    vrLongPress = true;
    // The hold is the pause gesture: stop looking and do not re-centre on
    // release. store.paused opens the WebGL pause menu.
    dragging = false;
    store.paused = true;
  }, VR_LONG_PRESS_MS);
}

function onVrMove(e: PointerEvent): void {
  if (!store.vr || store.paused || !dragging || e.pointerId !== vrPressId) return;
  if (!vrLongPress) {
    const dx = e.clientX - vrPressX;
    const dy = e.clientY - vrPressY;
    if (dx * dx + dy * dy > VR_TAP_SLOP * VR_TAP_SLOP) {
      // A real drag must not pause when it happens to last past the threshold.
      vrPressMoved = true;
      clearVrPressTimer();
    }
  }
  dragLook(e.clientX - lastX, e.clientY - lastY);
  lastX = e.clientX;
  lastY = e.clientY;
}

function onVrUp(e: PointerEvent): void {
  if (vrPressId === null || e.pointerId !== vrPressId) return;
  if (store.paused) {
    resetVrPress();
    return;
  }
  // A short, stationary press is still the tap that re-centres the view; a
  // long press already paused, so its release must do nothing else.
  const tap = e.type === 'pointerup' && !vrLongPress && !vrPressMoved;
  resetVrPress();
  if (tap && store.vr) calibrateVr();
}

function onKeyDown(e: KeyboardEvent): void {
  audio.unlock();
  // The pause screen owns its keys (Esc resumes, options edit text, Enter
  // activates the primary action) and must not leak them into the flight
  // controls or the history.
  if (store.paused) {
    if (pauseMenu?.key(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    } else if (e.code === 'Backspace') {
      // Backspace must not fall through to browser history while paused.
      e.preventDefault();
    }
    return;
  }
  if (e.code === 'Backspace' && (e.target as HTMLElement)?.tagName !== 'INPUT') {
    if (store.interactive) {
      // In a match, the browser back key is the pause/back gesture, just like
      // Escape and the on-screen back button. Leaving is an explicit action in
      // the pause menu.
      e.preventDefault();
      store.paused = true;
      return;
    }
    markInternalBack();
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

/** A controller/system back must not silently close a live match. */
function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (store.interactive && !store.paused) {
    e.preventDefault();
    e.returnValue = '';
  }
}

function canvasPos(e: PointerEvent): { x: number; y: number } {
  const r = (e.target as HTMLElement).getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/** Feed a pointer event to the WebGL pause screen (canvas CSS coordinates). */
function pausePointer(kind: 'move' | 'down' | 'up', e: PointerEvent): boolean {
  if (!store.paused || !pauseMenu || !canvasRef.value) return false;
  const r = canvasRef.value.getBoundingClientRect();
  pauseMenu.ui.pointer(kind, e.clientX - r.left, e.clientY - r.top, r.width, r.height);
  return true;
}

function onPointerDown(e: PointerEvent): void {
  audio.unlock();
  rc?.startMusic();
  if (store.paused) {
    if (pausePointer('down', e)) {
      canvasRef.value?.setPointerCapture?.(e.pointerId);
    }
    return;
  }
  if (!instance || !canvasRef.value) return;
  const p = canvasPos(e);
  if (renderer?.uiOverlay) {
    return; // a full-screen GL UI (multiplayer lobby) handles the pointer
  }
  if (instance.gameType === 'BACK') {
    return; // menus: the UI handles pointer input; the backdrop does not move
  }
  instance.control.touches.set(e.pointerId, p);
  (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
}

function onPointerMove(e: PointerEvent): void {
  if (store.paused) {
    pausePointer('move', e);
    return;
  }
  if (!instance || !renderer) return;
  const p = canvasPos(e);
  if (instance.control.touches.has(e.pointerId)) {
    instance.control.touches.set(e.pointerId, p);
  }
}

function onPointerUp(e: PointerEvent): void {
  if (pausePointer('up', e)) {
    instance?.control.touches.delete(e.pointerId);
    return;
  }
  instance?.control.touches.delete(e.pointerId);
}

/**
 * Consume a finished match exactly once and hand over to the result route.
 * The page loop and the WebXR session loop can both observe the finish, so the
 * shared takeMatchResult clears `instance.result` before navigating.
 *
 * VR deliberately survives the hand-over: the routed result screen is another
 * ScreenUi, so the XR loop draws it on the same world-space panel as every
 * other menu. Leaving the headset is the player's decision (the VR toggle or
 * taking the headset off), never a side effect of the match ending.
 */
function finishMatch(): boolean {
  const result = takeMatchResult(instance, store.route, store.levelKey);
  if (!result) return false;
  // A guest whose match link dropped reconnects to the host instead of taking
  // the 'Connection lost' defeat: the host's match is frozen waiting for us.
  if (!result.won && result.message === 'Connection lost' && mp.guestSession && !mp.hosting) {
    store.netPaused = true;
    store.netPausedBy = '';
    store.netPausedHost = false;
    void mp.reconnectMatch().then((ok) => {
      if (ok) {
        store.netPaused = false;
      } else {
        store.result = result;
        void router.replace('/defeat/' + result.level);
      }
    });
    return true;
  }
  store.result = result;
  // Matching no longer pays an in-game reward: the economy is the player's own
  // Lightning wallet (NIP-47). The host still settles a room's bet after the
  // match (see below).
  // The host settles the room's bet after the match (winners/losers by team; a
  // draw or missing result voids it). Guests never settle; with no escrow each
  // losing client pays the winners in sats over Lightning.
  if (mp.hosting && mp.sessionActive) {
    void mp.settleBet(result);
  }
  // Replace: a finished match must not stay in the stack, or back from the
  // result screen would re-enter the game.
  const target = result.draw ? '/draw/' : result.won ? '/victory/' : '/defeat/';
  void router.replace(target + result.level);
  return true;
}

function tryImmersive(): void {
  if (!renderer || !instance) return;
  if (!store.vr || !store.interactive || store.paused || renderer.xrActive) return;
  void enterXr(renderer, () => instance, () => undefined);
}

/** Leave the match from the WebGL pause menu. */
function leaveMatch(): void {
  store.paused = false;
  closePauseMenu();
  allowGameExit();
  goBack(router, '/briefing/' + String(store.levelKey));
}

function openPauseMenu(): void {
  if (!renderer) return;
  // Do not let a held key/touch from the moment of pausing keep firing or
  // thrusting when the match resumes. Drop a queued START edge too: it must
  // not immediately toggle the newly opened pause menu shut.
  clearHeldInputs();
  if (instance) instance.control.pauseRequested = false;
  if (!pauseMenu) {
    pauseMenu = new PauseMenuUi({
      resume: () => { store.paused = false; },
      leave: leaveMatch,
    });
  }
  pauseMenu.open();
  renderer.uiOverlay = pauseMenu.ui;
  // The pause screen supplies its own full-plane focus rectangle; a HUD inset
  // from the live match must not win.
  renderer.focusRect = null;
}

function closePauseMenu(): void {
  if (!pauseMenu) return;
  const menu = pauseMenu;
  menu.close();
  if (renderer?.uiOverlay === menu.ui) renderer.uiOverlay = null;
}

/** The simulation is frozen while paused, so poll the pad separately: START
 *  must still be able to resume from either flat or split-view VR. */
function pollPausedGamepad(): void {
  if (!instance) return;
  instance.control.update(instance.canvasW, instance.canvasH);
  if (!instance.control.pauseRequested) return;
  instance.control.pauseRequested = false;
  store.paused = false;
}

watch(() => store.paused, (p) => {
  if (!renderer) return;
  if (p && store.interactive) openPauseMenu();
  else closePauseMenu();
  // A real immersive session stays alive while paused: the pause menu is the
  // same world-space ScreenUi panel as every other menu. On resume, retry
  // immersive entry when VR mode is on but no headset session is open yet.
  if (store.vr && store.interactive && !p) tryImmersive();
});
watch(() => store.interactive, (on) => {
  if (!renderer) return;
  if (!on) {
    // Leaving the match (browser back, result route) must not leave the pause
    // overlay attached to a menu screen.
    closePauseMenu();
    if (store.paused) store.paused = false;
    return;
  }
  // Entering a match from a VR menu opens the session. Leaving a match (the
  // result screen or any menu route) keeps it alive: those screens are drawn
  // by the same XR UI panel, so VR only ends on an explicit toggle or when the
  // headset ends the session.
  if (store.vr && !store.paused) tryImmersive();
});

onMounted(() => {
  try {
    if (!canvasRef.value) return;
    renderer = new Renderer(canvasRef.value);
    rc = new RC(renderer);
    // The XR session loop owns simulation while a headset is active; let it
    // hand a finished match back to this page so the result route can run.
    setXrMatchEndHandler(finishMatch);
    // Network pause: mirror the manager's state into the reactive store so the
    // HUD overlay and the frame loop can react to it.
    const syncNetPause = (): void => {
      store.netPaused = mp.netPaused;
      store.netPausedBy = mp.netPausedBy;
      store.netPausedHost = !!mp.hosting;
    };
    mp.onNetPause = syncNetPause;
    syncNetPause();
    warmManifests();
    syncOptionsFromRC(rc.options);
    audio.setMusicVolume(rc.options.musicVolume);
    // Wallet: mirror the Lightning balance and connection state into the store
    // (the HANGAR/SHOP/navbar read it). A no-op until a NWC wallet is linked.
    const wallet = attachWallet(() => {
      store.sats = wallet.balanceSats;
      store.walletConnected = wallet.connected;
      store.walletStatus = wallet.statusText;
    });
    store.sats = wallet.balanceSats;
    store.walletConnected = wallet.connected;
    store.walletStatus = wallet.statusText;
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
      // Result observed on the previous frame (or by the XR session loop):
      // hand over before drawing another match frame.
      if (finishMatch()) return;
      // Music rhythm drives party colours; update before teams are recoloured.
      updateParty(rc.options, dtMs);
      // Menus/lobby/room follow that live hue too (repainting only when it
      // actually moved, at a modest rate).
      renderer.uiOverlay?.syncAccent?.(performance.now());
      // Colour options apply live to the current instance (including paused
      // frames, menu backgrounds and NetGame's late-arriving player ship).
      applyTeamColors(instance, store.options, partyPlayerColor(rc.options));
      // The focus veil follows the live ship's team colour; menus keep the
      // chosen player colour and use their ScreenUi rectangle instead of a HUD
      // inset.
      syncFocusTint();
      if (!store.interactive) renderer.focusRect = null;
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
      // Gyroscope look for the non-XR VR paths (the split view below and the
      // normal frame). The XR session supplies its own head pose.
      const look = store.vr ? vrLook() : { yaw: 0, pitch: 0, roll: 0, tracking: false };
      renderer.camera.vrYaw = look.tracking ? look.yaw : 0;
      renderer.camera.vrPitch = look.tracking ? look.pitch : 0;
      renderer.camera.vrRoll = look.tracking ? look.roll : 0;
      // The gamepad START button toggles pause and can also resume it, in the
      // flat view and in the split-view VR fallback.
      if (instance.control.pauseRequested) {
        instance.control.pauseRequested = false;
        store.paused = !store.paused;
      }
      // Stereo VR (no WebXR headset): two eyes side by side. Each half is a
      // full render with the camera shifted along its right axis, which is
      // what makes the depth read in a phone viewer.
      if (store.vr && !renderer.xrActive) {
        instance.canvasW = canvasRef.value?.clientWidth || 1280;
        instance.canvasH = canvasRef.value?.clientHeight || 720;
        // While paused only the simulation stops; the eyes keep drawing the
        // frozen world, while the pause menu takes over the UI layer. The HUD
        // returns only after the player resumes.
        if (store.paused) pollPausedGamepad();
        if (!store.paused && !mp.netPaused) instance.update(dtMs);
        // The match can finish in this update; leave VR and show the result
        // menu instead of drawing and looping on a frozen final frame.
        if (finishMatch()) return;
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
          // In a live match the HUD owns the eye's padded inset. A paused
          // match, like the menus, leaves the whole screen to the ScreenUi
          // rectangle instead.
          const liveGame = store.interactive && !store.paused;
          if (liveGame) setHudFocus(eyeCssW, fullH);
          else renderer.focusRect = null;
          // No focus stroke in the live game: only menus keep the border.
          renderer.focusBorderEnabled = !liveGame;
          renderer.suppressUiFocusFallback = false;
          renderer.endFrame(null);
          if (renderer.renderOptions.zoom > 0) {
            instance.drawShipsSharp(null, { x: eye * half, y: 0, w: half, h });
          }
          // HUD last, straight into this eye's rectangle: score, clock,
          // respawn timer, aim, life, markers - one copy per eye.
          renderer.drawHudTo(null, { x: eye * half, y: 0, w: half, h }, uiHud());
          // The composite paints the frame under the UI; repaint its inside
          // strips after the HUD/screen overlay so an opaque HUD or menu pixel
          // cannot hide it in the split-screen VR path either.
          renderer.drawFocusBorder(null, { x: eye * half, y: 0, w: half, h });
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
        renderer.camera.vrRoll = 0;
        return;
      }
      if (store.paused) {
        // Paused: the world stands still but the frame keeps drawing, so the
        // WebGL pause menu sits over the frozen match. Only the ScreenUi
        // overlay is drawn - no HUD, life, markers or touch controls.
        instance.canvasW = canvasRef.value?.clientWidth || 1280;
        instance.canvasH = canvasRef.value?.clientHeight || 720;
        pollPausedGamepad();
        renderer.focusRect = null;
        renderer.focusBorderEnabled = true;
        renderer.suppressUiFocusFallback = false;
        renderer.beginFrame();
        instance.draw();
        renderer.endFrame(null);
        return;
      }
      if (!mp.netPaused) { mp.preTick(dtMs); instance.update(dtMs); }
      // Stream frames even while the match is frozen, so every client keeps
      // showing the last state and the pause message stays in sync.
      mp.postTick(dtMs);
      // Same-frame result: do not draw another frame before the route changes.
      if (finishMatch()) return;
      if (store.interactive) setHudFocus(instance.canvasW, instance.canvasH);
      else renderer.focusRect = null;
      renderer.focusBorderEnabled = true;
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
    };
    void rebuild();
    renderer.start();
    sceneTimer = window.setInterval(() => {
      // Safety net for the result hand-over: the frame loop normally consumes a
      // finished match, but a throttled/paused rAF must never leave the player
      // stuck on the frozen final frame until they touch the page.
      if (finishMatch()) return;
      void rebuild();
      // The far plane follows the settings' draw distance unconditionally
      // (the old check only synced when the two mirrors disagreed, so a
      // restored session could keep the 192 default forever).
      if (renderer) renderer.camera.far = store.options.distance;
    }, 300);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('beforeunload', onBeforeUnload);
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
  setXrMatchEndHandler(null);
  mp.onNetPause = null;
  window.clearInterval(sceneTimer);
  resetVrPress();
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('beforeunload', onBeforeUnload);
  window.removeEventListener('keyup', onKeyUp);
  window.removeEventListener('pointerdown', onVrDown, true);
  window.removeEventListener('pointerup', onVrUp, true);
  window.removeEventListener('pointermove', onVrMove, true);
  window.removeEventListener('pointercancel', onVrUp, true);
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
