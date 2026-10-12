// Level.xml -> JSON converter (documents the <game> schema; the app embeds
// the same data in src/game/levels.ts and validates against these files).
// Usage: node tools/convert-levels.mjs
// Reads:  ../InfinityEdge3D/.../SinglePlayer/**/Level.xml + Background.xml
// Writes: public/assets/levels/*.json + INDEX.json

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const contentDir = join(webRoot, '..', 'InfinityEdge3D', 'InfinityEdge', 'InfinityEdgeContent');
const outDir = join(webRoot, 'public', 'assets', 'levels');

const attr = (tag, name) => (tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`)) || [])[1] ?? '';

function parseLevel(xml, rel) {
  // Strip XML comments first: commented-out objects/actions must not parse
  // (e.g. TT Easy 01 contains a commented ambient ship with 1000|1000|1000 life).
  xml = xml.replace(/<!--[\s\S]*?-->/g, '');
  let descTag = xml.match(/<description\b[^>]*\/>/)?.[0] ?? '';
  let innerText = '';
  if (!descTag) {
    const m = xml.match(/<description\b([^>]*)>([^<]*)<\/description>/);
    if (m) {
      descTag = '<description' + m[1] + '/>';
      innerText = m[2].trim();
    }
  }
  const objects = [...xml.matchAll(/<object\b[^>]*\/>/g)].map((m) => {
    const t = m[0], a = (n) => attr(t, n);
    const amount = a('amount');
    return {
      team: a('team'), type: a('type'), model: a('model'), position: a('position'),
      name: a('name') || undefined, life: a('life') || undefined,
      amount: amount ? Number(amount) : undefined,
    };
  });
  const camara = xml.match(/<camara\b[^>]*\/>/)?.[0] ?? '';
  const actions = [...xml.matchAll(/<action\b[^>]*\/>/g)].map((m) => ({
    name: attr(m[0], 'name'), from: attr(m[0], 'from'), to: attr(m[0], 'to') || undefined,
  }));
  const goals = [...xml.matchAll(/<goals\b[^>]*>([\s\S]*?)<\/goals>/g)].map((m) => ({
    reward: attr(m[0], 'reward'), message: attr(m[0], 'message') || undefined,
    goals: [...m[1].matchAll(/<goal\b[^>]*\/>/g)].map((g) => ({
      name: attr(g[0], 'name'), value: attr(g[0], 'value') || undefined,
    })),
  }));
  const ghost = xml.match(/<importGhost\b[^>]*\/>/)?.[0] ?? '';
  return {
    source: rel,
    description: {
      type: attr(descTag, 'type'), name: attr(descTag, 'name'), save: attr(descTag, 'save'),
      sky: attr(descTag, 'sky'), size: Number(attr(descTag, 'size')) || 2048,
      text: attr(descTag, 'text') || innerText,
    },
    imports: [...xml.matchAll(/<import\b[^>]*\/>/g)].map((m) => attr(m[0], 'value')),
    importGhost: attr(ghost, 'value') || undefined,
    objects, camara: { name: attr(camara, 'name'), value: attr(camara, 'value') },
    actions, goals,
  };
}

if (!existsSync(contentDir)) {
  console.error('convert-levels: content dir not found:', contentDir);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const index = [];
(function walk(dir, rel) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f), r = rel ? rel + '/' + f : f;
    if (statSync(p).isDirectory()) walk(p, r);
    else if (/^(Level|Background)\.xml$/i.test(f)) {
      const level = parseLevel(readFileSync(p, 'utf8'), r);
      const safe = r.replace(/\.xml$/i, '').replace(/[^a-z0-9]+/gi, '_') + '.json';
      writeFileSync(join(outDir, safe), JSON.stringify(level, null, 2) + '\n');
      index.push({ file: safe, source: r, type: level.description.type, objects: level.objects.length });
      console.log(`ok ${safe} (${level.description.type}, ${level.objects.length} objects)`);
    }
  }
})(contentDir, '');
writeFileSync(join(outDir, 'INDEX.json'), JSON.stringify(index, null, 2) + '\n');
console.log(`\nconvert-levels: ${index.length} files`);
