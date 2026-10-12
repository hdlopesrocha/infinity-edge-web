// JSON model format produced by tools/convert-fbx.mjs (FBX -> JSON) and
// runtime loader creating WebGL buffers. Preserves vertices, normals, UVs,
// indices, bounds, materials/texture refs, node transforms, metadata.
// Large binary blobs stay out of JSON: this loader accepts either embedded
// arrays or external .bin (see ConvertedModel.binary).

import { mat4, quat, vec3 } from 'gl-matrix';

export interface ConvertedMesh {
  name: string;
  /** Positions (x,y,z)*N. If binary, offsets into the .bin file instead. */
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
  material?: string;
  /** Local node transform (FBX node hierarchy preserved). */
  localMatrix?: number[]; // 16 floats column-major
}

export interface ConvertedMaterial {
  name: string;
  diffuse: [number, number, number];
  emissive: [number, number, number];
  specular: [number, number, number];
  shininess: number;
  alpha: number;
  texture?: string; // texture alias or relative asset path
}

export interface ConvertedModel {
  version: 1;
  source: string; // original FBX path
  generator: string;
  upAxis: 'Y' | 'Z';
  units: string;
  /** World-space bounds of the untransformed model. */
  boundingSphere: { center: [number, number, number]; radius: number };
  boundingBox: { min: [number, number, number]; max: [number, number, number] };
  meshes: ConvertedMesh[];
  materials: ConvertedMaterial[];
  /** Optional node hierarchy (name, parent, matrix). */
  nodes?: { name: string; parent: string | null; matrix: number[] }[];
  detail?: number;
  engineFlares?: [number, number, number][];
  colorFlares?: [number, number, number][];
  height?: number;
  friction?: number;
}

export interface GpuMesh {
  vao: WebGLVertexArrayObject | null;
  vbo: WebGLBuffer | null;
  nbo: WebGLBuffer | null;
  uvbo: WebGLBuffer | null;
  ibo: WebGLBuffer | null;
  indexCount: number;
  materialIndex: number;
}

export interface GpuModel {
  meshes: GpuMesh[];
  materials: ConvertedMaterial[];
  boundingSphere: { center: vec3; radius: number };
  boundingBox: { min: vec3; max: vec3 };
  source: string;
}

const modelCache = new Map<string, GpuModel>();
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

function computeBounds(positions: number[]): {
  sphere: { center: vec3; radius: number };
  box: { min: vec3; max: vec3 };
} {
  const min = vec3.fromValues(Infinity, Infinity, Infinity);
  const max = vec3.fromValues(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
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
  return { sphere: { center, radius }, box: { min, max } };
}

function ensureNormals(mesh: ConvertedMesh): Float32Array {
  const n = mesh.positions.length / 3;
  if (mesh.normals.length === mesh.positions.length) return new Float32Array(mesh.normals);
  // Flat-ish fallback: compute per-face normals accumulated per vertex.
  const acc = new Float32Array(mesh.positions.length);
  const p = mesh.positions;
  const idx = mesh.indices;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3;
    const b = idx[i + 1] * 3;
    const c = idx[i + 2] * 3;
    const abx = p[b] - p[a];
    const aby = p[b + 1] - p[a + 1];
    const abz = p[b + 2] - p[a + 2];
    const acx = p[c] - p[a];
    const acy = p[c + 1] - p[a + 1];
    const acz = p[c + 2] - p[a + 2];
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    acc[a] += nx;
    acc[a + 1] += ny;
    acc[a + 2] += nz;
    acc[b] += nx;
    acc[b + 1] += ny;
    acc[b + 2] += nz;
    acc[c] += nx;
    acc[c + 1] += ny;
    acc[c + 2] += nz;
  }
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(acc[i * 3], acc[i * 3 + 1], acc[i * 3 + 2]) || 1;
    acc[i * 3] /= l;
    acc[i * 3 + 1] /= l;
    acc[i * 3 + 2] /= l;
  }
  return acc;
}

function ensureUVs(mesh: ConvertedMesh): Float32Array {
  const n = mesh.positions.length / 3;
  if (mesh.uvs.length === n * 2) return new Float32Array(mesh.uvs);
  return new Float32Array(n * 2); // zeros
}

export function createGpuModel(gl: WebGL2RenderingContext, data: ConvertedModel): GpuModel {
  validateModel(data);
  const matIndex = new Map(data.materials.map((m, i) => [m.name, i]));
  const meshes: GpuMesh[] = data.meshes.map((mesh) => {
    const pos = new Float32Array(mesh.positions);
    const nor = ensureNormals(mesh);
    const uv = ensureUVs(mesh);
    const idx = mesh.indices.length > 65535
      ? new Uint32Array(mesh.indices)
      : new Uint16Array(mesh.indices);
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
    gl.bufferData(
      gl.ELEMENT_ARRAY_BUFFER,
      idx,
      gl.STATIC_DRAW,
    );
    gl.bindVertexArray(null);
    return {
      vao,
      vbo,
      nbo,
      uvbo,
      ibo,
      indexCount: mesh.indices.length,
      materialIndex: mesh.material ? (matIndex.get(mesh.material) ?? 0) : 0,
    };
  });
  // Recompute bounds from data (cheap, trustworthy) but keep file values as fallback.
  let sphere = {
    center: vec3.fromValues(...data.boundingSphere.center),
    radius: data.boundingSphere.radius,
  };
  let box = {
    min: vec3.fromValues(...data.boundingBox.min),
    max: vec3.fromValues(...data.boundingBox.max),
  };
  if (!(sphere.radius > 0)) {
    const all: number[] = [];
    for (const m of data.meshes) all.push(...m.positions);
    const b = computeBounds(all);
    sphere = b.sphere;
    box = b.box;
  }
  return { meshes, materials: data.materials, boundingSphere: sphere, boundingBox: box, source: data.source };
}

/** Fetch + cache a converted model JSON. Falls back to procedural geometry. */
export async function loadModel(gl: WebGL2RenderingContext, url: string): Promise<GpuModel> {
  const hit = modelCache.get(url);
  if (hit) return hit;
  const p = pending.get(url);
  if (p) return p;
  const job = (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = (await res.json()) as ConvertedModel;
      const gpu = createGpuModel(gl, data);
      modelCache.set(url, gpu);
      return gpu;
    } catch {
      const gpu = createGpuModel(gl, proceduralFallback(url));
      modelCache.set(url, gpu);
      return gpu;
    }
  })();
  pending.set(url, job);
  job.finally(() => pending.delete(url));
  return job;
}

export function peekModel(url: string): GpuModel | undefined {
  return modelCache.get(url);
}

export function disposeModel(gl: WebGL2RenderingContext, url: string): void {
  const m = modelCache.get(url);
  if (!m) return;
  for (const mesh of m.meshes) {
    gl.deleteBuffer(mesh.vbo);
    gl.deleteBuffer(mesh.nbo);
    gl.deleteBuffer(mesh.uvbo);
    gl.deleteBuffer(mesh.ibo);
    gl.deleteVertexArray(mesh.vao);
  }
  modelCache.delete(url);
}

/** Procedural stand-ins by model name so missing assets never break the scene. */
export function proceduralFallback(url: string): ConvertedModel {
  const name = url.toLowerCase();
  if (name.includes('sky')) return makeSkySphere(url);
  if (name.includes('ark')) return makeTorus(url, 6, 1, 12, 24);
  if (name.includes('asteroid') || name.includes('planet'))
    return makeIcosahedron(url, name.includes('planet') ? 8 : 4);
  if (name.includes('bullet') || name.includes('missile'))
    return makeCapsule(url);
  if (name.includes('flag')) return makeFlag(url);
  if (name.includes('base')) return makeBase(url);
  return makeFighter(url);
}

function finalize(
  url: string,
  positions: number[],
  normals: number[],
  uvs: number[],
  indices: number[],
  texture?: string,
): ConvertedModel {
  const b = computeBounds(positions);
  return {
    version: 1,
    source: url + ' (procedural fallback)',
    generator: 'infinity-edge-web procedural',
    upAxis: 'Y',
    units: 'xna-units',
    boundingSphere: { center: [b.sphere.center[0], b.sphere.center[1], b.sphere.center[2]], radius: b.sphere.radius },
    boundingBox: {
      min: [b.box.min[0], b.box.min[1], b.box.min[2]],
      max: [b.box.max[0], b.box.max[1], b.box.max[2]],
    },
    meshes: [{ name: 'main', positions, normals, uvs, indices, material: 'mat0' }],
    materials: [
      {
        name: 'mat0', diffuse: [0.75, 0.78, 0.85], emissive: [0, 0, 0],
        specular: [0.68, 0.85, 1], shininess: 32, alpha: 1, texture,
      },
    ],
  };
}

function gridUV(n: number): number[] {
  const uv: number[] = [];
  for (let i = 0; i < n; i++) uv.push(0, 0);
  return uv;
}

export function makeFighter(url: string): ConvertedModel {
  // Low-poly dart: nose +Z (XNA forward), wings in XZ plane.
  const positions = [
    0, 0, 3.2, -0.5, 0.15, 0.6, 0.5, 0.15, 0.6, // nose top
    0, 0, 3.2, 0.5, 0.15, 0.6, 0.5, -0.15, 0.6,
    0, 0, 3.2, 0.5, -0.15, 0.6, -0.5, -0.15, 0.6,
    0, 0, 3.2, -0.5, -0.15, 0.6, -0.5, 0.15, 0.6,
    0, 0.1, -1.6, -2.6, 0, -1.2, -0.5, 0.1, -1.0, // left wing
    0, 0.1, -1.6, 0.5, 0.1, -1.0, 2.6, 0, -1.2, // right wing
    0, 0.6, -1.4, -0.08, 0.1, -0.6, 0.08, 0.1, -0.6, // tail fin
    -0.5, 0.15, 0.6, -0.5, -0.15, 0.6, -0.5, -0.1, -1.0,
    0.5, 0.15, 0.6, 0.5, -0.1, -1.0, 0.5, -0.15, 0.6,
  ];
  const n = positions.length / 3;
  const indices: number[] = [];
  for (let i = 0; i < n; i += 3) indices.push(i, i + 1, i + 2);
  return finalize(url, positions, [], gridUV(n), indices);
}

export function makeSkySphere(url: string, r = 900): ConvertedModel {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const lat = 16;
  const lon = 24;
  for (let i = 0; i <= lat; i++) {
    const th = (i / lat) * Math.PI;
    for (let j = 0; j <= lon; j++) {
      const ph = (j / lon) * Math.PI * 2;
      const x = r * Math.sin(th) * Math.cos(ph);
      const y = r * Math.cos(th);
      const z = r * Math.sin(th) * Math.sin(ph);
      positions.push(x, y, z);
      const l = Math.hypot(x, y, z) || 1;
      normals.push(-x / l, -y / l, -z / l); // inward (skybox seen from inside)
      uvs.push(j / lon, i / lat);
    }
  }
  for (let i = 0; i < lat; i++) {
    for (let j = 0; j < lon; j++) {
      const a = i * (lon + 1) + j;
      const b = a + lon + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return finalize(url, positions, normals, uvs, indices);
}

export function makeIcosahedron(url: string, r = 4): ConvertedModel {
  const t = (1 + Math.sqrt(5)) / 2;
  const v: number[][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(([x, y, z]) => {
    const l = Math.hypot(x, y, z);
    return [(x / l) * r, (y / l) * r, (z / l) * r];
  });
  const f = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  const positions: number[] = [];
  for (const i of f) positions.push(...v[i]);
  const n = positions.length / 3;
  const indices: number[] = [];
  for (let i = 0; i < n; i++) indices.push(i);
  return finalize(url, positions, [], gridUV(n), indices);
}

function makeTorus(url: string, R = 6, r = 1, seg = 12, rings = 24): ConvertedModel {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const u = (i / rings) * Math.PI * 2;
    for (let j = 0; j <= seg; j++) {
      const v = (j / seg) * Math.PI * 2;
      const x = (R + r * Math.cos(v)) * Math.cos(u);
      const y = r * Math.sin(v);
      const z = (R + r * Math.cos(v)) * Math.sin(u);
      positions.push(x, y, z);
      normals.push(Math.cos(v) * Math.cos(u), Math.sin(v), Math.cos(v) * Math.sin(u));
      uvs.push(i / rings, j / seg);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * (seg + 1) + j;
      const b = a + seg + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return finalize(url, positions, normals, uvs, indices);
}

function makeCapsule(url: string): ConvertedModel {
  const positions = [0, 0, 1.2, -0.25, 0, 0.4, 0.25, 0, 0.4, 0.25, 0, 0.4, 0.25, 0, -0.8, -0.25, 0, -0.8, -0.25, 0, -0.8, -0.25, 0, 0.4, 0.25, 0, 0.4, 0.25, 0, -0.8];
  const n = positions.length / 3;
  const indices: number[] = [];
  for (let i = 0; i < n; i += 3) indices.push(i, i + 1, i + 2);
  return finalize(url, positions, [], gridUV(n), indices);
}

function makeFlag(url: string): ConvertedModel {
  const positions = [
    0, 0, 0, 0, 4, 0, 0.12, 0, 0.12, 0, 4, 0, 0.12, 0, 0.12, 0.12, 0, 0.12,
    0.12, 4, 0.12, 0.12, 0, 0.12, 3, 3.6, 0.12, 0.12, 3.4, 0.12, 3, 3.2, 0.12, 3, 3.2, 0.12, 0.12, 3.4, 0.12, 0.12, 3, 0.12,
  ];
  const n = positions.length / 3;
  const indices: number[] = [];
  for (let i = 0; i < n; i += 3) indices.push(i, i + 1, i + 2);
  return finalize(url, positions, [], gridUV(n), indices);
}

function makeBase(url: string): ConvertedModel {
  // Hexagonal pad (matches Base/hexagon.png theme).
  const positions: number[] = [0, 0.4, 0];
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    positions.push(Math.cos(a) * 6, 0.4, Math.sin(a) * 6);
  }
  positions.push(0, -0.4, 0);
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    positions.push(Math.cos(a) * 5, -0.4, Math.sin(a) * 5);
  }
  const indices: number[] = [];
  for (let i = 1; i <= 6; i++) indices.push(0, i, i + 1);
  const base = 8;
  for (let i = 0; i < 6; i++) indices.push(base, base + i + 2, base + i + 1);
  const n = positions.length / 3;
  return finalize(url, positions, [], gridUV(n), indices);
}

/** World transform helper: position + quaternion + scale (Object3D matrix). */
export function composeMatrix(
  out: mat4,
  position: vec3,
  rotation: quat,
  scale: number | vec3,
): mat4 {
  const s = typeof scale === 'number' ? vec3.fromValues(scale, scale, scale) : scale;
  mat4.fromRotationTranslationScale(out, rotation, position, s);
  return out;
}

export { mat4, quat, vec3 };
