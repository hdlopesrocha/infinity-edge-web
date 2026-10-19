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

    while (Date.now() - t0 < TIMEOUT) {
      // A reload/first paint can briefly destroy the evaluation context.
      const hash = await page.evaluate('location.hash').catch(() => null);
      if (hash) {
        if (hash !== last) {
          seq.push([hash, Date.now() - t0]);
          last = hash;
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
    // The screens keep their designed dwell: engine >= 3 s, start >= 1.5 s
    // (plus the 0.5 s fade), so they cannot flash past on a fast machine.
    if (entry.engine && engineAt !== null && startAt !== null) {
      check(entry, 'engine screen dwell >= 3 s', startAt - engineAt >= 2800, `${startAt - engineAt}ms`);
    }
    if (startAt !== null) {
      check(entry, 'start screen dwell >= 1.5 s', menuAt - startAt >= 1600, `${menuAt - startAt}ms`);
    }

    // The hash alone is not enough: the menu must be painted into the WebGL
    // frame (and be the main menu, not a blank screen).
    const painted = await page.evaluate(`(async () => {
      for (let i = 0; i < 120; i++) {
        const r = window.__ieRenderer;
        const ui = r && r.uiOverlay;
        if (window.__ieStore && window.__ieStore.route === 'menu' && ui &&
            ui.regions.some((x) => x.id === '/multiplayer') &&
            ui.regions.some((x) => x.id === '/single-player')) {
          return {
            route: window.__ieStore.route,
            scene: window.__ieStore.sceneKey,
            title: ui.screen ? ui.screen.title : null,
            regions: ui.regions.length,
          };
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    })()`).catch(() => null);
    check(entry, 'main menu painted', !!painted && painted.title === 'MAIN MENU', painted);
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
