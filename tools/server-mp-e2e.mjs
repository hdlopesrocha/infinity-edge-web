// Dedicated-server multiplayer e2e: the C++ server creates the room on Nostr,
// accepts WebRTC guests and runs the whole match (it never plays). Two real
// browser tabs join through the WebGL lobby, render the server's frames and
// steer their ships; the server's /mp/status proves both are connected.
//
//   npm run build
//   node tools/server-mp-e2e.mjs
//
// Flags: --server <path> --app-port <n> --level <key> --guests <n> --keep --debug.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPage, HELPERS, launchChrome, sleep } from './cdp.mjs';
import { startRelay } from './relay.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const DEBUG = args.includes('--debug') || !!process.env.MP_E2E_DEBUG;
const SERVER = flag('--server', 'build/server/ie-server');
const APP_PORT = Number(flag('--app-port', '8096'));
const LEVEL = flag('--level', 'tt-easy-01');
const GUESTS = Math.max(1, Number(flag('--guests', '2')));
const CHROME_PORT = Number(flag('--chrome-port', '9336'));
const SHOT_DIR = process.env.MP_E2E_SHOTS || '/tmp/opencode/shots';
const SERVER_NAME = 'E2E Dedicated Server';
const AUTO_FINISH = Number(flag('--auto-finish', '0'));
mkdirSync(SHOT_DIR, { recursive: true });

if (!existsSync(SERVER)) {
  console.error(`server binary not found: ${SERVER} (run npm run server:build)`);
  process.exit(2);
}

const report = { steps: [] };
function step(name, value) {
  report.steps.push([name, value]);
  console.log(`· ${name}`, typeof value === 'object' ? JSON.stringify(value) : value);
}

const relay = await startRelay();
console.log(`· relay ${relay.url}`);
const keyFile = join(tmpdir(), `ie-server-key-${process.pid}.txt`);
const server = spawn(SERVER, [
  '--port', String(APP_PORT),
  '--root', 'dist',
  '--room', LEVEL,
  '--room-name', SERVER_NAME,
  '--room-max', '6',
  '--nostr-relay', relay.url,
  '--nostr-key-file', keyFile,
  '--auto-finish', String(AUTO_FINISH),
], { stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
const serverLogPath = process.env.MP_SERVER_LOG || '/tmp/opencode/server-mp-e2e.log';
import { writeFileSync as writeServerLog } from 'node:fs';
server.stdout.on('data', (d) => {
  serverLog += d.toString();
  if (DEBUG) process.stdout.write('  [server] ' + d.toString());
});
server.stderr.on('data', (d) => {
  serverLog += d.toString();
  if (DEBUG) process.stderr.write('  [server!] ' + d.toString());
});
server.on('exit', (code, signal) => {
  serverLog += `\n[server] exited code=${code} signal=${signal}\n`;
  try { writeServerLog(serverLogPath, serverLog); } catch { /* ignore */ }
});

const { chrome } = await launchChrome({ port: CHROME_PORT, profilePrefix: 'ie-server-e2e' });
const statusUrl = `http://127.0.0.1:${APP_PORT}/mp/status`;

async function status() {
  try {
    const r = await fetch(statusUrl);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

try {
  // ---------------------------------------------------------------- server
  let state = null;
  for (let i = 0; i < 120; i++) {
    state = await status();
    if (state && state.running && state.room) break;
    await sleep(250);
  }
  if (!state || !state.running) throw new Error('server room never started:\n' + serverLog);
  step('server room published', state);

  // ---------------------------------------------------------------- guests
  const pages = [];
  for (let n = 1; n <= GUESTS; n++) {
    const page = await openPage(CHROME_PORT, 'about:blank', DEBUG);
    const url = `http://127.0.0.1:${APP_PORT}/?mp=${encodeURIComponent(relay.url)}&mpKey=${'ab'.repeat(31)}${String(n).padStart(2, '0')}#/multiplayer`;
    await page.evaluate(`location.href = ${JSON.stringify(url)}`);
    await page.waitForUrl('#/multiplayer');
    const joined = await page.evaluate(`(async () => {
      ${HELPERS}
      await until(() => window.__ieMP && R(), 60000);
      const mp = window.__ieMP;
      await until(() => lobbyReady(), 60000);
      await mp.connect();
      const room = await until(() => mp.rooms.find((x) => x.host === ${JSON.stringify(SERVER_NAME)}), 60000);
      // Dedicated rooms are flagged so clients skip the waiting room.
      if (!room.srv) throw new Error('server room is missing srv:true');
      const key = room.hostPubkey + ':' + room.id;
      await until(() => R().uiOverlay.regions.some((x) => x.id === 'join:' + key));
      clickRegion('join:' + key);
      try {
        await until(() => location.hash.includes('/game/'), 90000);
      } catch {
        return { failed: 'navigate', error: mp.error, status: mp.status,
          pending: !!mp.pendingJoin, joining: R().uiOverlay ? R().uiOverlay.joining : null,
          trace: window.__ieMPTrace ? window.__ieMPTrace() : [] };
      }
      let g = null;
      try {
        g = await until(() => {
          const inst = window.__ieGame;
          return inst && typeof inst.rtt === 'number' && inst.selectedObject ? inst : null;
        }, 120000);
      } catch {
        return { failed: 'netgame', hash: location.hash,
          game: window.__ieGame ? window.__ieGame.constructor.name + ':' + window.__ieGame.gameType : null,
          trace: window.__ieMPTrace ? window.__ieMPTrace() : [] };
      }
      return {
        hash: location.hash, host: room.host, roomTitle: room.title,
        isNet: typeof g.rtt === 'number', levelKey: g.levelKey,
        ship: g.selectedObject ? [Math.round(g.selectedObject.pos[0]), Math.round(g.selectedObject.pos[1]), Math.round(g.selectedObject.pos[2])] : null,
      };
    })()`);
    step(`guest ${n} joined the server`, joined);
    if (!joined.isNet) throw new Error(`guest ${n} did not end up on a NetGame instance`);
    pages.push(page);
  }

  // Wait for the server's pre-match countdown, then throttle one guest and
  // let the server move it (the client only sends input and renders frames).
  await pages[0].evaluate(`(async () => {
    ${HELPERS}
    await until(() => window.__ieStore.hud.countdown === 0, 90000);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', bubbles: true }));
    pump(4);
    return true;
  })()`);
  let speed = 0;
  for (let i = 0; i < 40; i++) {
    await pages[0].evaluate(`(async () => { ${HELPERS} pump(2); return true; })()`);
    speed = await pages[0].evaluate('Math.round(window.__ieStore.hud.speed)');
    if (speed > 5) break;
    await sleep(150);
  }
  step('server moved the guest ship', { hudSpeed: speed });
  if (!(speed > 5)) throw new Error('guest throttle did not reach the server simulation (hud speed ' + speed + ')');

  const midState = await status();
  step('server status mid-match', midState);
  if (midState.players !== GUESTS) throw new Error(`server reports ${midState.players} players, expected ${GUESTS}`);

  // The guest's own HUD comes from the server: life pools + the match clock.
  const hud = await pages[0].evaluate(`(async () => {
    ${HELPERS}
    pump(3);
    return { life: window.__ieStore.hud.life.length, matchLeft: window.__ieStore.hud.matchLeft,
      ships: window.__ieGame.ships ? window.__ieGame.ships.length : -1 };
  })()`);
  step('guest HUD from the server', hud);
  if (!(hud.life > 0)) throw new Error('guest HUD has no life data from the server');

  await pages[0].screenshot(join(SHOT_DIR, 'mp-server-guest.png'));

  // Distinct ships for the guests: the server assigns one each.
  const ships = await pages[0].evaluate(`(async () => {
    ${HELPERS}
    return { hostname: location.host, ships: window.__ieGame.ships ? window.__ieGame.ships.length : -1 };
  })()`);
  step('guest view', ships);

  // Round lifecycle: finish the round through the ops endpoint, the server
  // sends Result and starts a fresh round on the same room id.
  const roomBefore = midState.room;
  const finishRes = await fetch(`http://127.0.0.1:${APP_PORT}/mp/finish`, { method: 'POST' });
  step('finish requested', { status: finishRes.status });
  let finished = false;
  let restarted = false;
  let seen = [];
  for (let i = 0; i < 400; i++) {
    const st = await status();
    if (i < 12 || (st && st.match === false && !finished)) seen.push(st ? { match: st.match, players: st.players } : null);
    if (st && st.match === false) finished = true;
    if (finished && st && st.match === true) {
      restarted = true;
      step('server restarted the round', st);
      if (st.room !== roomBefore) throw new Error('room id changed across rounds');
      break;
    }
    await sleep(250);
  }
  if (!finished) throw new Error('server never finished the round (auto-finish); statuses: ' + JSON.stringify(seen));
  if (!restarted) throw new Error('server never restarted the round');

  console.log('\nserver-mp-e2e: PASS');
} catch (e) {
  console.error('\nserver-mp-e2e: FAIL —', e.message);
  console.error('--- server log ---\n' + serverLog.split('\n').slice(-25).join('\n'));
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
  await sleep(600);
  chrome.kill('SIGKILL');
  await sleep(300);
  try { await relay.close(); } catch { /* ignore */ }
  try { rmSync(keyFile, { force: true }); } catch { /* ignore */ }
}
