// Poll a page expression over time and report when the main thread stalls.
//   node tools/hangprobe.mjs <url> <expression> [totalMs] [stepMs]
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2];
const expr = process.argv[3] ?? 'window.__ieRenderer?.frame';
const total = Number(process.argv[4] ?? '20000');
const step = Number(process.argv[5] ?? '1000');
const PORT = 9444;
const profile = join(tmpdir(), `ie-hang-${process.pid}`);
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

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url });
const t0 = Date.now();
let last = null;
while (Date.now() - t0 < total) {
  const at = Math.round((Date.now() - t0) / 100) / 10;
  try {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, returnByValue: true, timeout: 2000 }),
      sleep(2500).then(() => ({ __timeout: true })),
    ]);
    if (r.__timeout) { console.log(`${at}s  STALL (evaluate did not answer in 2.5 s)`); break; }
    const v = r.result?.value ?? r.exceptionDetails?.exception?.description;
    console.log(`${at}s  ${JSON.stringify(v)}`);
    last = v;
  } catch (e) {
    console.log(`${at}s  ERR ${String(e).slice(0, 160)}`);
  }
  await sleep(step);
}
console.log('last =', JSON.stringify(last));
ws.close();
proc.kill();
await sleep(400);
try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ }
process.exit(0);
