import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openPage, HELPERS, launchChrome, sleep } from './cdp.mjs';

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
const GUESTS = Math.max(1, Number(flag('--guests', '1')));
const PORT = Number(flag('--port', '9334'));
const SHOT_DIR = process.env.MP_E2E_SHOTS || '/tmp/opencode/shots';
mkdirSync(SHOT_DIR, { recursive: true });

/** Distinct, deterministic identities: one Nostr key per page/participant. */
const keyFor = (who) => createHash('sha256').update('ie-mp-e2e:' + who).digest('hex');
const pageUrl = (hash, who) => `${APP}?mp=${encodeURIComponent(RELAY)}&mpKey=${keyFor(who)}#/${hash}`;

const { chrome } = await launchChrome({ port: PORT, profilePrefix: 'ie-mp-e2e' });

const report = { steps: [] };
function step(name, value) {
  report.steps.push([name, value]);
  console.log(`· ${name}`, typeof value === 'object' ? JSON.stringify(value) : value);
}

try {
  // ---------------------------------------------------------------- host
  const host = await openPage(PORT, pageUrl('multiplayer', 'host'), DEBUG);
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
  await host.screenshot(join(SHOT_DIR, 'mp-lobby-host.png'));

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

  // --------------------------------------------------------------- guests
  const guests = [];
  for (let n = 1; n <= GUESTS; n++) {
    const guest = await openPage(PORT, 'about:blank', DEBUG);
    await guest.evaluate(`location.href = ${JSON.stringify(pageUrl('multiplayer', 'guest-' + n))}`);
    await guest.waitForUrl('#/multiplayer');
    const joined = await guest.evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const R = () => window.__ieRenderer;
      const pump = (n) => { const r = R(); if (r) for (let i = 0; i < n; i++) r.onFrame(33); };
      const until = async (fn, ms) => {
        const t0 = Date.now();
        for (;;) {
          const v = fn();
          if (v) return v;
          if (Date.now() - t0 > ms) throw new Error('timeout: ' + fn.toString().slice(0, 60));
          pump(1);
          await sleep(40);
        }
      };
      const click = (id) => {
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
      await until(() => window.__ieMP && R(), 60000);
      const mp = window.__ieMP;
      await until(() => R().uiOverlay && R().uiOverlay.regions.length > 6, 60000);
      await mp.connect();
      const room = await until(() => mp.rooms.find((x) => x.id === ${JSON.stringify(hostCreated.roomId)}), 60000);
      const key = room.hostPubkey + ':' + room.id;
      await until(() => R().uiOverlay.regions.some((x) => x.id === 'join:' + key));
      click('join:' + key);
      try {
        await until(() => location.hash.includes('/game/'), 90000);
      } catch {
        return { failed: 'navigate', error: mp.error, status: mp.status,
          pending: !!mp.pendingJoin, joining: R().uiOverlay ? R().uiOverlay.joining : null,
          trace: window.__ieMPTrace ? window.__ieMPTrace() : [] };
      }
      const g = await until(() => {
        const inst = window.__ieGame;
        return inst && typeof inst.rtt === 'number' && inst.selectedObject ? inst : null;
      }, 120000);
      return {
        hash: location.hash, roomTitle: room.title, hostName: room.host,
        isNet: typeof g.rtt === 'number',
        ship: g.selectedObject ? [g.selectedObject.pos[0], g.selectedObject.pos[1], g.selectedObject.pos[2]] : null,
        levelKey: g.levelKey,
      };
    })()`).catch(async (e) => ({ failed: String(e.message) }));
    step('guest ' + n + ' joined over WebRTC', joined);
    if (joined.failed) {
      const hostTrace = await host.evaluate('window.__ieMPTrace ? window.__ieMPTrace() : []').catch(() => []);
      throw new Error('guest ' + n + ' join failed: ' + JSON.stringify(joined) + ' hostTrace: ' + JSON.stringify(hostTrace));
    }
    if (!joined.isNet) throw new Error('guest ' + n + ' did not end up on a NetGame instance');
    guests.push({ page: guest, info: joined });
  }

  // Stream both ways: host steps + sends, guests apply.
  await host.evaluate(`(async () => { ${HELPERS} pump(16); return true; })()`);
  for (const g of guests) await g.page.evaluate(`(async () => { ${HELPERS} pump(10); return true; })()`);
  const guest = guests[0].page;

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
    for (const gg of guests.slice(1)) {
      await gg.page.evaluate(`(async () => { ${HELPERS} pump(2); return true; })()`);
    }
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
  step('host sees the guests', hostState);
  if (hostState.guests !== GUESTS) throw new Error('host saw ' + hostState.guests + ' guests, expected ' + GUESTS);
  const ships = hostState.detail.map((g) => JSON.stringify(g.pos));
  if (new Set(ships).size !== GUESTS) throw new Error('guests are not flying distinct ships: ' + ships.join(' | '));
  await host.screenshot(join(SHOT_DIR, 'mp-host.png'));
  await guest.screenshot(join(SHOT_DIR, 'mp-guest.png'));
  console.log('screenshots written to', SHOT_DIR);

  // Close the room (NIP-09) and let the relay see it before Chrome goes.
  const closed = await host.evaluate(`(async () => {
    const mp = window.__ieMP;
    const id = mp.hosting && mp.hosting.id;
    mp.endSession();
    return { id, hosting: !!mp.hosting };
  })()`).catch(() => false);
  step('host closed the room', closed);

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
