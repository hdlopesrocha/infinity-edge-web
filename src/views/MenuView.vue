<!-- The WebGL menu host: every menu route renders through MenuUi (no DOM at
     all). This component only wires input, navigation and the per-screen side
     effects (boot timers, briefing loading, options rollback, music picker). -->
<script lang="ts">
import { defineComponent, onBeforeUnmount, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { Renderer } from '../engine/renderer';
import { MenuUi } from '../game/ui/menuui';
import type { MenuScreen } from '../game/ui/menuui';
import * as screens from '../game/ui/screens';
import { clearGameData, loadScores, saveOptions, store } from '../game/store';
import { loadLevel } from '../game/levels';
import { audio } from '../game/audio';
import { goBack } from '../game/nav';
import { trail } from '../game/trail';
import { pickMusicFile } from '../game/musicfile';
import { toggleFullscreen } from '../game/ui/fullscreen';
import { loadWordmarkFont } from '../game/fonts';
import { enableVr, setVr } from '../game/vr';
import { leaveXr } from '../game/xr';
import type { Options } from '../game/resources';

export default defineComponent({
  name: 'MenuView',
  setup() {
    const route = useRoute();
    const router = useRouter();
    let ui: MenuUi | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let briefingData: { text: string; rows: string[] } | null = null;
    let briefingLevel = '';
    let optionsSnapshot: Options | null = null;
    let optionsSaved = false;
    const timers: number[] = [];
    let minElapsed = false;

    function renderer(): Renderer | null {
      return (window as unknown as { __ieRenderer?: Renderer }).__ieRenderer ?? null;
    }

    /** Live-apply the options mirror to the running game (rc.options). */
    function applyOptionsLive(): void {
      const rc = (window as unknown as { __ieRC?: { options: Options } }).__ieRC;
      if (rc) Object.assign(rc.options, store.options);
      store.username = store.options.username;
      audio.setMusicVolume(store.options.musicVolume);
    }

    function crumbs(): { label: string; current: boolean }[] {
      const items = trail.items;
      if (items.length === 0) return [];
      return items.map((e, i) => ({ label: e.label || e.path, current: i === items.length - 1 }));
    }

    function toggleVr(): void {
      void (async () => {
        if (store.vr) {
          leaveXr();
          setVr(false);
        } else {
          const r = renderer();
          if (!r) return;
          await enableVr({
            renderer: r,
            getInstance: () => (window as unknown as { __ieGame?: import('../game/instance').GameInstance }).__ieGame ?? null,
            onEnd: () => undefined,
          });
        }
        rebuild();
      })();
    }

    function screenForRoute(): MenuScreen {
      const name = String(route.name ?? 'notfound');
      switch (name) {
        case 'boot':
        case 'engine':
        case 'start':
          return screens.bootScreen(name, store.loading.active ? { done: store.loading.done, total: store.loading.total } : null);
        case 'single': return screens.singlePlayer();
        case 'ctf': return screens.ctfMenu();
        case 'tt': return screens.timeTrialMenu();
        case 'kots': return screens.modeMenu('kots');
        case 'survival': return screens.modeMenu('surv');
        case 'tracks': return screens.tracksMenu(String(route.params.diff ?? 'easy'));
        case 'briefing': {
          if (briefingData && briefingLevel === String(route.params.level ?? '')) {
            return screens.briefingScreen(briefingLevel, briefingData.text, briefingData.rows);
          }
          return screens.briefingLoading();
        }
        case 'options':
        case 'settings':
          return screens.optionsMenu();
        case 'about': return screens.aboutMenu();
        case 'hangar': return screens.hangarMenu();
        case 'victory':
        case 'defeat': {
          const res = store.result;
          const medal = res && (res.reward === 'Gold' || res.reward === 'Silver' || res.reward === 'Bronze')
            ? `_${res.reward.toLowerCase()}.png`
            : null;
          return screens.resultMenu(name === 'victory', res?.message ?? null, medal);
        }
        case 'notfound': return screens.notFound();
        default: return screens.mainMenu();
      }
    }

    function rebuild(): void {
      if (!ui) return;
      ui.setScreen(screenForRoute());
      ui.setCrumbs(crumbs());
    }

    /** Repaint the chrome so the fullscreen icon reflects the real state. */
    function onFullscreenChange(): void {
      ui?.bump();
    }

    // ------------------------------------------------------------- handlers
    function select(id: string): void {
      audio.unlock();
      void audio.sfx('button');
      if (id === 'mode-toggle') {
        screens.toggleTeamsMode();
        rebuild();
        return;
      }
      if (id === 'start') {
        void router.push('/game/' + String(route.params.level ?? ''));
        return;
      }
      if (id === 'save') {
        if (store.options.username === '') store.options.username = 'Infinity Edge Fan';
        if (store.options.username === 'suckmyrocket') store.options.cheats = !store.options.cheats;
        optionsSaved = true;
        saveOptions(store.options);
        applyOptionsLive();
        goBack(router, '/menu');
        return;
      }
      if (id === 'clear') {
        clearGameData();
        return;
      }
      if (id === 'menu') {
        void router.push('/menu');
        return;
      }
      if (id === 'vr') {
        toggleVr();
        return;
      }
      if (id === 'music') {
        void (async () => {
          const picked = await pickMusicFile();
          if (!picked) return;
          await audio.useMusicFile(picked);
          rebuild();
        })();
        return;
      }
      if (id === 'music-reset') {
        void audio.useMusicFile(null).then(() => rebuild());
        return;
      }
      if (id === 'medal') {
        back();
        return;
      }
      if (id === 'fs') {
        void toggleFullscreen().finally(() => rebuild());
        return;
      }
      if (id.startsWith('/')) {
        void router.push(id);
      }
    }

    function change(id: string, value: number | boolean | string): void {
      const o = store.options;
      switch (id) {
        case 'username': o.username = String(value).slice(0, 12); break;
        case 'distance': o.distance = Math.round(Number(value)); break;
        case 'detail': o.detail = Math.round(Number(value)); break;
        case 'musicVolume':
          o.musicVolume = Number(value);
          audio.setMusicVolume(o.musicVolume);
          break;
        case 'billboards': o.billboards = Boolean(value); break;
        case 'zoomBlur': o.zoomBlur = Boolean(value); break;
        case 'showMs': o.showMs = Boolean(value); break;
        case 'axisX': o.axisX = Boolean(value); break;
        case 'axisY': o.axisY = Boolean(value); break;
        default: break;
      }
      applyOptionsLive();
      rebuild();
    }

    function back(): void {
      audio.unlock();
      void audio.sfx('button');
      goBack(router, '/menu');
    }

    function crumb(index: number): void {
      audio.unlock();
      void audio.sfx('button');
      const delta = trail.items.length - 1 - index;
      if (delta <= 0) return;
      if (trail.items[index].synth) void router.push(trail.items[index].path);
      else router.go(-delta);
    }

    // ---------------------------------------------------------- boot timers
    function scheduleBoot(): void {
      for (const t of timers) window.clearTimeout(t);
      timers.length = 0;
      const name = String(route.name ?? 'boot');
      minElapsed = false;
      audio.unlock();
      if (name === 'boot') {
        timers.push(window.setTimeout(() => void router.replace('/engine'), 60));
        return;
      }
      const minMs = name === 'engine' ? 3000 : 1500;
      timers.push(window.setTimeout(() => {
        minElapsed = true;
        tryAdvanceBoot();
      }, minMs));
      tryAdvanceBoot();
    }

    let fading = false;
    function tryAdvanceBoot(): void {
      const name = String(route.name ?? '');
      if (name !== 'engine' && name !== 'start') return;
      if (!minElapsed || store.loading.active || fading) return;
      fading = true;
      timers.push(window.setTimeout(() => {
        if (name === 'engine') {
          void audio.voice('welcome');
          void router.replace('/start');
        } else {
          void router.replace('/menu');
        }
      }, 500));
    }

    // ------------------------------------------------------------- briefing
    async function loadBriefing(levelKey: string): Promise<void> {
      briefingData = null;
      briefingLevel = levelKey;
      rebuild();
      try {
        const def = await loadLevel(levelKey);
        const text = def.menuText ?? def.description.text;
        const known = ['TT', 'CTF', 'KOTS', 'SURV'];
        const type = (known.includes(def.description.type) ? def.description.type : 'CTF') as
          'TT' | 'CTF' | 'KOTS' | 'SURV';
        const sb = def.scoreBoard ?? { type, save: def.description.save };
        const list = loadScores(type, sb.save);
        const rows: string[] = [];
        list.forEach((g) => rows.push(g.toVisual(type)));
        while (rows.length < 10) rows.push('');
        store.scoreboard = { title: 'High Scores', rows };
        briefingData = { text, rows };
      } catch {
        briefingData = null;
      }
      rebuild();
    }

    // -------------------------------------------------------------- options
    function enterOptions(): void {
      optionsSnapshot = { ...store.options };
      optionsSaved = false;
      applyOptionsLive();
    }

    function leaveOptions(): void {
      if (optionsSnapshot && !optionsSaved) {
        Object.assign(store.options, optionsSnapshot);
        applyOptionsLive();
      }
      optionsSnapshot = null;
      optionsSaved = false;
    }

    // ------------------------------------------------------------ lifecycle
    const nameOf = (): string => String(route.name ?? '');
    watch(
      () => route.fullPath,
      () => {
        const previous = nameOf();
        void previous;
        const name = nameOf();
        if (name === 'briefing') {
          const levelKey = String(route.params.level ?? '');
          if (levelKey !== briefingLevel) void loadBriefing(levelKey);
        } else if (briefingData || briefingLevel) {
          store.scoreboard = null;
          briefingData = null;
          briefingLevel = '';
        }
        if (name === 'options' || name === 'settings') enterOptions();
        else if (optionsSnapshot) leaveOptions();
        if (name === 'boot' || name === 'engine' || name === 'start') {
          fading = false;
          scheduleBoot();
        }
        rebuild();
      },
    );

    watch(
      () => ({ active: store.loading.active, done: store.loading.done, total: store.loading.total }),
      () => {
        if (nameOf() === 'engine' || nameOf() === 'start') tryAdvanceBoot();
        if (nameOf() === 'boot' || nameOf() === 'engine' || nameOf() === 'start') rebuild();
      },
    );

    const onMove = (e: PointerEvent): void => pointer('move', e);
    const onDown = (e: PointerEvent): void => pointer('down', e);
    const onUp = (e: PointerEvent): void => pointer('up', e);
    function pointer(kind: 'move' | 'down' | 'up', e: PointerEvent): void {
      const rect = canvasRect();
      if (!rect || !ui) return;
      if (kind === 'down') audio.unlock();
      ui.pointer(kind, e.clientX - rect.x, e.clientY - rect.y, rect.w, rect.h);
    }
    function canvasRect(): { x: number; y: number; w: number; h: number } | null {
      const c = canvas;
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: r.left, y: r.top, w: Math.max(1, r.width), h: Math.max(1, r.height) };
    }
    function onWheel(e: WheelEvent): void {
      if (!ui) return;
      if (ui.wheel(e.deltaY)) e.preventDefault();
    }
    function onKey(e: KeyboardEvent): void {
      if (!ui) return;
      if (ui.key(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }

    onMounted(() => {
      const r = renderer();
      canvas = r?.canvas ?? null;
      ui = new MenuUi(screenForRoute(), {
        onSelect: select,
        onChange: change,
        onBack: back,
        onPrimary: () => {
          const primary = screenForRoute().primary;
          if (primary) select(primary.id);
        },
        onCrumb: crumb,
      }, () => ui?.bump());
      if (r) {
        r.uiOverlay = ui;
        // Menus let the ScreenUi supply the content island; a rect left over
        // from a previous match must not override it.
        r.focusRect = null;
      }
      rebuild();
      void audio.refreshCustomMusic().then(() => rebuild());
      // The boot wordmarks are text now; repaint once the face is available.
      void loadWordmarkFont().then(() => rebuild());
      if (nameOf() === 'options') enterOptions();
      if (nameOf() === 'briefing') void loadBriefing(String(route.params.level ?? ''));
      // Boot screens advance on their own. The routed view is remounted on
      // every navigation (RouterView is keyed by fullPath), so this has to be
      // scheduled here too: arriving at /start from the engine screen means
      // the preload has already finished, and the old code then waited for a
      // timer that was never armed.
      if (nameOf() === 'boot' || nameOf() === 'engine' || nameOf() === 'start') scheduleBoot();
      else minElapsed = true;
      canvas?.addEventListener('pointermove', onMove);
      canvas?.addEventListener('pointerdown', onDown);
      window.addEventListener('pointerup', onUp);
      canvas?.addEventListener('wheel', onWheel, { passive: false });
      window.addEventListener('keydown', onKey, true);
      // External changes (F11, Esc) must update the icon too.
      document.addEventListener('fullscreenchange', onFullscreenChange);
    });

    onBeforeUnmount(() => {
      for (const t of timers) window.clearTimeout(t);
      timers.length = 0;
      leaveOptions();
      store.scoreboard = null;
      if (renderer()) renderer()!.uiOverlay = null;
      canvas?.removeEventListener('pointermove', onMove);
      canvas?.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      canvas?.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      ui = null;
    });

    // Renders nothing: the menu lives in the WebGL frame.
    return () => null;
  },
});
</script>
