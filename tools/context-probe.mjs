// Focused context-loss probe: counts events, records whether the renderer
// rebuilt its GL objects (new Draw + scene rebuild) after a forced loss.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5173/#/game/tt-easy-01';
const PORT = 9666;
const profile = join(tmpdir(), `ie-ctx-${process.pid}`);
mkdirSync(profile, { recursive: true });

const proc = spawn(process.env.CHROME || 'google-chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--window-size=800,480', 'about:blank',
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
  throw new Error('no chrome');
}
const page = (await list()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 20000 });
  if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description };
  return r.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url });
await sleep(6000);

await evaluate(`(() => {
  window.__ctxLog = [];
  const c = document.querySelector('canvas');
  c.addEventListener('webglcontextlost', () => { window.__ctxLog.push('lost'); });
  c.addEventListener('webglcontextrestored', () => { window.__ctxLog.push('restored'); });
  window.__draw0 = window.__ieRenderer.draw;
  window.__scene0 = window.__ieGame?.map?.visible?.length ?? -1;
  return true;
})()`);

console.log('before :', JSON.stringify(await evaluate(`({
  lost: document.querySelector('canvas').getContext('webgl2').isContextLost(),
  fps: window.__ieRenderer.stats.fps, drawn: window.__ieRenderer.stats.draws,
  supportsExtension: !!document.querySelector('canvas').getContext('webgl2').getExtension('WEBGL_lose_context'),
})`)));

// Keep the extension object: it is invalidated while the context is lost, so
// restoreContext() has to be called on the instance captured beforehand.
console.log('losing :', JSON.stringify(await evaluate(`(() => {
  const gl = document.querySelector('canvas').getContext('webgl2');
  window.__loseExt = gl.getExtension('WEBGL_lose_context');
  window.__loseExt.loseContext();
  return gl.isContextLost();
})()`)));

for (let i = 0; i < 8; i++) {
  await sleep(1500);
  const state = await evaluate(`(() => {
    const gl = document.querySelector('canvas').getContext('webgl2');
    return {
      log: window.__ctxLog.slice(),
      lost: gl.isContextLost(),
      sameDraw: window.__ieRenderer.draw === window.__draw0,
      fps: window.__ieRenderer.stats.fps,
      drawn: window.__ieRenderer.stats.draws,
      vis: window.__ieGame?.map?.visible?.length,
      rebuilt: window.__ieGame?.map?.visible?.length !== window.__scene0,
    };
  })()`);
  console.log(`${(i + 1) * 1.5}s   :`, JSON.stringify(state));
  if (i === 2) {
    console.log('restore:', JSON.stringify(await evaluate(`(() => {
      window.__loseExt.restoreContext();
      return { called: true };
    })()`)));
  }
}
ws.close();
proc.kill();
await sleep(400);
try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ }
process.exit(0);
