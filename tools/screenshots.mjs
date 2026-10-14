// Headless-browser verification: drives the running dev/preview server with
// the Chrome DevTools Protocol and writes PNGs to tools/shots/.
//
//   npm run dev &            # or: npm run preview
//   node tools/screenshots.mjs [baseUrl] [--out dir] [--only name,name]
//
// It uses the system Chrome (no puppeteer dependency) via --remote-debugging-port
// and the built-in WebSocket client of Node >= 22. Console errors and uncaught
// exceptions are collected and printed so visual checks also cover JS health.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = (process.argv[2] && !process.argv[2].startsWith('--'))
  ? process.argv[2]
  : 'http://127.0.0.1:5173';

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const OUT = arg('--out', 'tools/shots');
const ONLY = arg('--only', '');
const PORT = Number(arg('--port', '9222'));
const EXTRA = Number(arg('--extra', '0'));

// route, settle time (ms), label
const SHOTS = [
  ['/', 400, 'boot'],
  ['/engine', 1200, 'engine'],
  ['/start', 1200, 'start'],
  ['/menu', 1500, 'menu'],
  ['/single-player', 1200, 'single-player'],
  ['/ctf', 1200, 'ctf-menu'],
  ['/tt', 1200, 'tt-menu'],
  ['/tt/easy', 1200, 'tt-easy'],
  ['/briefing/tt-easy-01', 1500, 'briefing'],
  ['/game/tt-easy-01', 3500, 'game-tt'],
  ['/game/ctf-easy', 6000, 'game-ctf'],
  ['/options', 1200, 'options'],
  ['/about', 1200, 'about'],
  ['/definitely-not-a-route', 800, 'unknown'],
];

const chrome = process.env.CHROME || 'google-chrome';
const profile = join(tmpdir(), `ie-shots-${process.pid}`);
mkdirSync(OUT, { recursive: true });

const proc = spawn(chrome, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu-sandbox',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--window-size=800,480', '--hide-scrollbars',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitJson(path, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${path}`);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('chrome did not start');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { res, rej } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) c.events.push(msg);
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

const targets = await waitJson('/json/list');
const page = targets.find((t) => t.type === 'page');
const cdp = await CDP.connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Log.enable');
await cdp.send('Network.enable');
await cdp.send('Emulation.setDeviceMetricsOverride',
  { width: 800, height: 480, deviceScaleFactor: 1, mobile: false });

const problems = [];
const since = () => { cdp.events.length = 0; };
const report = (label) => {
  for (const e of cdp.events) {
    if (e.method === 'Runtime.exceptionThrown') {
      problems.push(`${label}: ${e.params.exceptionDetails?.exception?.description ?? 'exception'}`);
    } else if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
      problems.push(`${label}: ${e.params.entry.text}`);
    } else if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
      problems.push(`${label}: ${e.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    } else if (e.method === 'Network.responseReceived' && e.params.response.status >= 400) {
      problems.push(`${label}: HTTP ${e.params.response.status} ${e.params.response.url}`);
    }
  }
};

const only = ONLY ? new Set(ONLY.split(',')) : null;
for (const [route, settle, label] of SHOTS) {
  if (only && !only.has(label)) continue;
  since();
  // Navigate through the address bar (hash change on its own does not reload),
  // exactly like a deep link / refresh would.
  await cdp.send('Page.navigate', { url: BASE + '/#' + route });
  await sleep(1200);
  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(settle + EXTRA);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `${label}.png`), Buffer.from(data, 'base64'));
  report(label);
  console.log(`shot ${label.padEnd(14)} #${route} -> ${OUT}/${label}.png`);
}

if (problems.length) {
  console.log('\npage problems:');
  for (const p of problems) console.log('  ' + p);
} else {
  console.log('\nno console errors or exceptions');
}

cdp.ws.close();
proc.kill();
await new Promise((r) => setTimeout(r, 500));
try {
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch { /* chrome may still hold the profile; harmless */ }
process.exit(problems.length ? 1 : 0);
