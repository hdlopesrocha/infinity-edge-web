// Level.xml -> JSON (IE3D_37_T). Comment-stripped; paired/self-closing description.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
function findContentDir() {
  const candidates = [
    join(webRoot, '..', 'IE3D_37_T', 'InfinityEdge3D', 'InfinityEdge', 'InfinityEdgeContent'),
    join(webRoot, '..', 'IE3D_37_T', 'InfinityEdge', 'InfinityEdgeContent'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0];
}
const contentDir = findContentDir();
const outDir = join(webRoot, 'public', 'assets', 'levels');

const attr = (tag, name) => (tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`)) || [])[1] ?? '';

function parseLevel(xml, rel) {
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
      name: a('reference') || a('name') || undefined, life: a('life') || undefined,
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
      // Sibling Menu.xml textBox text is the briefing description.
      try {
        const menuPath = join(dir, f.replace(/Level\.xml$/i, 'Menu.xml'));
        if (existsSync(menuPath)) {
          let menuXml = readFileSync(menuPath, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
          const tb = menuXml.match(/<textBox\b[^>]*\btext="([^"]*)"/);
          level.menuText = tb ? tb[1] : '';
          const sb = menuXml.match(/<scoreBoard\b[^>]*\/>/);
          if (sb) {
            level.scoreBoard = { type: attr(sb[0], 'type'), save: attr(sb[0], 'save') };
          }
        }
      } catch { /* no menu */ }
      const safe = r.replace(/\.xml$/i, '').replace(/[^a-z0-9]+/gi, '_') + '.json';
      writeFileSync(join(outDir, safe), JSON.stringify(level, null, 2) + '\n');
      index.push({ file: safe, source: r, type: level.description.type, objects: level.objects.length });
      console.log(`ok ${safe} (${level.description.type}, ${level.objects.length} objects)`);
    }
  }
})(contentDir, '');
writeFileSync(join(outDir, 'INDEX.json'), JSON.stringify(index, null, 2) + '\n');
console.log(`\nconvert-levels: ${index.length} files`);
