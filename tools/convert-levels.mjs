// Level.xml -> JSON converter (validates the embedded catalogue in
// src/game/levels.ts against the original XML).
// Usage: node tools/convert-levels.mjs
// Reads:  ../InfinityEdge3D/.../SinglePlayer/{TT,CTF}/.../Level.xml + Background.xml
// Writes: public/assets/levels/*.json + public/assets/levels/INDEX.json

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const contentDir = join(webRoot, '..', 'InfinityEdge3D', 'InfinityEdge', 'InfinityEdgeContent');
const outDir = join(webRoot, 'public', 'assets', 'levels');

function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : '';
}

function parseLevel(xml, rel) {
  const desc = xml.match(/<description\b[^>]*\/>/)?.[0] ?? '';
  const objects = [...xml.matchAll(/<object\b[^>]*\/>/g)].map((m) => {
    const t = m[0];
    return {
      team: attr(t, 'team'), type: attr(t, 'type'), model: attr(t, 'model'),
      position: attr(t, 'position'), name: attr(t, 'name'),
      life: attr(t, 'life'), amount: attr(t, 'amount') ? Number(attr(t, 'amount')) : undefined,
    };
  });
  const camara = xml.match(/<camara\b[^>]*\/>/)?.[0] ?? '';
  const actions = [...xml.matchAll(/<action\b[^>]*\/>/g)].map((m) => ({
    name: attr(m[0], 'name'), from: attr(m[0], 'from'), to: attr(m[0], 'to') || undefined,
  }));
  const goals = [...xml.matchAll(/<goals\b[^>]*>([\s\S]*?)<\/goals>/g)].map((m) => ({
    reward: attr(m[0], 'reward'),
    message: attr(m[0], 'message') || undefined,
    goals: [...m[1].matchAll(/<goal\b[^>]*\/>/g)].map((g) => ({
      name: attr(g[0], 'name'), value: attr(g[0], 'value') || undefined,
    })),
  }));
  return {
    source: rel,
    description: {
      type: attr(desc, 'type'), name: attr(desc, 'name'), save: attr(desc, 'save'),
      sky: attr(desc, 'sky'), size: Number(attr(desc, 'size')) || 2048, text: attr(desc, 'text'),
    },
    imports: [...xml.matchAll(/<import\b[^>]*\/>/g)].map((m) => attr(m[0], 'value')),
    importGhost: attr(xml.match(/<importGhost\b[^>]*\/>/)?.[0] ?? '', 'value') || undefined,
    objects,
    camara: { name: attr(camara, 'name'), value: attr(camara, 'value') },
    actions,
    goals,
  };
}

if (!existsSync(contentDir)) {
  console.error('convert-levels: content dir not found:', contentDir);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const index = [];
function walk(dir, rel) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const r = rel ? rel + '/' + f : f;
    if (statSync(p).isDirectory()) {
      walk(p, r);
    } else if (/^Level\.xml$/i.test(f) || /^Background\.xml$/i.test(f)) {
      const xml = readFileSync(p, 'utf8');
      const level = parseLevel(xml, r);
      const safe = r.replace(/\.xml$/i, '').replace(/[^a-z0-9]+/gi, '_') + '.json';
      writeFileSync(join(outDir, safe), JSON.stringify(level, null, 2) + '\n');
      index.push({ file: safe, source: r, type: level.description.type, objects: level.objects.length });
      console.log(`ok ${safe} (${level.description.type}, ${level.objects.length} objects)`);
    }
  }
}
walk(contentDir, '');
writeFileSync(join(outDir, 'INDEX.json'), JSON.stringify(index, null, 2) + '\n');
console.log(`\nconvert-levels: ${index.length} files`);
