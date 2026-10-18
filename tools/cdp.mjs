// Shared headless-Chrome/CDP helpers for the multiplayer end-to-end tools.
//
// Headless tabs do not run requestAnimationFrame, so every page-side step
// drives frames by hand through renderer.onFrame(dt). Pages are created with
// Target.createTarget because headless Chrome accepts a single URL argument.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchChrome({ port = 9334, windowSize = '1000,620', profilePrefix = 'ie-e2e' } = {}) {
  const profile = join(tmpdir(), `${profilePrefix}-${process.pid}`);
  mkdirSync(profile, { recursive: true });
  const chrome = spawn(process.env.CHROME || 'google-chrome', [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required',
    `--window-size=${windowSize}`, '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });
  return { chrome, port, profile };
}

export async function browserVersion(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* wait */ }
    await sleep(250);
  }
  throw new Error('chrome did not start');
}

export async function listTargets(port) {
  return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
}

let cdpSeq = 0;

/** Minimal CDP client: send(method, params) -> whole message. */
export function connect(wsUrl, debug = false) {
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
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const page = {
    ws,
    send,
    async evaluate(expression, timeout = 240000) {
      const tag = ++cdpSeq;
      const t0 = Date.now();
      const msg = await Promise.race([
        send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
        sleep(timeout).then(() => ({ timeout: true })),
      ]);
      if (debug) console.log(`    [eval ${tag}] ${Date.now() - t0} ms`);
      if (msg.timeout) throw new Error('evaluate timed out (expr ' + tag + ')');
      const res = msg.result ?? {};
      if (res.exceptionDetails) {
        throw new Error('page error: ' + (res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails)));
      }
      return res.result?.value;
    },
    /** Saves a PNG of this page (visual evidence of the WebGL UI). */
    async screenshot(path) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      const data = shot.result?.data;
      if (!data) return false;
      const { writeFileSync } = await import('node:fs');
      writeFileSync(path, Buffer.from(data, 'base64'));
      return true;
    },
    /** Poll the page URL: never evaluate long scripts across a navigation. */
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

export async function openPage(port, url, debug = false) {
  const version = await browserVersion(port);
  const browser = await connect(version.webSocketDebuggerUrl, debug);
  const created = await browser.send('Target.createTarget', { url });
  const targetId = created.result?.targetId;
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    wsUrl = (await listTargets(port)).find((t) => t.id === targetId)?.webSocketDebuggerUrl ?? null;
    if (!wsUrl) await sleep(150);
  }
  if (!wsUrl) throw new Error('could not open a tab for ' + url);
  const page = await connect(wsUrl, debug);
  if (url !== 'about:blank') await page.waitForUrl(url.split('#')[1] ? '#' + url.split('#')[1] : 'http');
  return page;
}

/** Page-side helpers, prepended to every step. */
export const HELPERS = `
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
