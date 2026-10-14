// Write a manifest of the copied texture files so the loader never requests a
// candidate that does not exist (the preload used to probe name.png / name.jpg /
// _name.png / _name.jpg for every alias and logged four 404s each).
//
//   node tools/asset-manifest.mjs
//
// The output is `public/assets/textures/MANIFEST.json`:
//   { "generator": "...", "files": ["_flare1.png", "objects/Fighter3__metal.jpg", ...] }
// Paths are relative to `assets/textures/`, exactly as the alias resolution and
// the model material references use them.

import { readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = process.cwd();
const texDir = join(root, 'public/assets/textures');
const out = join(texDir, 'MANIFEST.json');

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) files.push(...walk(p));
    else files.push(relative(texDir, p).split(sep).join('/'));
  }
  return files;
}

const files = walk(texDir).filter((f) => f !== 'MANIFEST.json').sort();
mkdirSync(texDir, { recursive: true });
writeFileSync(
  out,
  JSON.stringify({ generator: 'tools/asset-manifest.mjs', files }, null, 1) + '\n',
);
console.log(`asset-manifest: ${files.length} texture files -> ${relative(root, out)}`);
