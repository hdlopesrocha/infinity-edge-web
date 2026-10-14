// Ad-hoc CDP probe: navigate, then evaluate JS in the page.
//   node tools/probe.mjs <url> <jsExpression> [waitMs]
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2];
const expr = process.argv[3] ?? '1';
const wait = Number(process.argv[4] ?? '3000');
const PORT = 9333;
const profile = join(tmpdir(), `ie-probe-${process.pid}`);
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

const targets = await list();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
const logs = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  } else if (msg.method === 'Log.entryAdded' || msg.method === 'Runtime.consoleAPICalled') {
    logs.push(JSON.stringify(msg.params).slice(0, 400));
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Page.navigate', { url });
await sleep(wait);
const out = await send('Runtime.evaluate', {
  expression: expr, awaitPromise: true, returnByValue: true,
});
console.log(JSON.stringify(out.result?.value ?? out.result, null, 2));
if (logs.length) console.log('--- logs ---\n' + logs.slice(-10).join('\n'));
ws.close();
proc.kill();
await sleep(400);
try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ }
process.exit(0);
