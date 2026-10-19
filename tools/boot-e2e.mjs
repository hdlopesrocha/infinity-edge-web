// Boot-sequence e2e: every entry URL must reach the main menu on its own.
//
// The boot screens are transient (engine 3 s -> start 1.5 s -> menu). The
// routed view is remounted for each navigation, so an entry at /#/start used
// to sit there forever when the preload had already finished; this run pins
// both the deep links and the full root sequence, and checks that the menu is
// actually painted (WebGL overlay), not just that the hash changed.
//
//   npm run build && npm run server:run     # or any static server on :8091
//   npm run boot:e2e
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openPage, launchChrome, sleep } from './cdp.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const APP = flag('--url', 'http://127.0.0.1:8091/');
const PORT = Number(flag('--port', '9361'));
const TIMEOUT = Number(flag('--timeout', '25000'));
const SHOTS = process.env.MP_E2E_SHOTS || '/tmp/opencode/shots';
mkdirSync(SHOTS, { recursive: true });

/** Entrance, whether the start screen must appear, and its dwell expectations. */
const ENTRIES = [
  { path: '', name: 'root', chain: true, engine: true },
  { path: '#/engine', name: 'engine deep link', chain: true, engine: true },
  { path: '#/start', name: 'start deep link', chain: false, engine: false },
];

const failures = [];
function check(entry, what, ok, extra) {
  const label = `${entry.name}: ${what}`;
  if (ok) {
    console.log(`· ${label}`, extra ?? true);
  } else {
    console.log(`✗ ${label}`, extra ?? '');
    failures.push(label);
  }
}

const { chrome } = await launchChrome({ port: PORT, profilePrefix: 'ie-boot-e2e' });

try {
  for (const entry of ENTRIES) {
    const page = await openPage(PORT, APP + entry.path);
    const t0 = Date.now();
    const seq = [];
    let startAt = null;
    let engineAt = null;
    let menuAt = null;
    let last = '';
    let fsEngine = false;
    let fsStart = false;

    /** The WebGL chrome must offer fullscreen on every boot screen too. */
    const fsVisible = async () => page.evaluate(`(async () => {
      for (let i = 0; i < 20; i++) {
        const r = window.__ieRenderer;
        if (r) r.onFrame(16);
        if (r && r.uiOverlay && r.uiOverlay.regions.some((x) => x.id === 'fs')) return true;
        await new Promise((res) => setTimeout(res, 40));
      }
      return false;
    })()`).catch(() => false);

    while (Date.now() - t0 < TIMEOUT) {
      // A reload/first paint can briefly destroy the evaluation context.
      const hash = await page.evaluate('location.hash').catch(() => null);
      if (hash) {
        if (hash !== last) {
          seq.push([hash, Date.now() - t0]);
          last = hash;
          if (hash === '#/engine') fsEngine = await fsVisible();
          if (hash === '#/start') fsStart = await fsVisible();
        }
        if (hash === '#/engine' && engineAt === null) engineAt = Date.now() - t0;
        if (hash === '#/start' && startAt === null) startAt = Date.now() - t0;
        if (hash === '#/menu') {
          menuAt = Date.now() - t0;
          break;
        }
      }
      await sleep(120);
    }

    const timing = seq.map(([h, t]) => `${h}@${t}ms`).join(' → ');
    check(entry, 'reached #/menu', menuAt !== null, timing);
    if (menuAt === null) {
      failures.push(entry.name + ': still at ' + (last || 'an unknown page'));
      continue;
    }
    check(entry, 'start screen in the chain', !entry.chain || startAt !== null, entry.chain ? undefined : 'not applicable');
    check(entry, 'fullscreen button on the start screen', fsStart);
    if (entry.engine) check(entry, 'fullscreen button on the engine screen', fsEngine);
    // The screens keep their designed dwell: engine >= 3 s, start >= 1.5 s
    // (plus the 0.5 s fade), so they cannot flash past on a fast machine.
    if (entry.engine && engineAt !== null && startAt !== null) {
      check(entry, 'engine screen dwell >= 3 s', startAt - engineAt >= 2800, `${startAt - engineAt}ms`);
    }
    if (startAt !== null) {
      // The 1.5 s timer + 0.5 s fade starts when the view mounts; polling can
      // miss the first part of it while the page is still loading, so this
      // lower bound catches an immediate auto-advance without flaking.
      check(entry, 'start screen dwell (>= 1.5 s design)', menuAt - startAt >= 1200, `${menuAt - startAt}ms`);
    }

    // The hash alone is not enough: the menu must be painted into the WebGL
    // frame (and be the main menu, not a blank screen).
    const painted = await page.evaluate(`(async () => {
      for (let i = 0; i < 120; i++) {
        const r = window.__ieRenderer;
        const ui = r && r.uiOverlay;
        if (window.__ieStore && window.__ieStore.route === 'menu' && ui &&
            ui.regions.some((x) => x.id === '/multiplayer') &&
            ui.regions.some((x) => x.id === '/single-player') &&
            ui.regions.some((x) => x.id === 'fs')) {
          return {
            route: window.__ieStore.route,
            scene: window.__ieStore.sceneKey,
            title: ui.screen ? ui.screen.title : null,
            regions: ui.regions.length,
            font: !!(document.fonts && document.fonts.check('16px Airstrike')),
          };
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    })()`).catch(() => null);
    check(entry, 'main menu painted', !!painted && painted.title === 'MAIN MENU', painted);
    check(entry, 'Airstrike wordmark font loaded', !!painted && painted.font === true);

    // Priority loading: the floating-gear wheel is the first model fetched
    // (it is what the engine screen shows), and the font request happened.
    const order = await page.evaluate(`(() => {
      const entries = performance.getEntriesByType('resource');
      const isModel = (e) => e.name.includes('/assets/models/') && e.name.endsWith('.json') && !e.name.endsWith('/MANIFEST.json');
      const models = entries.filter(isModel).sort((a, b) => a.startTime - b.startTime);
      const font = entries.find((e) => e.name.includes('airstrike.ttf'));
      return {
        firstModel: models[0] ? models[0].name.split('/').pop() : null,
        fontLoaded: !!font,
        fontStart: font ? Math.round(font.startTime) : null,
        firstModelStart: models[0] ? Math.round(models[0].startTime) : null,
      };
    })()`);
    check(entry, 'wheel model loads before the rest', order.firstModel === 'Wheel.json', order);
    check(entry, 'font request was made', order.fontLoaded === true, order);
    await page.screenshot(join(SHOTS, `boot-${entry.path === '' ? 'root' : entry.path.slice(2)}.png`));
  }
} catch (e) {
  failures.push(String(e.message));
} finally {
  try { chrome.kill(); } catch { /* already gone */ }
  await sleep(150);
}

if (failures.length > 0) {
  console.error('\nboot-e2e: FAIL — ' + failures.join('; '));
  process.exitCode = 1;
} else {
  console.log('\nboot-e2e: PASS');
}
