// End-to-end: browser-hosted waiting room. The host creates a room and does
// NOT start the match; the guest joins the same room menu; chat, microphone
// and team picks flow over the WebRTC data channels; only the host's PLAY
// starts the match (and guests fly the team they were assigned).
//
// Every interaction uses real CDP input (Input.dispatchMouseEvent /
// dispatchKeyEvent), so hit-testing, focus and key handling are exercised.
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openPage, HELPERS, launchChrome, sleep } from './cdp.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const DEBUG = args.includes('--debug') || !!process.env.ROOM_E2E_DEBUG;
const APP = flag('--url', 'http://127.0.0.1:8091/');
const RELAY = flag('--relay', 'ws://127.0.0.1:7777');
const PORT = Number(flag('--port', '9338'));
const SHOTS = process.env.ROOM_E2E_SHOTS || '/tmp/opencode/shots';
mkdirSync(SHOTS, { recursive: true });

const keyFor = (who) => createHash('sha256').update('ie-room-e2e:' + who).digest('hex');
const pageUrl = (hash, who, name) =>
  `${APP}?mp=${encodeURIComponent(RELAY)}&mpKey=${keyFor(who)}&username=${encodeURIComponent(name)}#/${hash}`;

const { chrome } = await launchChrome({ port: PORT, profilePrefix: 'ie-room-e2e' });
const report = { steps: [] };
function step(name, value) {
  report.steps.push([name, value]);
  console.log('·', name, typeof value === 'object' ? JSON.stringify(value) : value);
}
function check(name, ok, extra) {
  if (!ok) throw new Error('FAILED: ' + name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  step(name, extra ?? true);
}

/** Page-side helpers: pump frames, poll state, locate UI regions. */
const PAGE = `
  ${HELPERS}
  const uiReady = () => { const r = R(); return !!(r && r.uiOverlay && r.uiOverlay.regions.length > 3); };
  const snap = () => { const mp = window.__ieMP; return mp && mp.roomSnapshot ? mp.roomSnapshot() : null; };
`;

async function clickRegion(page, id) {
  const pt = await page.evaluate(`(async () => { ${PAGE} return await until(() => regionPoint(${JSON.stringify(id)}), 20000); })()`);
  await page.click(pt.x, pt.y);
  await page.evaluate(`(async () => { ${PAGE} pump(2); return true; })()`);
}

/** Types text through real key events (char by char), then presses Enter. */
async function typeChat(page, text, send = true) {
  for (const ch of text) {
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: ch, text: ch, unmodifiedText: ch,
    });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
  }
  if (send) {
    await page.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
    });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  }
  await page.evaluate(`(async () => { ${PAGE} pump(2); return true; })()`);
}

/** Polls a page expression while pumping frames (headless has no rAF). */
async function poll(page, expr, ms = 60000) {
  return page.evaluate(`(async () => { ${PAGE} return await until(() => (${expr}), ${ms}); })()`);
}

try {
  // ------------------------------------------------------------------- host
  const host = await openPage(PORT, pageUrl('multiplayer', 'host', 'HostPilot'), DEBUG);
  const hostReady = await host.evaluate(`(async () => {
    ${PAGE}
    await until(() => window.__ieMP && R(), 60000);
    const mp = window.__ieMP;
    await mp.connect();
    await until(() => mp.online, 20000);
    await until(uiReady, 30000);
    return { online: mp.online, name: mp.npub.slice(0, 10) };
  })()`);
  check('host lobby online', hostReady.online, hostReady);

  // Create a CTF room: the host must land in the room menu, not the match.
  await clickRegion(host, 'dd:type');
  await clickRegion(host, 'opt:dd:type:0');
  await clickRegion(host, 'dd:level');
  await clickRegion(host, 'opt:dd:level:0');
  await clickRegion(host, 'create');
  await host.waitForUrl('#/room', 90000);
  const hostRoom = await host.evaluate(`(async () => {
    ${PAGE}
    const mp = window.__ieMP;
    await until(() => snap(), 30000);
    await until(() => snap().teams.length >= 2, 30000);
    const s = snap();
    return {
      hash: location.hash, title: s.title, level: s.level, teams: s.teams,
      players: s.players.map((p) => [p.name, p.host, p.team]), max: s.maxPlayers,
      isHost: s.isHost, meIndex: s.meIndex, phase: s.phase,
      route: window.__ieStore.route, scene: window.__ieStore.sceneKey,
    };
  })()`);
  step('host waiting in the room menu', hostRoom);
  check('room menu instead of the match', hostRoom.hash === '#/room' && hostRoom.route === 'room' && hostRoom.scene === 'background', hostRoom);
  check('ctf teams offered', hostRoom.teams.join(',') === 'team1,team2', hostRoom.teams);
  check('host is player 0', hostRoom.isHost && hostRoom.meIndex === 0 && hostRoom.players.length === 1);
  const roomId = await host.evaluate('window.__ieMP.hosting.id');
  const roomFs = await host.evaluate(`(async () => {
    ${PAGE}
    for (let i = 0; i < 20; i++) {
      pump(1);
      if (R().uiOverlay.regions.some((r) => r.id === 'fs')) return true;
      await sleep(40);
    }
    return false;
  })()`);
  check('room menu has the fullscreen button', roomFs === true);
  await host.screenshot(join(SHOTS, 'room-host-waiting.png'));

  // ------------------------------------------------------------------ guest
  const guest = await openPage(PORT, pageUrl('multiplayer', 'guest', 'WingPilot'), DEBUG);
  const found = await guest.evaluate(`(async () => {
    ${PAGE}
    await until(() => window.__ieMP && R(), 60000);
    const mp = window.__ieMP;
    await mp.connect();
    await until(() => mp.online, 20000);
    await until(uiReady, 30000);
    const key = await until(() => {
      const room = mp.rooms.find((x) => x.id === ${JSON.stringify(roomId)});
      if (!room) return null;
      const k = room.hostPubkey + ':' + room.id;
      return R().uiOverlay.regions.some((r) => r.id === 'join:' + k) ? k : null;
    }, 60000);
    return { key, srv: mp.rooms.find((x) => x.id === ${JSON.stringify(roomId)}).srv };
  })()`);
  check('guest sees the room listed as a browser host', found.srv === false, found);
  await clickRegion(guest, 'join:' + found.key);
  await guest.waitForUrl('#/room', 90000);
  const bothInRoom = await guest.evaluate(`(async () => {
    ${PAGE}
    const mp = window.__ieMP;
    await until(() => { const s = snap(); return s && s.players.length === 2; }, 30000);
    const s = snap();
    return {
      hash: location.hash, isHost: s.isHost, meIndex: s.meIndex, phase: s.phase,
      players: s.players.map((p) => [p.name, p.host || false, p.team || '']),
      teams: s.teams, level: s.level,
    };
  })()`);
  step('guest waiting in the same room menu', bothInRoom);
  check('guest not in the match', bothInRoom.hash === '#/room' && bothInRoom.meIndex === 1, bothInRoom);
  check('roster mirrored to the guest', bothInRoom.players.length === 2 && bothInRoom.players[1][0] === 'WingPilot');
  // The level's bots are part of the roster on both clients (read-only rows).
  const hostBots = await host.evaluate(`(async () => { ${PAGE} const s = snap(); return s.bots.map((b) => b.name).join(','); })()`);
  const guestBots = await guest.evaluate(`(async () => { ${PAGE} const s = snap(); return s.bots.map((b) => b.name).join(','); })()`);
  check('level bots are listed in the room', hostBots.length > 0 && guestBots === hostBots, {
    count: hostBots.split(',').length,
  });
  await poll(host, `snap() && snap().players.length === 2`, 30000);
  await host.screenshot(join(SHOTS, 'room-host-two-players.png'));
  await guest.screenshot(join(SHOTS, 'room-guest-two-players.png'));

  // -------------------------------------------------------------- roster UI
  // The shared roster filter starts on Team 1; the checks below move players
  // between teams, so show every team first.
  check('room roster filter defaults to team1', await host.evaluate(`(async () => { ${PAGE}
    return R().uiOverlay.teamFilter === 'team1'; })()`));
  await clickRegion(host, 'filter:all');

  // ------------------------------------------------------------------- chat
  await clickRegion(guest, 'chat');
  await typeChat(guest, 'hello from the guest');
  const hostChat = await poll(host, `snap() && snap().chat.some((c) => c.text === 'hello from the guest' && c.from === 'WingPilot')`, 30000);
  check('guest chat reached the host over WebRTC', hostChat === true);
  const guestEcho = await poll(guest, `snap() && snap().chat.some((c) => c.text === 'hello from the guest')`, 30000);
  check('chat echoed back to the guest', guestEcho === true);

  // ------------------------------------------------------------------ teams
  await clickRegion(host, 'team:0');
  await clickRegion(host, 'opt:team:0:team2');
  const guestSees = await poll(guest, `snap() && snap().players[0].team === 'team2'`, 30000);
  check('host team pick reaches the guest', guestSees === true);
  await clickRegion(host, 'team:1');
  await clickRegion(host, 'opt:team:1:team1');
  const guestHuman = await poll(guest, `snap() && snap().players[1].team === 'team1'`, 30000);
  check('host assigned the guest team human', guestHuman === true);
  // A guest may change its own team but cannot edit the host's row (the row's
  // picker is not even registered as a clickable region).
  const guestHostRow = await guest.evaluate(`(async () => { ${PAGE}
    return R().uiOverlay.regions.some((r) => r.id === 'team:0'); })()`);
  check('guest cannot open the host team picker', guestHostRow === false);
  await clickRegion(guest, 'team:1');
  await clickRegion(guest, 'opt:team:1:team2');
  const ownTeam = await poll(host, `snap() && snap().players[1].team === 'team2'`, 30000);
  check('guest changed its own team (host sees it)', ownTeam === true);
  // Put the guest back on human for the match check below.
  await clickRegion(host, 'team:1');
  await clickRegion(host, 'opt:team:1:team1');
  await poll(guest, `snap() && snap().players[1].team === 'team1'`, 30000);
  const guestState = await guest.evaluate(`(async () => { ${PAGE} const s = snap();
    return { teams: s.players.map((p) => [p.name, p.team]), me: s.meIndex }; })()`);
  step('teams in the room', guestState);

  // ---------------------------------------------------------------- the mic
  await guest.evaluate(`(async () => { ${PAGE}
    const mp = window.__ieMP;
    window.__dbg = { send: 0 };
    const orig = mp.sendVoice.bind(mp);
    mp.sendVoice = (pcm) => { window.__dbg.send++; window.__dbg.lastLen = pcm.length; return orig(pcm); };
    return true; })()`);
  await host.evaluate(`(async () => { ${PAGE}
    const mp = window.__ieMP;
    window.__dbg = { raw: 0, voice: 0 };
    for (const link of mp.links.values()) {
      const t = link.transport;
      const orig = t.onmessage;
      if (!orig) continue;
      t.onmessage = (d) => { window.__dbg.raw++; return orig(d); };
    }
    const prev = mp.onVoice;
    mp.onVoice = (s, p) => { window.__dbg.voice++; if (prev) prev(s, p); };
    return true; })()`);
  await clickRegion(guest, 'mic');
  const micOn = await poll(guest, `window.__ieMP.roomSnapshot().micOn === true`, 20000)
    .then(() => true).catch(() => false);
  check('guest microphone toggled on (fake device)', micOn);
  const hostSeesMic = await poll(host, `snap() && snap().players.some((p) => p.mic && p.name === 'WingPilot')`, 20000);
  check('host roster shows the guest is talking', hostSeesMic === true);
  const voiceFrames = await host.evaluate(`(async () => {
    ${PAGE}
    await until(() => window.__dbg.voice > 0, 30000);
    return window.__dbg.voice;
  })()`).catch(() => 0);
  const dbg = await guest.evaluate('window.__dbg').catch(() => null);
  const hostDbg = await host.evaluate('window.__dbg').catch(() => null);
  step('voice frames over WebRTC', { sent: dbg && dbg.send, received: voiceFrames, raw: hostDbg && hostDbg.raw });
  check('voice PCM reached the host', voiceFrames > 0 && dbg && dbg.send > 0, { voiceFrames, dbg, hostDbg });

  // ------------------------------------------------------------------- play
  await host.screenshot(join(SHOTS, 'room-before-play.png'));
  await clickRegion(host, 'play');
  await host.waitForUrl('#/game/', 90000);
  await guest.waitForUrl('#/game/', 90000);
  step('both left the room for the match', { host: '#/game/', guest: '#/game/' });

  const hostMatch = await poll(host, `window.__ieGame && window.__ieMP.sessionActive && window.__ieGame.gameType !== 'BACK' && window.__ieGame.selectedObject`, 120000).then(() => true).catch(() => false);
  const hostInfo = await host.evaluate(`(async () => {
    ${PAGE}
    pump(4, 100);
    const gi = window.__ieGame;
    return {
      levelKey: gi ? gi.levelKey : null, gameType: gi ? gi.gameType : null,
      hostTeam: gi && gi.selectedObject ? gi.selectedObject.team.name : null,
      guests: window.__ieMP.debugGuests(),
    };
  })()`);
  step('host match started by PLAY', hostInfo);
  check('host is in the match', hostMatch && hostInfo.hostTeam === 'team2', hostInfo);
  check('host session streams to one guest', hostInfo.guests.length === 1 && hostInfo.guests[0].joined, hostInfo.guests);

  const guestMatch = await poll(guest, `window.__ieGame && typeof window.__ieGame.rtt === 'number' && window.__ieGame.selectedObject`, 120000).then(() => true).catch(() => false);
  const guestInfo = await guest.evaluate(`(async () => {
    ${PAGE}
    pump(4);
    const g = window.__ieGame;
    return {
      isNet: typeof g.rtt === 'number', levelKey: g.levelKey,
      team: g.selectedObject ? g.selectedObject.team.name : null,
      teams: [...g.teams.values()].filter((t) => t.objects.length > 0).map((t) => [t.name, t.objects.length]),
      flags: g.flags ? g.flags.length : -1,
    };
  })()`);
  step('guest in the match', guestInfo);
  check('guest runs the render-only NetGame', guestMatch && guestInfo.isNet, guestInfo);
  check('guest flies the team picked in the room', guestInfo.team === 'team1', guestInfo.team);
  await host.screenshot(join(SHOTS, 'room-match-host.png'));
  await guest.screenshot(join(SHOTS, 'room-match-guest.png'));

  // The room's chat keeps working during the match (same data channels).
  await host.evaluate(`(async () => { ${PAGE} window.__ieMP.sendChat('good luck'); return true; })()`);
  const matchChat = await poll(guest, `window.__ieMP.roomSnapshot() && window.__ieMP.roomSnapshot().chat.some((c) => c.text === 'good luck')`, 30000)
    .then(() => true).catch(() => false);
  check('chat still relays during the match', matchChat);

  console.log('\nROOM E2E PASS', JSON.stringify(report.steps.map((s) => s[0])));
} catch (e) {
  console.error('\nROOM E2E FAIL:', e.message);
  process.exitCode = 1;
} finally {
  try { chrome.kill(); } catch { /* already gone */ }
  await sleep(200);
}
