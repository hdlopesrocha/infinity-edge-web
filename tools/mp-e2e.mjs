// Multiplayer end-to-end: two browser pages (host + guest) talking over a
// local Nostr relay and a WebRTC data channel, driven through the real lobby
// UI. Verifies the whole chain: room listing, signalling, the RTC channel,
// host frames, guest rendering and guest input reaching the host simulation.
//
//   node tools/relay.mjs --port 7777 &
//   npm run build && build/server/ie-server --port 8091 --root dist &
//   node tools/mp-e2e.mjs
//
// Flags: --url (app base) --relay (ws url) --level --type --keep --debug.
//
// Headless tabs do not run requestAnimationFrame, so every step drives frames
// by hand through renderer.onFrame(dt) - the same trick tools/probe.mjs users
// need. A time-trial level keeps the software renderer fast, and hosts there
// spawn a wingman for the guest (no AI ship to adopt).

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const DEBUG = args.includes('--debug') || !!process.env.MP_E2E_DEBUG;
const APP = flag('--url', 'http://127.0.0.1:8091/');
const RELAY = flag('--relay', 'ws://127.0.0.1:7777');
const LEVEL = flag('--level', 'tt-easy-01');
const TYPE = flag('--type', 'TT');
/** Dropdown positions in the lobby's create-room form. */
const TYPE_IDX = { CTF: 0, TT: 1, KOTS: 2, SURV: 3 }[TYPE] ?? 1;
const LEVEL_IDX = Number(flag('--level-idx', '0'));
const PORT = Number(flag('--port', '9334'));
const profile = join(tmpdir(), `ie-mp-e2e-${process.pid}`);
mkdirSync(profile, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pageUrl = (hash) => `${APP}?mp=${encodeURIComponent(RELAY)}#/${hash}`;
const chrome = spawn(process.env.CHROME || 'google-chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--autoplay-policy=no-user-gesture-required',
  '--window-size=1000,620', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

async function browserVersion() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* wait */ }
    await sleep(250);
  }
  throw new Error('chrome did not start');
}

async function listTargets() {
  return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json());
}

/** Minimal CDP client: send + evaluate (whole-message `sent`, unwrapped eval). */
let cdpSeq = 0;
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const slot = pending.get(msg.id);
    if (slot) {
      pending.delete(msg.id);
      slot(msg);
    }
  };
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const sent = (method, params = {}) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const page = {
    ws,
    sent,
    async evaluate(expression, timeout = 240000) {
      const tag = ++cdpSeq;
      const t0 = Date.now();
      const msg = await Promise.race([
        sent('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
        sleep(timeout).then(() => ({ timeout: true })),
      ]);
      if (DEBUG) console.log(`    [eval ${tag}] ${Date.now() - t0} ms`);
      if (msg.timeout) throw new Error('evaluate timed out (expr ' + tag + ')');
      const res = msg.result ?? {};
      if (res.exceptionDetails) {
        throw new Error('page error: ' + (res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails)));
      }
      return res.result?.value;
    },
    async waitForUrl(fragment, timeout = 90000) {
      const t0 = Date.now();
      let last = '';
      while (Date.now() - t0 < timeout) {
        const href = await page.evaluate('location.href', 10000).catch((e) => 'ERR:' + e.message);
        last = String(href);
        if (last.includes(fragment)) return true;
        await sleep(150);
      }
      throw new Error('page did not reach ' + fragment + ' (last: ' + last + ')');
    },
  };
  return ready.then(() => page);
}

/** Headless Chrome allows one command-line target: create the rest via CDP. */
async function openPage(url) {
  const version = await browserVersion();
  const browser = await connect(version.webSocketDebuggerUrl);
  const created = await browser.sent('Target.createTarget', { url });
  const targetId = created.result?.targetId;
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    wsUrl = (await listTargets()).find((t) => t.id === targetId)?.webSocketDebuggerUrl ?? null;
    if (!wsUrl) await sleep(150);
  }
  if (!wsUrl) throw new Error('could not open a tab for ' + url);
  const page = await connect(wsUrl);
  if (url !== 'about:blank') await page.waitForUrl(url.split('#')[1] ? '#' + url.split('#')[1] : 'http');
  return page;
}

/** Page-side helpers, prepended to every step. */
const HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const R = () => window.__ieRenderer;
  const pump = (n, dt = 33) => { const r = R(); if (r) for (let i = 0; i < n; i++) r.onFrame(dt); };
  const until = async (fn, ms = 60000) => {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error('timeout: ' + fn.toString().slice(0, 70));
      pump(1);
      await sleep(40);
    }
  };
  const lobbyReady = () => { const r = R(); return r && r.uiOverlay && r.uiOverlay.regions.length > 6; };
  const clickRegion = (id) => {
    const r = R();
    const lobby = r.uiOverlay;
    const reg = lobby.regions.find((x) => x.id === id);
    if (!reg) return false;
    const c = r.canvas;
    const rect = c.getBoundingClientRect();
    const cx = (reg.x + reg.w / 2) * (rect.width / lobby.logical.w);
    const cy = (reg.y + reg.h / 2) * (rect.height / lobby.logical.h);
    const opts = { bubbles: true, cancelable: true, clientX: rect.left + cx, clientY: rect.top + cy,
      pointerId: 3, isPrimary: true, button: 0, buttons: 1 };
    c.dispatchEvent(new PointerEvent('pointerdown', opts));
    window.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
    pump(3);
    return true;
  };
`;

const report = { steps: [] };
function step(name, value) {
  report.steps.push([name, value]);
  console.log(`· ${name}`, typeof value === 'object' ? JSON.stringify(value) : value);
}

try {
  // ---------------------------------------------------------------- host
  const host = await openPage(pageUrl('multiplayer'));
  const hostReady = await host.evaluate(`(async () => {
    ${HELPERS}
    await until(() => window.__ieMP && R());
    const mp = window.__ieMP;
    await until(() => lobbyReady());
    const online = await mp.connect();
    await until(() => mp.online || !online, 15000);
    return { online: mp.online, rooms: mp.rooms.length, npub: mp.npub.slice(0, 12) };
  })()`);
  step('host lobby ready', hostReady);
  if (!hostReady.online) throw new Error('host relay offline');

  const hostCreated = await host.evaluate(`(async () => {
    ${HELPERS}
    const mp = window.__ieMP;
    const state = () => {
      const g = window.__ieGame;
      const s = window.__ieStore;
      void 0;
      return { hash: location.hash, scene: s.sceneKey, route: s.route,
        glErr: (document.querySelector('.hud-notify')?.textContent || '').slice(0, 100),
        game: g ? g.constructor.name + ':' + g.gameType + ':' + g.levelKey : null,
        hosting: !!mp.hosting, session: mp.sessionActive, err: mp.error, intent: !!mp.hostIntent,
        trace: (window.__ieMPTrace ? window.__ieMPTrace() : []) };
    };
    // Pick the game type and level in the form (the lobby's own dropdowns).
    await until(() => clickRegion('dd:type'));
    await until(() => clickRegion('opt:dd:type:${TYPE_IDX}'));
    await until(() => clickRegion('dd:level'));
    await until(() => clickRegion('opt:dd:level:${LEVEL_IDX}'));
    await until(() => clickRegion('create'));
    await until(() => location.hash.includes('/game/'), 90000);
    let built = false;
    try {
      // The scene builds on the app's own interval; keep it ticking.
      await until(() => window.__ieGame && mp.sessionActive && window.__ieGame.gameType !== 'BACK', 120000);
      built = true;
    } catch { /* report the state below */ }
    const room = mp.hosting;
    return {
      built, state: state(),
      hash: location.hash, roomId: room && room.id, roomGame: room && room.game,
      roomTitle: room && room.title, pubkey: mp.pubkey,
      levelKey: window.__ieGame && window.__ieGame.levelKey,
      ships: window.__ieGame && window.__ieGame.gameType !== 'BACK' ? window.__ieGame.teams.get('human').objects.length : 0,
    };
  })()`);
  step('host created + hosting', hostCreated);
  if (!hostCreated.built) throw new Error('host match never started: ' + JSON.stringify(hostCreated.state));
  if (!hostCreated.roomId || hostCreated.roomGame !== LEVEL) throw new Error('host did not create the room');

  await host.evaluate(`(async () => { ${HELPERS} pump(10); return true; })()`);

  // ---------------------------------------------------------------- guest
  const guest = await openPage('about:blank');
  const guestUrl = pageUrl('multiplayer');
  await guest.evaluate(`location.href = ${JSON.stringify(guestUrl)}`);
  await guest.waitForUrl('#/multiplayer');

  const guestJoined = await guest.evaluate(`(async () => {
    ${HELPERS}
    await until(() => window.__ieMP && R(), 60000);
    const mp = window.__ieMP;
    await until(() => lobbyReady(), 60000);
    await mp.connect();
    const room = await until(() => mp.rooms.find((x) => x.id === ${JSON.stringify(hostCreated.roomId)}), 60000);
    const key = room.hostPubkey + ':' + room.id;
    await until(() => R().uiOverlay.regions.some((x) => x.id === 'join:' + key));
    const clicked = clickRegion('join:' + key);
    let navigated = false;
    const state = () => ({ hash: location.hash, clicked, error: mp.error, status: mp.status,
      pending: !!mp.pendingJoin, rooms: mp.rooms.length, dead: [...mp.deadRooms.keys()].length,
      joining: R().uiOverlay ? R().uiOverlay.joining : null,
      trace: window.__ieMPTrace ? window.__ieMPTrace() : [] });
    try {
      await until(() => location.hash.includes('/game/'), 60000);
      navigated = true;
    } catch { /* report below */ }
    if (!navigated) return { navigated, state: state() };
    // Built bundles mangle class names: NetGame is the only instance with an
    // rtt getter (Ping/Pong) - and the guest's ship must have spawned.
    const joined = await until(() => {
      const g = window.__ieGame;
      return g && typeof g.rtt === 'number' && g.selectedObject ? g : null;
    }, 120000);
    return {
      hash: location.hash, roomTitle: room.title, hostName: room.host,
      isNet: typeof joined.rtt === 'number', playerId: joined.selectedObject.id, levelKey: joined.levelKey,
    };
  })()`);
  step('guest joined over WebRTC', guestJoined);
  if (!guestJoined.isNet) throw new Error('guest did not end up on a NetGame instance');

  // Stream both ways: host steps + sends, guest applies.
  await host.evaluate(`(async () => { ${HELPERS} pump(16); return true; })()`);
  await guest.evaluate(`(async () => { ${HELPERS} pump(10); return true; })()`);

  const guestState = await guest.evaluate(`(async () => {
    ${HELPERS}
    const g = window.__ieGame;
    pump(4);
    return {
      hudLife: window.__ieStore.hud.life.length,
      teams: [...g.teams.values()].filter((t) => t.objects.length > 0).map((t) => [t.name, Math.round(t.points)]),
      selected: !!g.selectedObject, rtt: Math.round(g.rtt),
      flags: g.flags ? g.flags.length : -1,
    };
  })()`);
  step('guest world from the host', guestState);
  if (!(guestState.hudLife > 0)) throw new Error('guest HUD has no life data from the host');
  if (!(guestState.rtt >= 0)) throw new Error('guest never got a Pong');

  // Run the pre-match countdown out: the world is frozen until then, so no
  // input would reach the simulation.
  await host.evaluate(`(async () => {
    ${HELPERS}
    await until(() => window.__ieStore.hud.countdown === 0, 150000);
    return true;
  })()`);
  await host.evaluate(`(async () => { ${HELPERS} pump(6, 100); return true; })()`);
  await guest.evaluate(`(async () => {
    ${HELPERS}
    await until(() => window.__ieStore.hud.countdown === 0, 60000);
    return window.__ieStore.hud.countdown;
  })()`);

  // Guest input: hold thrust and step both sides alternately (the host drops
  // input that has been silent for >1.2 s of wall time, and software frames
  // are slow, so one long host pump would throttle-out).
  await guest.evaluate(`(async () => {
    ${HELPERS}
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', bubbles: true }));
    pump(2);
    return true;
  })()`);
  const rounds = [];
  for (let i = 0; i < 14; i++) {
    const g = await guest.evaluate(`(async () => {
      ${HELPERS}
      pump(2);
      const gi = window.__ieGame;
      return { keys: [...gi.control.keys], throttle: gi.control.analogAcel.value,
        speed: Math.round(window.__ieStore.hud.speed), open: !!(gi.ws || gi.transport) };
    })()`);
    const h = await host.evaluate(`(async () => {
      ${HELPERS}
      pump(2, 100);
      return window.__ieMP.debugGuests();
    })()`);
    rounds.push([i, g, h]);
  }
  step('input rounds', rounds.slice(-4));
  const speed = await guest.evaluate(`(async () => {
    ${HELPERS}
    pump(3);
    return Math.round(window.__ieStore.hud.speed);
  })()`);
  await guest.evaluate(`(async () => {
    ${HELPERS}
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyC', bubbles: true }));
    pump(2);
    return true;
  })()`);
  step('guest throttle reached the host', { hudSpeed: speed });
  if (!(speed > 5)) throw new Error('guest input did not move the ship (hud speed ' + speed + ')');

  const hostState = await host.evaluate(`(async () => {
    ${HELPERS}
    pump(6);
    const mp = window.__ieMP;
    return { guests: mp.guestCount(), session: mp.sessionActive, hosting: !!mp.hosting, detail: mp.debugGuests() };
  })()`);
  step('host sees the guest', hostState);
  if (hostState.guests !== 1) throw new Error('host did not see exactly one guest');

  console.log('\nmp-e2e: PASS');
} catch (e) {
  console.error('\nmp-e2e: FAIL —', e.message);
  process.exitCode = 1;
} finally {
  if (!args.includes('--keep')) {
    chrome.kill('SIGKILL');
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
