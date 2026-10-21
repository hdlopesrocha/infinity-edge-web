// Browser acceptance checks (headless Chrome + CDP, no extra dependencies).
//
//   node tools/screenshots.mjs      # visual snapshots per route
//   node tools/verify.mjs [baseUrl] # behavioural checks, prints PASS/FAIL
//
// Checks: hash routing + history back/forward, deep-link restore, a single
// surviving WebGL context across routes, navigation → background scene mapping,
// audio unlock + WebAudio looping soundtrack after a user gesture, frame rate,
// and frustum culling (rejected objects counted, nothing visible is dropped).
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';
const PORT = Number(process.env.CDP_PORT ?? '9555');
const profile = join(tmpdir(), `ie-verify-${process.pid}`);
mkdirSync(profile, { recursive: true });

const proc = spawn(process.env.CHROME || 'google-chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--autoplay-policy=user-gesture-required',
  '--window-size=800,480', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function list() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (r.ok) return await r.json();
    } catch { /* wait */ }
    await sleep(250);
  }
  throw new Error('chrome did not start');
}

const page = (await list()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? 'exception');
  } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error'
    && !/favicon/.test(msg.params.entry.text)) {
    consoleErrors.push(msg.params.entry.text);
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});

async function evaluate(expression, timeout = 15000) {
  const r = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, timeout,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result?.value;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride',
  { width: 800, height: 480, deviceScaleFactor: 1, mobile: false });

const goto = async (hash, wait = 1500) => {
  await send('Page.navigate', { url: `${BASE}/#${hash}` });
  await sleep(wait);
};

// --- routing / history ----------------------------------------------------
await goto('/menu');
const menuHash = await evaluate('location.hash');
check('deep link opens the route', menuHash === '#/menu', menuHash);

await evaluate('document.querySelector("a[href=\'#/single-player\']")?.click() ?? (window.location.hash = "#/single-player")');
await sleep(800);
check('menu navigation changes the route', (await evaluate('location.hash')).startsWith('#/single-player'));

await evaluate('history.back()');
await sleep(800);
check('browser back restores the previous route', (await evaluate('location.hash')) === '#/menu',
  await evaluate('location.hash'));

await evaluate('history.forward()');
await sleep(800);
check('browser forward re-applies the route',
  (await evaluate('location.hash')).startsWith('#/single-player'), await evaluate('location.hash'));

// unknown routes must not crash or fall back to a DOM page
await goto('/no-such-screen');
const unknown = await evaluate(`(() => {
  const r = window.__ieRenderer;
  const ui = r && r.uiOverlay;
  return {
    canvas: !!document.querySelector('canvas'),
    regions: ui ? ui.regions.length : 0,
    text: document.body.innerText.trim().slice(0, 40),
    errors: (window.__ieErrors || []).length,
  };
})()`);
check('unknown route handled', unknown.canvas && unknown.regions > 0
  && !/error|failed/i.test(unknown.text), JSON.stringify(unknown));

// --- one GL context across routes ----------------------------------------
await goto('/menu', 2500);
const ctxA = await evaluate('(() => { const c = document.querySelector("canvas"); const g = c.getContext("webgl2"); return { has: !!g, lost: g ? g.isContextLost() : null, tag: g && g.__id || (g.__id = Math.random()), frames: window.__ieRenderer?.stats.fps }; })()');
await goto('/single-player', 1500);
await goto('/menu', 1200);
const ctxB = await evaluate('(() => { const c = document.querySelector("canvas"); const g = c.getContext("webgl2"); return { has: !!g, tag: g && g.__id, frames: window.__ieRenderer?.stats.fps }; })()');
check('a single WebGL context survives navigation',
  ctxA.has && ctxB.has && ctxA.tag === ctxB.tag && !ctxA.lost,
  `tag ${String(ctxA.tag).slice(0, 6)} -> ${String(ctxB.tag).slice(0, 6)}`);

// --- navigation -> background scene --------------------------------------
const sceneFor = async (hash) => {
  await goto(hash, 1500);
  return evaluate('window.__ieStore ? window.__ieStore.sceneKey : null');
};
const sMenu = await sceneFor('/menu');
const sOptions = await sceneFor('/options');
const sEngine = await sceneFor('/engine');
const sGame = await sceneFor('/game/tt-easy-01');
check('menu/settings share the background scene', sMenu === 'background' && sOptions === 'background',
  `${sMenu} / ${sOptions}`);
check('engine boot screen uses its own scene', sEngine === 'engine', String(sEngine));
check('game route switches to its level scene', sGame === 'tt-easy-01', String(sGame));

// --- audio after a user gesture ------------------------------------------
await goto('/menu', 2000);
// Trusted input only: synthetic DOM events do not grant user activation in
// Chrome, so the gesture is dispatched through the DevTools Input domain.
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 240, buttons: 0 });
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 400, y: 240, button: 'left', buttons: 1, clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 400, y: 240, button: 'left', buttons: 0, clickCount: 1 });
await sleep(1500);
// Decoding the 5.6 MB soundtrack can take a few seconds on a software-rendered
// headless run; poll instead of assuming a fixed startup time.
let audioState = null;
for (let i = 0; i < 16; i++) {
  audioState = await evaluate(`(() => {
    const a = window.__ieAudio;
    const source = a?.musicSource ?? null;
    return a ? {
      unlocked: a.unlocked ?? null,
      playing: typeof a.playing === 'function' ? a.playing() : null,
      ctx: a.ctx ? a.ctx.state : null,
      elements: document.querySelectorAll('audio').length,
      source: !!source,
      loop: source ? source.loop : null,
      analyser: !!a.musicAnalyser,
    } : null;
  })()`);
  if (audioState?.playing) break;
  await sleep(500);
}
check('audio unlocks after a user gesture', !!audioState && (audioState.unlocked || audioState.playing),
  JSON.stringify(audioState));
// The soundtrack is an AudioBufferSourceNode with loop=true, feeding the
// party-mode analyser; there is no <audio> element anywhere in the page.
check('soundtrack is a looping WebAudio buffer source',
  !!audioState && audioState.playing === true && audioState.ctx === 'running'
    && audioState.elements === 0 && audioState.source === true
    && audioState.loop === true && audioState.analyser === true,
  JSON.stringify(audioState));

// --- gameplay: fps, culling, no dropped frames ---------------------------
await goto('/game/ctf-easy', 14000);
const game = await evaluate(`(() => {
  const r = window.__ieRenderer, g = window.__ieGame;
  if (!r || !g) return null;
  const f = r.frustum;
  let visible = 0, invisible = 0;
  const objs = [...g.teams.values()].flatMap(t => t.objects);
  for (const o of objs) {
    let inFrustum = true;
    for (let i = 0; i < 6; i++) {
      if (f[i*4]*o.sx + f[i*4+1]*o.sy + f[i*4+2]*o.sz + f[i*4+3] < -o.sradius) { inFrustum = false; break; }
    }
    inFrustum ? visible++ : invisible++;
  }
  const selected = new Set(g.map.visible);
  let wronglyDropped = 0;
  for (const o of objs) {
    let inFrustum = true;
    for (let i = 0; i < 6; i++) {
      if (f[i*4]*o.sx + f[i*4+1]*o.sy + f[i*4+2]*o.sz + f[i*4+3] < -o.sradius) { inFrustum = false; break; }
    }
    if (inFrustum && o.physics.objectType !== 0 && o.active && !selected.has(o)) wronglyDropped++;
  }
  return {
    fps: r.stats.fps, draws: r.stats.draws, culled: r.stats.culled,
    visible: g.map.visible.length, visibleShips: visible, invisibleShips: invisible,
    wronglyDropped, score: g.scoreText(),
  };
})()`);
check('game scene renders at a stable frame rate', game && game.fps >= 20, `fps ${game?.fps}`);
check('frustum culling rejects objects', game && game.culled > 0, `culled ${game?.culled}, drawn ${game?.draws}`);
check('culling never drops a visible object', game && game.wronglyDropped === 0,
  `visible ships ${game?.visibleShips}, invisible ${game?.invisibleShips}, wrongly dropped ${game?.wronglyDropped}`);

// --- context loss recovery ------------------------------------------------
await goto('/game/tt-easy-01', 6000);
const loss = await evaluate(`(() => {
  const gl = document.querySelector('canvas').getContext('webgl2');
  const ext = gl.getExtension('WEBGL_lose_context');
  if (!ext) return { supported: false };
  // The extension instance is invalidated while the context is lost, so it is
  // kept on window for the restore call.
  window.__loseExt = ext;
  window.__drawBefore = window.__ieRenderer.draw;
  ext.loseContext();
  return { supported: true, lost: gl.isContextLost() };
})()`);
await sleep(1500);
const halted = await evaluate(`(() => {
  const d0 = window.__drawBefore;
  return { sameDraw: window.__ieRenderer.draw === d0 };
})()`);
const recovery = await evaluate(`new Promise((resolve) => {
  const gl = document.querySelector('canvas').getContext('webgl2');
  window.__loseExt.restoreContext();
  const t0 = performance.now();
  const tick = () => {
    const r = window.__ieRenderer;
    const alive = !gl.isContextLost() && r.draw !== window.__drawBefore
      && (r.stats.fps ?? 0) > 0 && (r.stats.draws ?? 0) > 0;
    if (alive) {
      resolve({ ok: true, ms: Math.round(performance.now() - t0), fps: r.stats.fps, drawn: r.stats.draws });
      return;
    }
    if (performance.now() - t0 > 12000) {
      resolve({ ok: false, ms: Math.round(performance.now() - t0), lost: gl.isContextLost(),
                rebuilt: r.draw !== window.__drawBefore, fps: r.stats.fps, drawn: r.stats.draws });
      return;
    }
    setTimeout(tick, 250);
  };
  tick();
})`);
check('context loss stops the loop and restore rebuilds GL state',
  loss?.supported !== false && halted?.sameDraw === true && !!recovery?.ok,
  `lost=${String(loss?.lost)} paused=${String(halted?.sameDraw)} recovery ${JSON.stringify(recovery)}`);

// --- high-DPI --------------------------------------------------------------
// Emulate a 2x display and confirm the backing store (not just the CSS size)
// follows the device pixel ratio, capped at 2.
await send('Emulation.setDeviceMetricsOverride',
  { width: 800, height: 480, deviceScaleFactor: 2, mobile: false });
await sleep(1500);
const dpr = await evaluate(`(() => {
  const c = document.querySelector('canvas');
  return { dpr: window.devicePixelRatio || 1, w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight };
})()`);
check('canvas backing store honours device pixel ratio',
  dpr.dpr === 2 && dpr.w === dpr.cw * 2 && dpr.h === dpr.ch * 2, JSON.stringify(dpr));
await send('Emulation.setDeviceMetricsOverride',
  { width: 800, height: 480, deviceScaleFactor: 1, mobile: false });
await sleep(600);

// --- no page errors overall ----------------------------------------------
check('no uncaught page errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
ws.close();
proc.kill();
await sleep(500);
try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ }
process.exit(failed.length ? 1 : 0);
