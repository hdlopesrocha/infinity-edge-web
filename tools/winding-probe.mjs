// Wind-order experiment: capture the same 3D scene with CCW and CW front faces
// and report the mean luminance of each, to decide which winding the converted
// content actually needs (WebGL defaults to CCW front; the original content is
// authored for Direct3D/XNA's clockwise front faces).
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5173/#/game/ctf-easy';
const out = process.argv[3] ?? '/tmp/opencode';
const PORT = 9777;
const profile = join(tmpdir(), `ie-wind-${process.pid}`);
mkdirSync(profile, { recursive: true });

const proc = spawn(process.env.CHROME || 'google-chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
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
  return r.exceptionDetails ? { error: r.exceptionDetails.exception?.description } : r.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 800, height: 480, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await sleep(12000);

// Mean luminance of the frame, sampled on the GL drawing buffer (the app has
// preserveDrawingBuffer off, so read the pixels through a canvas copy).
const stats = async (label) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(out, `wind-${label}.png`), Buffer.from(data, 'base64'));
  const s = await evaluate(`new Promise((resolve) => {
    const src = document.querySelector('canvas');
    const c = document.createElement('canvas');
    c.width = 200; c.height = 120;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { sum += 0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2]; n++; }
    resolve({ mean: +(sum / n).toFixed(2) });
  })`);
  console.log(`${label.padEnd(20)} mean luminance ${s.mean}`);
  return s;
};

await stats('ccw-front(default)');
await evaluate(`document.querySelector('canvas').getContext('webgl2').frontFace(document.querySelector('canvas').getContext('webgl2').CW)`);
await sleep(1500);
await stats('cw-front');
await evaluate(`document.querySelector('canvas').getContext('webgl2').frontFace(document.querySelector('canvas').getContext('webgl2').CCW)`);
await sleep(1500);
await stats('ccw-front(again)');

ws.close();
proc.kill();
await sleep(400);
try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ }
process.exit(0);
