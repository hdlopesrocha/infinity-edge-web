// Collision metadata for the C++ game server (`server/`).
//
//   node tools/sim-manifest.mjs
//
// The server owns the simulation but never renders, so it needs exactly the
// geometry the 37_T rules ask for and nothing else:
//
//   * `radius` — the merged bounding sphere used by `SpaceObject.setBoundingSphere`
//     (sphere-select collisions, the octree, the outsider rule),
//   * `meshes` — the per-mesh bounding spheres (centre + radius in model space)
//     that `Model3D.Intersects(Ray, Matrix, Model)` tests for bullets
//     (`SpaceObject.bulletHit` -> `rayIntersectModel` on solid[0] and color[0]),
//
// both read straight out of the converted `<Name>.json` files that the browser
// already loads. Keyed by asset file base (`AddonShield`), not by the game
// alias (`adShield`, see MODELS in src/game/config.ts): the server keeps the
// alias table and strips the `.json`.
//
// Output: public/assets/models/SIM.json

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const modelsDir = join(root, 'public/assets/models');
const out = join(modelsDir, 'SIM.json');

/** Alias -> asset file base, verbatim from src/game/config.ts (MODELS.directory). */
const MODELS = [
  ['Ark', 'Ark'], ['Asteroid1', 'Asteroid1'], ['Asteroid2', 'Asteroid2'],
  ['Asteroid3', 'Asteroid3'], ['Asteroid4', 'Asteroid4'], ['Base', 'Base'],
  ['Bullet', 'Bullet'], ['HomingMissile2', 'HomingMissile2'], ['Flag', 'Flag'],
  ['Wheel', 'Wheel'], ['Sky1', 'Sky1'], ['adRepair', 'AddonRepair'],
  ['adShield', 'AddonShield'], ['adNitro', 'AddonNitro'],
  ['adHomingMissile', 'AddonHomingMissile'], ['Fighter3', 'Fighter3'],
];

/**
 * Per-mesh bounding sphere, byte-for-byte the same rule the browser applies on
 * upload (`createGpuModel` -> `meshBounds`): min/max midpoint + max distance.
 * The converted JSONs carry the vertex positions inline, so this needs no
 * sidecar.
 */
function meshBounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  let radius = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const dx = positions[i] - center[0];
    const dy = positions[i + 1] - center[1];
    const dz = positions[i + 2] - center[2];
    const d = Math.hypot(dx, dy, dz);
    if (d > radius) radius = d;
  }
  return { c: center, r: radius };
}

function readModel(file) {
  const path = join(modelsDir, file);
  if (!existsSync(path)) return null;
  const d = JSON.parse(readFileSync(path, 'utf8'));
  return {
    radius: d.boundingSphere?.radius ?? 1,
    meshes: (d.meshes ?? []).map((m) => ({
      ...(m.bounds ? { c: m.bounds.center, r: m.bounds.radius } : {}),
      ...(m.positions ? meshBounds(m.positions) : { c: [0, 0, 0], r: 1 }),
      material: m.material ?? '',
    })),
  };
}

const files = new Set(readdirSync(modelsDir));
const models = {};
const aliases = {};
for (const [alias, base] of MODELS) {
  const solidFile = `${base}.json`;
  const colorFile = `${base}_color.json`;
  if (!files.has(solidFile) && !files.has(colorFile)) continue;
  const solid = readModel(solidFile);
  const color = readModel(colorFile);
  // The loader falls back to whichever LOD exists first (RC.loadModel), so the
  // server mirrors that: a missing solid set means the color set is the one
  // both setBoundingSphere and bulletHit see.
  if (!solid && !color) continue;
  models[base] = { solid, color };
  aliases[alias] = base;
}

writeFileSync(
  out,
  JSON.stringify({ generator: 'tools/sim-manifest.mjs', aliases, models }, null, 1) + '\n',
);
console.log(
  `sim-manifest: ${Object.keys(models).length} models -> ${relative(root, out)} ` +
    `(${Object.values(models).reduce((n, m) => n + (m.solid?.meshes.length ?? 0) + (m.color?.meshes.length ?? 0), 0)} mesh spheres)`,
);
