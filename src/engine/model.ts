// Converted-model JSON format + GPU loader + validation + ray intersect.
// Format: tools/convert-fbx.mjs output. Single LOD per file; detail LODs in
// sibling <Alias>_lod<N>.json files.

import { mat4, quat, vec3 } from './math';

export interface ConvertedMesh {
  name: string;
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
  material?: string;
  localMatrix?: number[];
}

export interface ConvertedMaterial {
  name: string;
  diffuse: [number, number, number];
  emissive: [number, number, number];
  specular: [number, number, number];
  shininess: number;
  alpha: number;
  texture?: string;
}

export interface ConvertedModel {
  version: 1;
  source: string;
  generator: string;
  upAxis: 'Y' | 'Z';
  units: string;
  boundingSphere: { center: [number, number, number]; radius: number };
  boundingBox: { min: [number, number, number]; max: [number, number, number] };
  meshes: ConvertedMesh[];
  materials: ConvertedMaterial[];
  nodes?: { name: string; parent: string | null; matrix: number[] }[];
}

export interface GpuMesh {
  vao: WebGLVertexArrayObject | null;
  vbo: WebGLBuffer | null;
  nbo: WebGLBuffer | null;
  uvbo: WebGLBuffer | null;
  ibo: WebGLBuffer | null;
  indexCount: number;
  indexType: number; // UNSIGNED_SHORT / UNSIGNED_INT
  materialIndex: number;
  /** CPU copies for ray-mesh tests (BulletHit). */
  positions: Float32Array;
  indices: Uint16Array | Uint32Array;
  bounds: { center: vec3; radius: number };
}

export interface GpuModel {
  meshes: GpuMesh[];
  materials: ConvertedMaterial[];
  boundingSphere: { center: vec3; radius: number };
  boundingBox: { min: vec3; max: vec3 };
  source: string;
}

const cache = new Map<string, GpuModel>();
const pending = new Map<string, Promise<GpuModel>>();

export function validateModel(m: unknown): asserts m is ConvertedModel {
  const mm = m as ConvertedModel;
  if (!mm || typeof mm !== 'object') throw new Error('Model JSON is not an object');
  if (mm.version !== 1) throw new Error('Unsupported model version');
  if (!Array.isArray(mm.meshes) || mm.meshes.length === 0)
    throw new Error('Model has no meshes: ' + (mm as { source?: string }).source);
  for (const mesh of mm.meshes) {
    if (!Array.isArray(mesh.positions) || mesh.positions.length % 3 !== 0)
      throw new Error(`Mesh ${mesh.name}: bad positions`);
    if (!Array.isArray(mesh.indices) || mesh.indices.length % 3 !== 0)
      throw new Error(`Mesh ${mesh.name}: bad indices`);
    if (mesh.normals.length !== 0 && mesh.normals.length !== mesh.positions.length)
      throw new Error(`Mesh ${mesh.name}: normals length mismatch`);
    if (mesh.uvs.length !== 0 && mesh.uvs.length !== (mesh.positions.length / 3) * 2)
      throw new Error(`Mesh ${mesh.name}: uv length mismatch`);
  }
  if (!mm.boundingSphere || typeof mm.boundingSphere.radius !== 'number')
    throw new Error('Model missing boundingSphere');
}

function meshBounds(positions: Float32Array): { center: vec3; radius: number } {
  const min = vec3.fromValues(Infinity, Infinity, Infinity);
  const max = vec3.fromValues(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  const center = vec3.create();
  vec3.add(center, min, max);
  vec3.scale(center, center, 0.5);
  let radius = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const dx = positions[i] - center[0];
    const dy = positions[i + 1] - center[1];
    const dz = positions[i + 2] - center[2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > radius) radius = d;
  }
  return { center, radius };
}

function ensureNormals(mesh: ConvertedMesh): Float32Array {
  if (mesh.normals.length === mesh.positions.length) return new Float32Array(mesh.normals);
  const acc = new Float32Array(mesh.positions.length);
  const p = mesh.positions, idx = mesh.indices;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const abx = p[b] - p[a], aby = p[b + 1] - p[a + 1], abz = p[b + 2] - p[a + 2];
    const acx = p[c] - p[a], acy = p[c + 1] - p[a + 1], acz = p[c + 2] - p[a + 2];
    let nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    acc[a] += nx; acc[a + 1] += ny; acc[a + 2] += nz;
    acc[b] += nx; acc[b + 1] += ny; acc[b + 2] += nz;
    acc[c] += nx; acc[c + 1] += ny; acc[c + 2] += nz;
  }
  const n = mesh.positions.length / 3;
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(acc[i * 3], acc[i * 3 + 1], acc[i * 3 + 2]) || 1;
    acc[i * 3] /= l; acc[i * 3 + 1] /= l; acc[i * 3 + 2] /= l;
  }
  return acc;
}

export function createGpuModel(gl: WebGL2RenderingContext, data: ConvertedModel): GpuModel {
  validateModel(data);
  const matIndex = new Map(data.materials.map((m, i) => [m.name, i]));
  const meshes: GpuMesh[] = data.meshes.map((mesh) => {
    const pos = new Float32Array(mesh.positions);
    const nor = ensureNormals(mesh);
    const nv = mesh.positions.length / 3;
    const uv = mesh.uvs.length === nv * 2 ? new Float32Array(mesh.uvs) : new Float32Array(nv * 2);
    const idx = mesh.indices.length > 65535 ? new Uint32Array(mesh.indices) : new Uint16Array(mesh.indices);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const nbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, nbo);
    gl.bufferData(gl.ARRAY_BUFFER, nor, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    const uvbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uvbo);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return {
      vao, vbo, nbo, uvbo, ibo,
      indexCount: mesh.indices.length,
      indexType: idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
      materialIndex: mesh.material ? (matIndex.get(mesh.material) ?? 0) : 0,
      positions: pos, indices: idx, bounds: meshBounds(pos),
    };
  });
  const sphere = {
    center: vec3.fromValues(...data.boundingSphere.center),
    radius: data.boundingSphere.radius,
  };
  const box = {
    min: vec3.fromValues(...data.boundingBox.min),
    max: vec3.fromValues(...data.boundingBox.max),
  };
  return { meshes, materials: data.materials, boundingSphere: sphere, boundingBox: box, source: data.source };
}

export async function loadModel(gl: WebGL2RenderingContext, url: string): Promise<GpuModel> {
  const hit = cache.get(url);
  if (hit) return hit;
  const p = pending.get(url);
  if (p) return p;
  const job = (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const gpu = createGpuModel(gl, (await res.json()) as ConvertedModel);
      cache.set(url, gpu);
      return gpu;
    } catch {
      const gpu = createGpuModel(gl, proceduralFallback(url));
      cache.set(url, gpu);
      return gpu;
    }
  })();
  pending.set(url, job);
  job.finally(() => pending.delete(url));
  return job;
}

export function disposeModel(gl: WebGL2RenderingContext, url: string): void {
  const m = cache.get(url);
  if (!m) return;
  for (const mesh of m.meshes) {
    gl.deleteBuffer(mesh.vbo);
    gl.deleteBuffer(mesh.nbo);
    gl.deleteBuffer(mesh.uvbo);
    gl.deleteBuffer(mesh.ibo);
    gl.deleteVertexArray(mesh.vao);
  }
  cache.delete(url);
}

// --- Ray vs model (Model3D.Intersects port for BulletHit) ---
// Tests per-mesh world spheres first, then triangles (Möller–Trumbore).
// Returns nearest distance along the ray, or null.

const _e1 = new Float32Array(3);
const _e2 = new Float32Array(3);
const _tv = new Float32Array(3);

function rayTri(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  ax: number, ay: number, az: number, bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number | null {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-9 && det < 1e-9) return null;
  const inv = 1 / det;
  const tx = ox - ax, ty = oy - ay, tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return null;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > 1e-9 ? t : null;
}

/** Ray (origin, dir normalized) vs model under world matrix. */
export function rayIntersectModel(
  model: GpuModel,
  world: mat4,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
): number | null {
  // Transform ray to model space once per mesh via inverse matrix.
  const inv = mat4.create();
  mat4.invert(inv, world);
  const im = inv as unknown as Float32Array;
  // origin (w=1) and direction (w=0) transform
  let best: number | null = null;
  void _e1; void _e2; void _tv;
  for (const mesh of model.meshes) {
    // world-space coarse sphere test
    const c = mesh.bounds.center;
    const wx = world[0] * c[0] + world[4] * c[1] + world[8] * c[2] + world[12];
    const wy = world[1] * c[0] + world[5] * c[1] + world[9] * c[2] + world[13];
    const wz = world[2] * c[0] + world[6] * c[1] + world[10] * c[2] + world[14];
    const sx = Math.hypot(world[0], world[1], world[2]);
    const wr = mesh.bounds.radius * sx;
    // ray-sphere
    const ocx = wx - ox, ocy = wy - oy, ocz = wz - oz;
    const tca = ocx * dx + ocy * dy + ocz * dz;
    const d2 = ocx * ocx + ocy * ocy + ocz * ocz - tca * tca;
    if (d2 > wr * wr) continue;
    // model-space ray
    const mox = im[0] * ox + im[4] * oy + im[8] * oz + im[12];
    const moy = im[1] * ox + im[5] * oy + im[9] * oz + im[13];
    const moz = im[2] * ox + im[6] * oy + im[10] * oz + im[14];
    let mdx = im[0] * dx + im[4] * dy + im[8] * dz;
    let mdy = im[1] * dx + im[5] * dy + im[9] * dz;
    let mdz = im[2] * dx + im[6] * dy + im[10] * dz;
    const ml = Math.hypot(mdx, mdy, mdz) || 1;
    mdx /= ml; mdy /= ml; mdz /= ml;
    const pos = mesh.positions, idx = mesh.indices;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, cc = idx[i + 2] * 3;
      const t = rayTri(
        mox, moy, moz, mdx, mdy, mdz,
        pos[a], pos[a + 1], pos[a + 2],
        pos[b], pos[b + 1], pos[b + 2],
        pos[cc], pos[cc + 1], pos[cc + 2],
      );
      if (t !== null) {
        // convert model-space t to world distance (approx by scale)
        const wt = t * sx;
        if (best === null || wt < best) best = wt;
      }
    }
  }
  return best;
}

// --- Procedural fallbacks (missing assets never break the scene) ---
function finalize(url: string, positions: number[], indices: number[], texture?: string): ConvertedModel {
  const pos = new Float32Array(positions);
  const b = meshBounds(pos);
  return {
    version: 1, source: url + ' (procedural fallback)', generator: 'procedural',
    upAxis: 'Y', units: 'xna-units',
    boundingSphere: { center: [b.center[0], b.center[1], b.center[2]], radius: b.radius },
    boundingBox: { min: [0, 0, 0], max: [0, 0, 0] },
    meshes: [{
      name: 'main', positions, normals: [],
      uvs: new Array((positions.length / 3) * 2).fill(0), indices, material: 'mat0',
    }],
    materials: [{
      name: 'mat0', diffuse: [0.75, 0.78, 0.85], emissive: [0, 0, 0],
      specular: [0.68, 0.85, 1], shininess: 32, alpha: 1, ...(texture ? { texture } : {}),
    }],
  };
}

export function proceduralFallback(url: string): ConvertedModel {
  const name = url.toLowerCase();
  if (name.includes('sky')) return makeSky(url);
  if (name.includes('ark')) return makeTorus(url);
  if (name.includes('asteroid') || name.includes('planet') || name.includes('wheel')) return makeRock(url);
  if (name.includes('bullet') || name.includes('missile')) return makeBolt(url);
  if (name.includes('flag')) return makeFlag(url);
  if (name.includes('base')) return makeBase(url);
  return makeFighter(url);
}

function makeFighter(url: string): ConvertedModel {
  const p = [
    0, 0, 3.2, -0.5, 0.15, 0.6, 0.5, 0.15, 0.6,
    0, 0, 3.2, 0.5, 0.15, 0.6, 0.5, -0.15, 0.6,
    0, 0, 3.2, 0.5, -0.15, 0.6, -0.5, -0.15, 0.6,
    0, 0, 3.2, -0.5, -0.15, 0.6, -0.5, 0.15, 0.6,
    0, 0.1, -1.6, -2.6, 0, -1.2, -0.5, 0.1, -1.0,
    0, 0.1, -1.6, 0.5, 0.1, -1.0, 2.6, 0, -1.2,
  ];
  const idx: number[] = [];
  for (let i = 0; i < p.length / 9; i++) idx.push(i * 3, i * 3 + 1, i * 3 + 2);
  return finalize(url, p, idx);
}

function makeSky(url: string, r = 900): ConvertedModel {
  const p: number[] = [], idx: number[] = [];
  const lat = 12, lon = 20;
  for (let i = 0; i <= lat; i++) {
    const th = (i / lat) * Math.PI;
    for (let j = 0; j <= lon; j++) {
      const ph = (j / lon) * Math.PI * 2;
      p.push(r * Math.sin(th) * Math.cos(ph), r * Math.cos(th), r * Math.sin(th) * Math.sin(ph));
    }
  }
  for (let i = 0; i < lat; i++)
    for (let j = 0; j < lon; j++) {
      const a = i * (lon + 1) + j, b = a + lon + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  return finalize(url, p, idx);
}

function makeRock(url: string, r = 4): ConvertedModel {
  const t = (1 + Math.sqrt(5)) / 2;
  const v = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t],
    [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(([x, y, z]) => {
    const l = Math.hypot(x, y, z);
    return [(x / l) * r, (y / l) * r, (z / l) * r];
  });
  const f = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  const p: number[] = [];
  for (const i of f) p.push(...v[i]);
  const idx: number[] = [];
  for (let i = 0; i < p.length / 3; i++) idx.push(i);
  return finalize(url, p, idx);
}

function makeTorus(url: string, R = 6, r = 1): ConvertedModel {
  const p: number[] = [], idx: number[] = [];
  const seg = 10, rings = 20;
  for (let i = 0; i <= rings; i++) {
    const u = (i / rings) * Math.PI * 2;
    for (let j = 0; j <= seg; j++) {
      const v = (j / seg) * Math.PI * 2;
      p.push((R + r * Math.cos(v)) * Math.cos(u), r * Math.sin(v), (R + r * Math.cos(v)) * Math.sin(u));
    }
  }
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < seg; j++) {
      const a = i * (seg + 1) + j, b = a + seg + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  return finalize(url, p, idx);
}

function makeBolt(url: string): ConvertedModel {
  const p = [0, 0, 1.2, -0.25, 0, 0.4, 0.25, 0, 0.4, 0.25, 0, 0.4, 0.25, 0, -0.8, -0.25, 0, -0.8];
  return finalize(url, p, [0, 1, 2, 3, 4, 5]);
}

function makeFlag(url: string): ConvertedModel {
  const p = [
    0, 0, 0, 0, 4, 0, 0.12, 0, 0.12, 0, 4, 0, 0.12, 0, 0.12, 0.12, 0, 0.12,
    0.12, 4, 0.12, 0.12, 0, 0.12, 3, 3.6, 0.12, 0.12, 3.4, 0.12, 3, 3.2, 0.12,
  ];
  const idx: number[] = [];
  for (let i = 0; i < p.length / 9; i++) idx.push(i * 3, i * 3 + 1, i * 3 + 2);
  return finalize(url, p, idx);
}

function makeBase(url: string): ConvertedModel {
  const p: number[] = [0, 0.4, 0];
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    p.push(Math.cos(a) * 6, 0.4, Math.sin(a) * 6);
  }
  const idx: number[] = [];
  for (let i = 1; i <= 6; i++) idx.push(0, i, i + 1);
  return finalize(url, p, idx);
}

export { quat };
