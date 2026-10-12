// Copy UI/3D textures + sounds from the XNA content tree into public/assets.
// Sources: ../InfinityEdge3D/InfinityEdge/InfinityEdgeContent/{System,Control,Sounds}.
// Textures keep their alias names (<alias>.<ext>); the runtime probes .png
// then .jpg (see texture.ts loadTextureAny). Run: npm run copy:assets

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const content = join(
  webRoot, '..', 'InfinityEdge3D', 'InfinityEdge', 'InfinityEdgeContent',
);

const TEXTURE_ALIASES = {
  _menubtn: 'System/menubtn', _buttonLU: 'System/buttonLU', _buttonRU: 'System/buttonRU',
  _buttonLD: 'System/buttonLD', _buttonRD: 'System/buttonRD', _backGame: 'System/backGame',
  _aim: 'System/aim', _aim2: 'System/aim2', _flag: 'System/flag',
  _flare1: 'System/flare1', _flare2: 'System/flare2', _flare3: 'System/flare3',
  _gold: 'System/gold', _silver: 'System/silver', _bronze: 'System/bronze',
  _ball: 'System/ball', _backWindow: 'System/backWindow',
  _singlePlayer: 'System/singlePlayer', _multiPlayer: 'System/multiPlayer',
  _optionsIcon: 'System/options', _about: 'System/about', _back: 'System/back',
  _timeTrial: 'System/timeTrial', _challenge: 'System/challenge', _ctf: 'System/ctf',
  _hex: 'System/hex', _hex1: 'System/hex1', _easy: 'System/easy',
  _normal: 'System/normal', _hard: 'System/hard', _key: 'System/key',
  _over: 'System/over', _engineLogo: 'System/engineLogo', _gameLogo: 'System/logo',
  _arcade: 'System/arcade', _logo: 'System/logo',
  _backAnalog: 'Control/backAnalog', _stickAnalog: 'Control/stickAnalog',
  _fireButton: 'Control/fire', _fireButtonHM: 'Control/fireHM',
  _accelAnalog: 'Control/accelAnalog', _nitro: 'Control/nitro',
  _pixel: 'System/pixel',
};

function findFile(baseNoExt) {
  for (const ext of ['.png', '.jpg', '.jpeg', '.PNG', '.JPG']) {
    const p = join(content, baseNoExt + ext);
    if (existsSync(p)) return p;
  }
  // Bare name variants (engineLogo.png etc. sometimes differ in case).
  try {
    const dir = join(content, dirname(baseNoExt));
    const want = basename(baseNoExt).toLowerCase();
    for (const f of readdirSync(dir)) {
      if (f.toLowerCase().startsWith(want) && /\.(png|jpe?g)$/i.test(f)) {
        return join(dir, f);
      }
    }
  } catch { /* missing dir */ }
  return null;
}

import { basename } from 'node:path';

const texOut = join(webRoot, 'public', 'assets', 'textures');
mkdirSync(texOut, { recursive: true });

let copied = 0;
const missing = [];
for (const [alias, rel] of Object.entries(TEXTURE_ALIASES)) {
  const src = findFile(rel);
  if (!src) {
    missing.push(rel);
    continue;
  }
  const ext = src.slice(src.lastIndexOf('.')).toLowerCase();
  const normExt = ext === '.jpeg' ? '.jpg' : ext;
  copyFileSync(src, join(texOut, alias + normExt));
  // The runtime first probes `<alias>.png`; also provide that name when the
  // source is a jpg so hash-stable URLs keep working offline.
  if (normExt !== '.png') copyFileSync(src, join(texOut, alias + '.png'));
  copied++;
}

// 3D object diffuse textures (referenced by converted materials).
const objOut = join(webRoot, 'public', 'assets', 'textures', 'objects');
mkdirSync(objOut, { recursive: true });
try {
  const objectsDir = join(content, 'Objects');
  for (const folder of readdirSync(objectsDir)) {
    const dir = join(objectsDir, folder);
    let files = [];
    try {
      files = readdirSync(dir);
    } catch { continue; }
    for (const f of files) {
      if (/\.(png|jpe?g)$/i.test(f)) {
        copyFileSync(join(dir, f), join(objOut, `${folder}__${f}`));
        copied++;
      }
    }
  }
} catch { /* no objects dir */ }

// Sounds: all .wav + sound.mp3.
const sndOut = join(webRoot, 'public', 'assets', 'sounds');
mkdirSync(sndOut, { recursive: true });
try {
  for (const f of readdirSync(join(content, 'Sounds'))) {
    if (/\.(wav|mp3|wma)$/i.test(f)) {
      copyFileSync(join(content, 'Sounds', f), join(sndOut, f));
      copied++;
    }
  }
} catch { /* no sounds dir */ }
try {
  const mp3 = join(content, 'sound.mp3');
  if (existsSync(mp3)) {
    copyFileSync(mp3, join(sndOut, 'sound.mp3'));
    copied++;
  }
} catch { /* ignore */ }

console.log(`copy-assets: copied ${copied} files, missing ${missing.length}`);
if (missing.length) console.log('missing:', missing.join(', '));
