// UI end-to-end with REAL mouse input (CDP Input domain): every click below is
// hit-tested by the browser exactly like a user's, which is what caught the
// DOM overlay swallowing menu clicks. Exercises the WebGL menus, the
// multiplayer lobby (with a live room) and the in-match chrome.
//
//   npm run build && npm run server:run     # or any static server on :8091
//   npm run ui:e2e                          # PASS/FAIL
//   npm run ui:e2e -- --url http://127.0.0.1:8091/ --keep
//
// The lobby part needs a published room; point ?mp= at the local relay
// (`npm run mp:relay`) and run the dedicated server (`npm run mp:server`) — or
// start a room in another tab. Rooms are optional: the test adapts.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openPage, HELPERS, launchChrome, sleep } from './cdp.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const APP = flag('--url', 'http://127.0.0.1:8091/');
const PORT = Number(flag('--port', '9352'));
const SHOT_DIR = process.env.MP_E2E_SHOTS || '/tmp/opencode/shots';
mkdirSync(SHOT_DIR, { recursive: true });

const report = [];
function step(name, value) {
  report.push([name, value]);
  console.log(`· ${name}`, typeof value === 'object' ? JSON.stringify(value) : value);
}

const { chrome } = await launchChrome({ port: PORT, profilePrefix: 'ie-ui-e2e' });

/** CSS-pixel centre of a UI region, or null when the screen has no such id. */
const regionPoint = (page, id) => page.evaluate(`(() => {
  const r = window.__ieRenderer;
  const ui = r && r.uiOverlay;
  if (!ui) return null;
  const reg = ui.regions.find((x) => x.id === ${JSON.stringify(id)});
  if (!reg) return null;
  const rect = r.canvas.getBoundingClientRect();
  return { x: rect.left + (reg.x + reg.w / 2) * (rect.width / ui.logical.w),
           y: rect.top + (reg.y + reg.h / 2) * (rect.height / ui.logical.h),
           hit: (() => { const el = document.elementFromPoint(
             rect.left + (reg.x + reg.w / 2) * (rect.width / ui.logical.w),
             rect.top + (reg.y + reg.h / 2) * (rect.height / ui.logical.h));
             return el ? el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : '') : null; })() };
})()`);

async function waitRegions(page) {
  await page.evaluate(`(async () => {
    ${HELPERS}
    await until(() => R() && R().uiOverlay && R().uiOverlay.regions.length > 0, 90000);
    pump(6);
    return true;
  })()`);
}

async function clickRegion(page, id, label) {
  const point = await regionPoint(page, id);
  if (!point) throw new Error(`${label}: no region "${id}"`);
  await page.click(point.x, point.y);
  await sleep(250);
  await page.evaluate(`(() => { const r = window.__ieRenderer; if (r) for (let i = 0; i < 6; i++) r.onFrame(33); return true; })()`);
  return point;
}

try {
  // ------------------------------------------------------------- web menus
  const page = await openPage(PORT, `${APP}#/menu`, true);
  await waitRegions(page);

  let p = await clickRegion(page, '/single-player', 'main menu');
  step('main menu click (single player)', { hit: p.hit, hash: await page.evaluate('location.hash') });
  if (!(await page.evaluate('location.hash')).includes('single-player')) throw new Error('single player click did not navigate');

  await page.evaluate(`(async () => { ${HELPERS} await until(() => R().uiOverlay.regions.some((r) => r.id === '/ctf'), 30000); return true; })()`);
  p = await clickRegion(page, '/ctf', 'single player menu');
  await page.evaluate(`(async () => { ${HELPERS} await until(() => R().uiOverlay.regions.some((r) => r.id.startsWith('/briefing/ctf')), 30000); return true; })()`);
  const briefingId = await page.evaluate(`(() => {
    const r = window.__ieRenderer;
    return r.uiOverlay.regions.find((x) => x.id.startsWith('/briefing/ctf')).id;
  })()`);
  p = await clickRegion(page, briefingId, 'ctf menu');
  const briefing = await page.evaluate(`(async () => {
    ${HELPERS}
    await until(() => location.hash.includes('/briefing/'), 20000);
    await until(() => window.__ieStore.scoreboard, 30000);
    return { hash: location.hash, rows: window.__ieStore.scoreboard.rows.filter((r) => r).length };
  })()`);
  step('briefing reached through real clicks', { hit: p.hit, ...briefing });

  // ---------------------------------------------------------------- options
  await page.evaluate(`location.hash = '#/options'`);
  await page.evaluate(`(async () => { ${HELPERS} await until(() => R().uiOverlay.regions.some((r) => r.id === 'row:billboards') && location.hash.includes('options'), 30000); return true; })()`);
  const before = await page.evaluate('window.__ieStore.options.billboards');
  p = await clickRegion(page, 'row:billboards', 'options checkbox');
  const afterCheck = await page.evaluate('window.__ieStore.options.billboards');
  step('options checkbox click', { hit: p.hit, before, after: afterCheck });
  if (before === afterCheck) throw new Error('checkbox click did not toggle the option');

  const volBefore = await page.evaluate('window.__ieStore.options.musicVolume');
  const slider = await regionPoint(page, 'row:musicVolume');
  await page.drag(slider.x - 60, slider.y, slider.x + 60, slider.y);
  await sleep(200);
  const volAfter = await page.evaluate('window.__ieStore.options.musicVolume');
  step('options slider drag', { hit: slider.hit, before: volBefore, after: volAfter });
  if (Math.abs(volAfter - volBefore) < 0.01) throw new Error('slider drag did not change the value');

  p = await clickRegion(page, 'primary', 'options save');
  const saved = await page.evaluate(`(() => ({ hash: location.hash, stored: !!localStorage.getItem('options.ie3d') }))()`);
  step('options save click', { hit: p.hit, ...saved });
  // Back is LIFO: the save returns to wherever the options screen was opened
  // from (here the briefing), never staying on the options screen.
  if (saved.hash.includes('options')) throw new Error('save did not leave the options screen');
  if (!saved.stored) throw new Error('save did not persist the options');
  await page.screenshot(join(SHOT_DIR, 'ui-e2e-menu.png'));

  // --------------------------------------------------------------- console
  // (the in-match chrome must stay clickable with the DOM layer transparent)
  await page.evaluate(`location.hash = '#/game/tt-easy-01'`);
  const paused = await page.evaluate(`(async () => {
    ${HELPERS}
    await until(() => window.__ieGame && window.__ieGame.gameType !== 'BACK', 90000);
    pump(4);
    const r = R();
    const rect = r.canvas.getBoundingClientRect();
    return { x: rect.left + 80, y: rect.top + 24 };
  })()`);
  await page.click(paused.x, paused.y);
  await sleep(300);
  const isPaused = await page.evaluate('window.__ieStore.paused');
  step('in-match back button (pause overlay)', { paused: isPaused });
  if (!isPaused) throw new Error('the in-match back button did not open the pause panel');
  const canResume = await page.evaluate(`(async () => {
    ${HELPERS}
    const btn = [...document.querySelectorAll('.pause-btn')].find((b) => b.textContent.trim() === 'RESUME');
    if (!btn) return false;
    const rect = btn.getBoundingClientRect();
    window.__uiProbe = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    return true;
  })()`);
  if (canResume) {
    const pt = await page.evaluate('window.__uiProbe');
    await page.click(pt.x, pt.y);
    await sleep(250);
    step('pause RESUME click', { paused: await page.evaluate('window.__ieStore.paused') });
  }

  // -------------------------------------------------------------- the lobby
  const relay = process.env.MP_RELAY || 'ws://127.0.0.1:7777';
  const lobby = await openPage(PORT, `${APP}?mp=${encodeURIComponent(relay)}#/multiplayer`, false);
  await lobby.evaluate(`(async () => {
    ${HELPERS}
    await until(() => window.__ieMP && R() && R().uiOverlay && R().uiOverlay.regions.length > 0, 90000);
    await window.__ieMP.connect();
    await until(() => R().uiOverlay.regions.some((r) => r.id === 'dd:filter'), 30000);
    return true;
  })()`);
  p = await clickRegion(lobby, 'dd:filter', 'lobby age filter');
  const opts = await lobby.evaluate(`(() => {
    const r = window.__ieRenderer;
    return r.uiOverlay.regions.filter((x) => x.id.startsWith('opt:dd:filter')).map((x) => x.id);
  })()`);
  step('lobby dropdown click', { hit: p.hit, options: opts.length });
  if (opts.length === 0) throw new Error('the age filter dropdown did not open');
  await clickRegion(lobby, 'opt:dd:filter:12', 'lobby filter option');
  const maxAge = await lobby.evaluate('window.__ieMP.config.maxAgeHours');
  step('lobby filter option click', { maxAgeHours: maxAge, online: await lobby.evaluate('window.__ieMP.online') });
  if (maxAge !== 12) throw new Error('the filter option did not apply');
  const back = await clickRegion(lobby, 'back', 'lobby back');
  step('lobby back click', { hit: back.hit, hash: await lobby.evaluate('location.hash') });
  await lobby.screenshot(join(SHOT_DIR, 'ui-e2e-lobby.png'));
  if (!(await lobby.evaluate('location.hash')).includes('menu')) throw new Error('lobby back did not return to the menu');

  console.log('\nui-e2e: PASS');
} catch (e) {
  console.error('\nui-e2e: FAIL —', e.message);
  console.error(JSON.stringify(report, null, 1));
  process.exitCode = 1;
} finally {
  if (!args.includes('--keep')) {
    chrome.kill('SIGKILL');
    await sleep(200);
  }
}
