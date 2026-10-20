// Copy textures + sounds + icons (IE3D_37_T). Sanitized object filenames.
import { basename, dirname, join } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const content = (() => {
  const candidates = [
    join(webRoot, '..', 'IE3D_37_T', 'InfinityEdge3D', 'InfinityEdge', 'InfinityEdgeContent'),
    join(webRoot, '..', 'IE3D_37_T', 'InfinityEdge', 'InfinityEdgeContent'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0];
})();
const sanitize = (s) => s.replace(/[^a-zA-Z0-9_.-]/g, '_');

const TEXTURE_ALIASES = {
  _menubtn: 'System/menubtn', _buttonRU: 'System/buttonRU',
  _aim: 'System/aim',
  _flare1: 'System/flare1', _flare2: 'System/flare2',
  _gold: 'System/gold', _silver: 'System/silver', _bronze: 'System/bronze',
  _backWindow: 'System/backWindow',
  _singlePlayer: 'System/singlePlayer', _multiPlayer: 'System/multiPlayer',
  _optionsIcon: 'System/options', _about: 'System/about', _back: 'System/back',
  _timeTrial: 'System/timeTrial', _ctf: 'System/ctf',
  _easy: 'System/easy',
  _normal: 'System/normal', _hard: 'System/hard', _key: 'System/key',
  _over: 'System/over', _engineLogo: 'System/engineLogo', _gameLogo: 'System/logo',
  _hexagon: 'System/hexagon',

  _backAnalog: 'Control/backAnalog', _stickAnalog: 'Control/stickAnalog',
  _fireButton: 'Control/fire', _fireButtonHM: 'Control/fireHM',
  _accelAnalog: 'Control/accelAnalog', _nitro: 'Control/nitro',
  _pixel: 'System/pixel',
};

// The UI is built in Vue/CSS, so the original's unused menu-sprite leftovers
// (arcade/challenge/hex/hex1/aim2/flag/flare3/corner buttons/backGame) are
// never drawn and no longer copied; see the SKIP note in tools/convert-xnb.mjs
// for the model side of the same cleanup. The multiplayer icon is still used
// by the main menu.
const SKIP_FOLDERS = new Set([
  'Fighter1', 'Fighter2', 'HomingMissile',
  'Planet1', 'Planet2', 'Planet3',
  'AddonMultiply2', 'AddonTime',
]);

function findFile(baseNoExt) {
  for (const ext of ['.png', '.jpg', '.jpeg', '.PNG', '.JPG']) {
    const p = join(content, baseNoExt + ext);
    if (existsSync(p)) return p;
  }
  try {
    const dir = join(content, dirname(baseNoExt));
    const want = basename(baseNoExt).toLowerCase();
    for (const f of readdirSync(dir)) {
      if (f.toLowerCase().startsWith(want) && /\.(png|jpe?g)$/i.test(f)) return join(dir, f);
    }
  } catch { /* missing */ }
  return null;
}

const texOut = join(webRoot, 'public', 'assets', 'textures');
mkdirSync(texOut, { recursive: true });
let copied = 0;
const missing = [];
for (const [alias, rel] of Object.entries(TEXTURE_ALIASES)) {
  const src = findFile(rel);
  if (!src) { missing.push(rel); continue; }
  const ext = src.slice(src.lastIndexOf('.')).toLowerCase();
  const normExt = ext === '.jpeg' ? '.jpg' : ext;
  copyFileSync(src, join(texOut, alias + normExt));
  if (normExt !== '.png') copyFileSync(src, join(texOut, alias + '.png'));
  copied++;
}

const objOut = join(texOut, 'objects');
mkdirSync(objOut, { recursive: true });
try {
  for (const folder of readdirSync(join(content, 'Objects'))) {
    if (SKIP_FOLDERS.has(folder)) continue;
    const dir = join(content, 'Objects', folder);
    let files = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!/\.(png|jpe?g)$/i.test(f)) continue;
      // Icons: the loader resolves them as assets/textures/<model>_icon.png,
      // so only the top-level copy is shipped (the objects/<model>__icon.png
      // duplicate is dead weight).
      if (/^icon\./i.test(f)) {
        copyFileSync(join(dir, f), join(texOut, `${folder}_icon.png`));
      } else {
        copyFileSync(join(dir, f), join(objOut, sanitize(`${folder}__${f}`)));
      }
      copied++;
    }
  }
} catch { /* none */ }

const sndOut = join(webRoot, 'public', 'assets', 'sounds');
mkdirSync(sndOut, { recursive: true });
// The 2013 cues are uncompressed PCM WAVs (44.1 kHz stereo, 1.4 Mbps): 8.5 MB
// for the 25 of them. The port fetches + decodes them with the Web Audio API,
// so they are transcoded to MP3 (~0.5 MB, 6% of the source) on the way in.
// ffmpeg is required for that step; existing MP3s are copied as-is.
try {
  const haveFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  for (const f of readdirSync(join(content, 'Sounds'))) {
    const src = join(content, 'Sounds', f);
    if (/\.mp3$/i.test(f)) {
      copyFileSync(src, join(sndOut, sanitize(f)));
      copied++;
    } else if (/\.wav$/i.test(f)) {
      const out = join(sndOut, sanitize(f.replace(/\.wav$/i, '.mp3')));
      if (!haveFfmpeg) {
        missing.push(`${f} (ffmpeg not found)`);
        continue;
      }
      const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-codec:a', 'libmp3lame', '-q:a', '5', out]);
      if (r.status !== 0) missing.push(f);
      else copied++;
    }
  }
} catch { /* none */ }
try {
  const mp3 = join(content, 'sound.mp3');
  if (existsSync(mp3)) { copyFileSync(mp3, join(sndOut, 'sound.mp3')); copied++; }
} catch { /* ignore */ }

// App icons: the original XNA project's favicon + the WP7 tile art (ico62/ico173),
// used for the browser tab / home-screen icon.
try {
  const pub = join(webRoot, 'public');
  const iconDirs = [
    join(content, '..', 'InfinityEdge'),
    join(content, '..'),
    dirname(content),
  ];
  const icons = [['favicon.ico', 'favicon.ico'], ['ico173.png', 'apple-touch-icon.png']];
  for (const [from, to] of icons) {
    const p = iconDirs.map((d) => join(d, from)).find((c) => existsSync(c));
    if (p) { copyFileSync(p, join(pub, to)); copied++; }
    else missing.push(from);
  }
} catch { /* ignore */ }

console.log(`copy-assets: copied ${copied} files, missing ${missing.length}`);
if (missing.length) console.log('missing:', missing.join(', '));
