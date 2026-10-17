// Model JSON + loader: validation, LOD + fade (Model3D.Draw verbatim),
// model/color variants, mesh-sphere ray tests.

import { mat4, quat, vec3 } from './math';
import { fetchAssetJson } from '../game/assetfetch';

export interface ConvertedMesh {
  name: string;
  /** Inline vertex data (legacy/procedural models). */
  positions?: number[];
  normals?: number[];
  uvs?: number[];
  indices?: number[];
  /** Binary sidecar descriptors (converted models, version 2). */
  vertexCount?: number;
  indexCount?: number;
  indexType?: 'u16' | 'u32';
  section?: {
    position: ByteRange; normal: ByteRange; uv: ByteRange; index: ByteRange;
  };
  bounds?: { center: [number, number, number]; radius: number };
  material?: string;
  localMatrix?: number[];
}

export interface ByteRange { offset: number; length: number }

export interface ModelBinaryMeta {
  file: string;
  byteLength: number;
  endianness: 'little' | 'big';
  layout: string;
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
  version: 1 | 2;
  source: string;
  generator: string;
  upAxis: 'Y' | 'Z';
  units: string;
  binary?: ModelBinaryMeta;
  importTransform?: { scale: number; rotX: number; rotY: number; rotZ: number };
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
  indexType: number;
  materialIndex: number;
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
const pending = new Map<string, Promise<GpuModel | null>>();

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
  }
  if (!mm.boundingSphere || typeof mm.boundingSphere.radius !== 'number')
    throw new Error('Model missing boundingSphere');
}

/**
 * The compiled XNA content (and every procedural fallback) is wound clockwise
 * when seen from outside — Direct3D's front-face convention; the vertex normals
 * point outward. OpenGL's default front face is counter-clockwise, so without
 * this flip `cullFace(BACK)` removes the outside of every mesh and the scene
 * renders the *inside* of the hulls (inverted normals -> "wrong" lighting, the
 * asteroids look hollow). Swap the 2nd/3rd index of every triangle on upload;
 * the copies are small (indices only) and the sidecar data stays verbatim.
 */
function flipWinding(idx: Uint16Array | Uint32Array): Uint16Array | Uint32Array {
  const out = idx.slice();
  for (let i = 0; i + 2 < out.length; i += 3) {
    const t = out[i + 1];
    out[i + 1] = out[i + 2];
    out[i + 2] = t;
  }
  return out;
}

/** Area-weighted normals for meshes whose sidecar has no normal section. */
function computeNormalsTyped(pos: Float32Array, idx: Uint16Array | Uint32Array): Float32Array {
  const acc = new Float32Array(pos.length);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const abx = pos[b] - pos[a], aby = pos[b + 1] - pos[a + 1], abz = pos[b + 2] - pos[a + 2];
    const acx = pos[c] - pos[a], acy = pos[c + 1] - pos[a + 1], acz = pos[c + 2] - pos[a + 2];
    let nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    acc[a] += nx; acc[a + 1] += ny; acc[a + 2] += nz;
    acc[b] += nx; acc[b + 1] += ny; acc[b + 2] += nz;
    acc[c] += nx; acc[c + 1] += ny; acc[c + 2] += nz;
  }
  for (let i = 0; i < acc.length; i += 3) {
    const l = Math.hypot(acc[i], acc[i + 1], acc[i + 2]) || 1;
    acc[i] /= l; acc[i + 1] /= l; acc[i + 2] /= l;
  }
  return acc;
}

function meshBounds(positions: Float32Array): { center: vec3; radius: number } {  const min = vec3.fromValues(Infinity, Infinity, Infinity);
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

function ensureNormals(mesh: ConvertedMesh, idx: Uint16Array | Uint32Array): Float32Array {
  const positions = mesh.positions ?? [];
  const normals = mesh.normals ?? [];
  if (normals.length === positions.length) return new Float32Array(normals);
  const acc = new Float32Array(positions.length);
  const p = positions;
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
  const n = positions.length / 3;
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(acc[i * 3], acc[i * 3 + 1], acc[i * 3 + 2]) || 1;
    acc[i * 3] /= l; acc[i * 3 + 1] /= l; acc[i * 3 + 2] /= l;
  }
  return acc;
}

interface MeshUpload {
  pos: Float32Array;
  nor: Float32Array;
  uv: Float32Array;
  idx: Uint16Array | Uint32Array;
  indexCount: number;
  materialIndex: number;
  bounds: { center: vec3; radius: number };
  name: string;
}

function uploadMesh(gl: WebGL2RenderingContext, m: MeshUpload): GpuMesh {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, m.pos, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  const nbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, nbo);
  gl.bufferData(gl.ARRAY_BUFFER, m.nor, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
  const uvbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, uvbo);
  gl.bufferData(gl.ARRAY_BUFFER, m.uv, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.idx, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return {
    vao, vbo, nbo, uvbo, ibo,
    indexCount: m.indexCount,
    indexType: m.idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
    materialIndex: m.materialIndex,
    bounds: m.bounds,
  };
}

export function createGpuModel(gl: WebGL2RenderingContext, data: ConvertedModel): GpuModel {
  validateModel(data);
  const matIndex = new Map(data.materials.map((m, i) => [m.name, i]));
  const meshes: GpuMesh[] = data.meshes.map((mesh) => {
    const positions = mesh.positions ?? [];
    const pos = new Float32Array(positions);
    const indices = mesh.indices ?? [];
    const idx = flipWinding(indices.some((i) => i > 65535) ? new Uint32Array(indices) : new Uint16Array(indices));
    const nor = ensureNormals(mesh, idx);
    const nv = positions.length / 3;
    const uvs = mesh.uvs ?? [];
    const uv = uvs.length === nv * 2 ? new Float32Array(uvs) : new Float32Array(nv * 2);
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
      indexCount: idx.length,
      indexType: idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
      materialIndex: mesh.material ? (matIndex.get(mesh.material) ?? 0) : 0,
      bounds: meshBounds(pos),
    };
  });
  return {
    meshes,
    materials: data.materials,
    boundingSphere: { center: vec3.fromValues(...data.boundingSphere.center), radius: data.boundingSphere.radius },
    boundingBox: {
      min: vec3.fromValues(...data.boundingBox.min),
      max: vec3.fromValues(...data.boundingBox.max),
    },
    source: data.source,
  };
}

/** Drop every GPU model (VAOs/buffers) — see clearTextureCache(). */
export function clearModelCache(): void {
  cache.clear();
  pending.clear();
}

export async function loadModelOptional(gl: WebGL2RenderingContext, url: string): Promise<GpuModel | null> {
  const hit = cache.get(url);
  if (hit) return hit;
  const p = pending.get(url);
  if (p) return p;
  const job: Promise<GpuModel | null> = (async () => {
    try {
      const data = await fetchAssetJson<ConvertedModel>(url);
      const gpu = createGpuModel(gl, data);
      cache.set(url, gpu);
      return gpu;
    } catch {
      return null;
    }
  })();
  pending.set(url, job);
  job.finally(() => pending.delete(url));
  return job;
}

export async function loadModel(gl: WebGL2RenderingContext, url: string): Promise<GpuModel> {
  const g = await loadModelOptional(gl, url);
  if (g) return g;
  const fb = createGpuModel(gl, proceduralFallback(url));
  cache.set(url, fb);
  return fb;
}

/** LOD + fade verbatim (Model3D.Draw). */
export function selectLod(
  lods: (GpuModel | null)[],
  camDistance: number,
  detail: number,
  viewDistance: number,
): { gpu: GpuModel; alpha: number } | null {
  const models = Math.max(1, lods.length);
  const j = Math.max(0, Math.min(models - 1, Math.floor((3 * camDistance) / viewDistance + detail)));
  const gpu = lods[j] ?? lods[0];
  if (!gpu) return null;
  return { gpu, alpha: Math.max(0, Math.min(1, (viewDistance - camDistance) / 32)) };
}

/** Mesh-sphere ray test (Model3D.Intersects(Ray,Matrix,Model)). */
export function rayIntersectModel(
  model: GpuModel, world: mat4,
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
): number | null {
  let closest: number | null = null;
  for (const mesh of model.meshes) {
    const c = mesh.bounds.center;
    const m = world as unknown as Float32Array;
    const wx = m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12];
    const wy = m[1] * c[0] + m[5] * c[1] + m[9] * c[2] + m[13];
    const wz = m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14];
    const sx = Math.hypot(m[0], m[1], m[2]);
    const wr = mesh.bounds.radius * sx;
    const ocx = wx - ox, ocy = wy - oy, ocz = wz - oz;
    const tca = ocx * dx + ocy * dy + ocz * dz;
    const d2 = ocx * ocx + ocy * ocy + ocz * ocz - tca * tca;
    if (d2 > wr * wr) continue;
    const t = tca - Math.sqrt(Math.max(0, wr * wr - d2));
    if (t >= 0 && (closest === null || t < closest)) closest = t;
  }
  return closest;
}

function finalize(url: string, positions: number[], indices: number[]): ConvertedModel {
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
      specular: [0.68, 0.85, 1], shininess: 32, alpha: 1,
    }],
  };
}

export function proceduralFallback(url: string): ConvertedModel {
  const name = url.toLowerCase();
  if (name.includes('sky')) return makeSky(url);
  if (name.includes('ark')) return makeTorus(url);
  if (name.includes('asteroid')) return makeRock(url, 6);
  if (name.includes('planet')) return makeRock(url, 1);
  if (name.includes('bullet') || name.includes('missile')) return makeBolt(url);
  if (name.includes('flag')) return makeFlag(url);
  if (name.includes('base')) return makeBase(url);
  return makeFighter(url);
}

function makeFighter(url: string): ConvertedModel {
  const p = [
    0, 0, 0.4, -0.18, 0.02, 0.07, 0.18, 0.02, 0.07,
    0, 0, 0.4, 0.18, 0.02, 0.07, 0.18, -0.02, 0.07,
    0, 0, 0.4, 0.18, -0.02, 0.07, -0.18, -0.02, 0.07,
    0, 0, 0.4, -0.18, -0.02, 0.07, -0.18, 0.02, 0.07,
    0, 0.01, -0.2, -0.32, 0, -0.14, -0.05, 0.01, -0.12,
    0, 0.01, -0.2, 0.05, 0.01, -0.12, 0.32, 0, -0.14,
  ];
  const idx: number[] = [];
  for (let i = 0; i < p.length / 9; i++) idx.push(i * 3, i * 3 + 1, i * 3 + 2);
  return finalize(url, p, idx);
}

function makeSky(url: string, r = 76): ConvertedModel {
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

function makeRock(url: string, r = 6): ConvertedModel {
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

function makeTorus(url: string, R = 6.5, r = 1): ConvertedModel {
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
  const p = [0, 0, 0.3, -0.06, 0, 0.1, 0.06, 0, 0.1, 0.06, 0, 0.1, 0.06, 0, -0.2, -0.06, 0, -0.2];
  return finalize(url, p, [0, 1, 2, 3, 4, 5]);
}

function makeFlag(url: string): ConvertedModel {
  const p = [
    0, 0, 0, 0, 1, 0, 0.03, 0, 0.03, 0, 1, 0, 0.03, 0, 0.03, 0.03, 0, 0.03,
    0.03, 1, 0.03, 0.03, 0, 0.03, 0.75, 0.9, 0.03, 0.03, 0.85, 0.03, 0.75, 0.8, 0.03,
  ];
  const idx: number[] = [];
  for (let i = 0; i < p.length / 9; i++) idx.push(i * 3, i * 3 + 1, i * 3 + 2);
  return finalize(url, p, idx);
}

function makeBase(url: string): ConvertedModel {
  const p: number[] = [0, 0.1, 0];
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    p.push(Math.cos(a) * 5, 0.1, Math.sin(a) * 5);
  }
  const idx: number[] = [];
  for (let i = 1; i <= 6; i++) idx.push(0, i, i + 1);
  return finalize(url, p, idx);
}

export { quat };
