// XNB -> JSON model converter (IE3D_37_T).
//
// Source of truth: the ORIGINAL XNA build output shipped with the game
// (InfinityEdge3D, XNA Game Studio 4.0, Windows Phone). The InfinityEdge
// MonoGame port reuses those files as-is (only the platform byte was patched
// from 'XNBm' to 'XNBw'), which makes them byte-exact ground truth for the
// final geometry the original game rendered:
//
//   - vertices are stored in mesh (bone) space,
//   - the runtime draws with  World = transforms[ParentBone] * matrix
//     (FloatingGear/Model3D.cs Draw), so the model-space vertex is
//     boneAbsolute * vertex -- exactly what this converter bakes,
//   - per-mesh BoundingSphere values are stored by the pipeline; Model3D
//     merges them (transformed by the absolute bone matrices) into
//     _bsphere, which drives collision radii and flare placement. We
//     reproduce that merge verbatim,
//   - BasicEffect parameters (texture, colors) are the compiled material.
//
// Inputs:  tools/xnb/Objects/<Name>/{model,color}N.xnb  (vendored copy of the
//          original compiled content), or ../infinity-edge-mono/.../Content.
//          Texture *file* names are resolved against the IE3D_37_T source
//          content directory (same dir tools/copy-assets.mjs uses).
// Outputs: public/assets/models/<Name>.json (+ _lodN, + _color[N].json).

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const CHECK = process.argv.includes('--check');

function firstExisting(candidates, test = (p) => existsSync(p)) {
  for (const c of candidates) if (test(c)) return c;
  return candidates[0];
}

// ---- Inputs ---------------------------------------------------------------
const xnbRoot = firstExisting([
  join(here, 'xnb', 'Objects'),
  join(webRoot, '..', 'infinity-edge-mono', 'InfinityEdge', 'Content', 'Objects'),
  join(webRoot, '..', 'infinity-edge-mono', 'InfinityEdge', 'bin', 'Debug', 'net8.0', 'Content', 'Objects'),
], (p) => existsSync(p));

const sourceContent = firstExisting([
  join(webRoot, '..', 'IE3D_37_T', 'InfinityEdge3D', 'InfinityEdge', 'InfinityEdgeContent'),
  join(webRoot, '..', 'IE3D_37_T', 'InfinityEdge', 'InfinityEdgeContent'),
], (p) => existsSync(p));
const sourceObjects = join(sourceContent, 'Objects');

const outDir = join(webRoot, 'public', 'assets', 'models');
const sanitizeFile = (s) => s.replace(/[^a-zA-Z0-9_.-]/g, '_');

// ---- XNB reader (v5, XNA Game Studio 4.0 model subset) --------------------
class Reader {
  constructor(buf, offset = 0) {
    this.buf = buf;
    this.o = offset;
  }
  u8() { return this.buf[this.o++]; }
  u32() { const v = this.buf.readUInt32LE(this.o); this.o += 4; return v; }
  i32() { const v = this.buf.readInt32LE(this.o); this.o += 4; return v; }
  f32() { const v = this.buf.readFloatLE(this.o); this.o += 4; return v; }
  r7() {
    let r = 0, s = 0;
    for (;;) {
      const b = this.buf[this.o++];
      r |= (b & 0x7f) << s;
      if (!(b & 0x80)) break;
      s += 7;
    }
    return r >>> 0;
  }
  str() {
    const n = this.r7();
    const s = this.buf.toString('utf8', this.o, this.o + n);
    this.o += n;
    return s.replace(/\0+$/, '');
  }
  /** ReadObject<T>: 7-bit type reader id (1-based), 0 = null. */
  obj() {
    const tid = this.r7();
    if (tid === 0) return null;
    if (tid === 2) return this.str(); // StringReader
    throw new Error(`unsupported object type id ${tid} at ${this.o}`);
  }
  boneRef(boneCount) {
    const b = boneCount < 255 ? this.u8() : this.u32();
    return b === 0 ? -1 : b - 1;
  }
  matrix() {
    const m = new Array(16);
    for (let i = 0; i < 16; i++) m[i] = this.f32();
    return m;
  }
}

function decompressXnb(buf) {
  const flags = buf[5];
  if (flags === 0) return { data: buf, offset: 10 };
  const declared = buf.readUInt32LE(6);
  const payload = buf.subarray(10);
  if (flags & 0x40) {
    // MonoGame LZ4 block format.
    const out = Buffer.alloc(buf.readUInt32LE(10));
    let ip = 4, op = 0;
    while (ip < payload.length) {
      const token = payload[ip++];
      let lit = token >> 4;
      if (lit === 15) { let b; do { b = payload[ip++]; lit += b; } while (b === 255); }
      payload.copy(out, op, ip, ip + lit); ip += lit; op += lit;
      if (ip >= payload.length) break;
      const offset = payload.readUInt16LE(ip); ip += 2;
      let match = token & 0x0f;
      if (match === 15) { let b; do { b = payload[ip++]; match += b; } while (b === 255); }
      match += 4;
      for (let i = 0; i < match; i++) { out[op] = out[op - offset]; op++; }
    }
    return { data: out, offset: 0 };
  }
  const data = inflateSync(payload, { finishFlush: 2 /* Z_SYNC_FLUSH */ });
  if (declared && data.length !== declared) throw new Error(`inflate size mismatch ${data.length} != ${declared}`);
  return { data, offset: 0 };
}

const FMT_SIZE = { 0: 4, 1: 8, 2: 12, 3: 16 };
const FMT_NAME = { 0: 'Single', 1: 'Vector2', 2: 'Vector3', 3: 'Vector4' };
const USAGE = { 0: 'Position', 2: 'TexCoord', 3: 'Normal' };

function readXnb(path) {
  const raw = readFileSync(path);
  if (raw.toString('latin1', 0, 3) !== 'XNB') throw new Error('not an XNB file');
  const { data: d, offset: start } = decompressXnb(raw);
  const r = new Reader(d, start);
  const readerCount = r.r7();
  const readers = [];
  for (let i = 0; i < readerCount; i++) {
    readers.push([r.str(), r.i32()]);
  }
  const sharedCount = r.r7();
  const primaryType = r.r7();
  const primaryName = (readers[primaryType - 1]?.[0] ?? '').split(',')[0].split('.').pop();
  if (primaryName !== 'ModelReader') throw new Error(`unexpected primary reader ${primaryName}`);

  // Bones.
  const boneCount = r.u32();
  const bones = [];
  for (let i = 0; i < boneCount; i++) {
    const name = r.obj();
    bones.push({ name: name ?? '', matrix: r.matrix(), parent: -1, children: [] });
  }
  for (let i = 0; i < boneCount; i++) {
    bones[i].parent = r.boneRef(boneCount);
    const childCount = r.u32();
    for (let j = 0; j < childCount; j++) bones[i].children.push(r.boneRef(boneCount));
  }

  // Meshes + parts (shared-resource references only; data lives at the end).
  const meshCount = r.i32();
  const meshes = [];
  for (let i = 0; i < meshCount; i++) {
    const name = r.obj();
    const parentBone = r.boneRef(boneCount);
    const circle = { center: [r.f32(), r.f32(), r.f32()], radius: r.f32() };
    r.obj(); // mesh tag
    const partCount = r.i32();
    const parts = [];
    for (let j = 0; j < partCount; j++) {
      const vertexOffset = r.i32();
      const numVertices = r.i32();
      const startIndex = r.i32();
      const primitiveCount = r.i32();
      r.obj(); // part tag
      const vb = r.r7();
      const ib = r.r7();
      const fx = r.r7();
      parts.push({ vertexOffset, numVertices, startIndex, primitiveCount, vb, ib, fx });
    }
    meshes.push({ name: name ?? `mesh_${i}`, parentBone, circle, parts });
  }
  const rootBone = r.boneRef(boneCount);
  r.obj(); // model tag

  // Shared resources, stored in order right after the primary object.
  const shared = [];
  for (let i = 0; i < sharedCount; i++) {
    const tid = r.r7();
    if (tid === 3) {
      const stride = r.i32();
      const elementCount = r.i32();
      const elements = [];
      for (let e = 0; e < elementCount; e++) {
        elements.push({
          offset: r.i32(), format: r.i32(), usage: r.i32(), usageIndex: r.i32(),
        });
      }
      const count = r.u32();
      const dataOffset = r.o;
      r.o += count * stride;
      shared.push({ kind: 'vb', stride, elements, count, dataOffset, buf: d });
    } else if (tid === 5) {
      const sixteenBits = r.u8() !== 0;
      const size = r.i32();
      const dataOffset = r.o;
      r.o += size;
      shared.push({ kind: 'ib', sixteenBits, size, dataOffset, buf: d });
    } else if (tid === 6) {
      const texture = r.str();
      const diffuse = [r.f32(), r.f32(), r.f32()];
      const emissive = [r.f32(), r.f32(), r.f32()];
      const specular = [r.f32(), r.f32(), r.f32()];
      const specularPower = r.f32();
      const alpha = r.f32();
      const vertexColors = r.u8() !== 0;
      shared.push({ kind: 'fx', texture, diffuse, emissive, specular, specularPower, alpha, vertexColors });
    } else {
      throw new Error(`unsupported shared resource type ${tid}`);
    }
  }
  return { bones, meshes, shared, rootBone, readers };
}

// ---- XNA math (row-vector convention, row-major storage) ------------------
function mul4(a, b) {
  const o = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let t = 0;
      for (let k = 0; k < 4; k++) t += a[i * 4 + k] * b[k * 4 + j];
      o[i * 4 + j] = t;
    }
  }
  return o;
}

function xform(m, x, y, z) {
  return [
    x * m[0] + y * m[4] + z * m[8] + m[12],
    x * m[1] + y * m[5] + z * m[9] + m[13],
    x * m[2] + y * m[6] + z * m[10] + m[14],
  ];
}

/** BoundingSphere.Transform(Matrix) -- MonoGame verbatim. */
function sphereTransform(s, m) {
  const c = xform(m, s.center[0], s.center[1], s.center[2]);
  const row1 = m[0] * m[0] + m[1] * m[1] + m[2] * m[2];
  const row2 = m[4] * m[4] + m[5] * m[5] + m[6] * m[6];
  const row3 = m[8] * m[8] + m[9] * m[9] + m[10] * m[10];
  return { center: c, radius: s.radius * Math.sqrt(Math.max(row1, Math.max(row2, row3))) };
}

/** BoundingSphere.CreateMerged -- MonoGame verbatim. */
function sphereMerge(a, b) {
  const dx = b.center[0] - a.center[0];
  const dy = b.center[1] - a.center[1];
  const dz = b.center[2] - a.center[2];
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (distance <= a.radius + b.radius) {
    if (distance <= a.radius - b.radius) return a;
    if (distance <= b.radius - a.radius) return b;
  }
  const leftRadius = Math.max(a.radius - distance, b.radius);
  const rightRadius = Math.max(a.radius + distance, b.radius);
  const len = distance || 1;
  const k = (leftRadius - rightRadius) / (2 * len);
  const center = [a.center[0] + dx * (1 + k), a.center[1] + dy * (1 + k), a.center[2] + dz * (1 + k)];
  return { center, radius: (leftRadius + rightRadius) / 2 };
}

// ---- Conversion -----------------------------------------------------------
function absoluteBones(bones) {
  // XNA CopyAbsoluteBoneTransformsTo: absolute = local * parentAbsolute.
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const out = new Array(bones.length);
  for (let i = 0; i < bones.length; i++) {
    out[i] = mul4(bones[i].matrix, bones[i].parent >= 0 ? out[bones[i].parent] : identity);
  }
  return out;
}

function readIndex(ib, i) {
  const off = ib.dataOffset + (ib.sixteenBits ? i * 2 : i * 4);
  return ib.sixteenBits ? ib.buf.readUInt16LE(off) : ib.buf.readUInt32LE(off);
}

/** Resolve an XNA texture asset name ("metal2_0") to a source image file. */
function findTextureFile(folder, assetName) {
  const base = assetName.replace(/_\d+$/, '');
  const dir = join(sourceObjects, folder);
  try {
    for (const f of readdirSync(dir)) {
      if (!/\.(png|jpe?g)$/i.test(f)) continue;
      const stem = f.replace(/\.[^.]+$/, '');
      if (stem.toLowerCase() === base.toLowerCase() || stem.toLowerCase() === assetName.toLowerCase()) return f;
    }
  } catch { /* missing dir */ }
  return null;
}

function meshVertexElement(vb, usage) {
  return vb.elements.find((e) => e.usage === usage && e.usageIndex === 0) ?? null;
}

const round3 = (arr) => arr.map((v) => Math.round(v * 1000) / 1000);

function convert(path, folder, fileName) {
  const { bones, meshes, shared } = readXnb(path);
  const abs = absoluteBones(bones);

  const materials = [];
  const materialIndex = new Map();
  const pushMaterial = (fx, meshName, partIndex) => {
    const key = JSON.stringify([fx.texture, fx.diffuse, fx.emissive, fx.specular, fx.specularPower, fx.alpha]);
    if (materialIndex.has(key)) return materialIndex.get(key);
    let texture;
    if (fx.texture) {
      const file = findTextureFile(folder, fx.texture);
      if (file) texture = `assets/textures/objects/${sanitizeFile(`${folder}__${file}`)}`;
      else console.warn(`  ! ${folder}/${fileName}: texture "${fx.texture}" not found in source content`);
    }
    const base = fx.texture ? fx.texture.replace(/_\d+$/, '') : `${meshName}_${partIndex}`;
    const name = base || `mat_${materials.length}`;
    materials.push({
      name,
      diffuse: fx.diffuse,
      emissive: fx.emissive,
      specular: fx.specular,
      shininess: fx.specularPower,
      alpha: fx.alpha,
      ...(texture ? { texture } : {}),
      ...(fx.vertexColors ? { vertexColors: true } : {}),
    });
    materialIndex.set(key, materials.length - 1);
    return materials.length - 1;
  };

  const outMeshes = [];
  let merged = null;
  for (const mesh of meshes) {
    const bone = abs[mesh.parentBone] ?? abs[0];
    const meshSphere = sphereTransform(mesh.circle, bone);
    merged = merged ? sphereMerge(merged, meshSphere) : meshSphere;
    mesh.parts.forEach((part, partIndex) => {
      const vb = shared[part.vb - 1];
      const ib = shared[part.ib - 1];
      const fx = shared[part.fx - 1];
      if (!vb || vb.kind !== 'vb') throw new Error(`${mesh.name}: bad vertex buffer ref`);
      if (!ib || ib.kind !== 'ib') throw new Error(`${mesh.name}: bad index buffer ref`);
      if (!fx || fx.kind !== 'fx') throw new Error(`${mesh.name}: bad effect ref`);
      const posEl = meshVertexElement(vb, 0);
      const nrmEl = meshVertexElement(vb, 3);
      const uvEl = meshVertexElement(vb, 2);
      if (!posEl || posEl.format !== 2) throw new Error(`${mesh.name}: unsupported position element`);
      if (nrmEl && nrmEl.format !== 2) throw new Error(`${mesh.name}: unsupported normal ${FMT_NAME[nrmEl.format]}`);
      if (uvEl && uvEl.format !== 1) throw new Error(`${mesh.name}: unsupported uv ${FMT_NAME[uvEl.format]}`);

      const readVertex = (i) => {
        const base = vb.dataOffset + i * vb.stride;
        const p = [vb.buf.readFloatLE(base + posEl.offset), vb.buf.readFloatLE(base + posEl.offset + 4), vb.buf.readFloatLE(base + posEl.offset + 8)];
        const n = nrmEl
          ? [vb.buf.readFloatLE(base + nrmEl.offset), vb.buf.readFloatLE(base + nrmEl.offset + 4), vb.buf.readFloatLE(base + nrmEl.offset + 8)]
          : [0, 0, 0];
        const uv = uvEl
          ? [vb.buf.readFloatLE(base + uvEl.offset), vb.buf.readFloatLE(base + uvEl.offset + 4)]
          : [0, 0];
        return { p, n, uv };
      };

      // XNA DrawIndexedPrimitives adds part.VertexOffset to each index.
      const positions = [], normals = [], uvs = [], indices = [];
      const map = new Map();
      const count = part.primitiveCount * 3;
      for (let k = 0; k < count; k++) {
        const vi = readIndex(ib, part.startIndex + k) + part.vertexOffset;
        if (vi >= vb.count) throw new Error(`${mesh.name}: index ${vi} out of range (${vb.count})`);
        let li = map.get(vi);
        if (li === undefined) {
          li = map.size;
          map.set(vi, li);
          const { p, n, uv } = readVertex(vi);
          positions.push(...xform(bone, p[0], p[1], p[2]));
          let nx = bone[0] * n[0] + bone[4] * n[1] + bone[8] * n[2];
          let ny = bone[1] * n[0] + bone[5] * n[1] + bone[9] * n[2];
          let nz = bone[2] * n[0] + bone[6] * n[1] + bone[10] * n[2];
          const l = Math.hypot(nx, ny, nz) || 1;
          nx /= l; ny /= l; nz /= l;
          normals.push(nx, ny, nz);
          uvs.push(uv[0], uv[1]);
        }
        indices.push(li);
      }
      // Sanity: every used vertex must sit inside the pipeline's mesh sphere.
      if (positions.length) {
        let maxD = 0;
        for (let i = 0; i < positions.length; i += 3) {
          const dx = positions[i] - meshSphere.center[0];
          const dy = positions[i + 1] - meshSphere.center[1];
          const dz = positions[i + 2] - meshSphere.center[2];
          maxD = Math.max(maxD, Math.hypot(dx, dy, dz));
        }
        if (maxD > meshSphere.radius + 0.05) {
          console.warn(`  ! ${folder}/${fileName}: mesh ${mesh.name} exceeds stored sphere (${maxD.toFixed(2)} > ${meshSphere.radius.toFixed(2)})`);
        }
      }
      const mi = pushMaterial(fx, mesh.name, partIndex);
      outMeshes.push({
        name: mesh.parts.length > 1 ? `${mesh.name}_p${partIndex}` : mesh.name,
        positions: round3(positions),
        normals: round3(normals),
        uvs: round3(uvs),
        indices,
        material: materials[mi].name,
      });
    });
  }

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const m of outMeshes) {
    for (let i = 0; i < m.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = m.positions[i + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
  }

  return {
    version: 1,
    source: `Objects/${folder}/${fileName}`,
    generator: 'tools/convert-xnb.mjs (original XNA build output)',
    upAxis: 'Y',
    units: 'xna',
    boundingSphere: { center: round3(merged.center), radius: Math.round(merged.radius * 1000) / 1000 },
    boundingBox: { min: round3(min), max: round3(max) },
    meshes: outMeshes,
    materials,
    nodes: bones.map((b) => ({
      name: b.name,
      parent: b.parent >= 0 ? bones[b.parent].name : null,
      matrix: round3(b.matrix),
    })),
  };
}

// ---- Binary sidecar ------------------------------------------------------
// Vertex/index data is packed into a sibling .bin file (documented in
// docs/asset-formats.md). The JSON keeps names, materials, bounds and byte
// ranges; the loader uploads the fetched buffer directly, so no per-vertex
// JavaScript arrays are ever materialised at runtime.
//
// Layout, per mesh, each section 4-byte aligned, little-endian:
//   Float32 position[nv*3] | Float32 normal[nv*3] | Float32 uv[nv*2] |
//   Uint16|Uint32 index[ni]
const align4 = (n) => (n + 3) & ~3;

function meshBoundsOf(positions) {
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
    radius = Math.max(radius, Math.hypot(dx, dy, dz));
  }
  return { center, radius };
}

function packBinary(meshes, binFile) {
  const chunks = [];
  let offset = 0;
  const packed = [];
  const push = (buf) => {
    chunks.push(buf);
    const at = offset;
    offset += buf.byteLength;
    const pad = align4(offset) - offset;
    if (pad) chunks.push(Buffer.alloc(pad));
    offset += pad;
    return at;
  };
  for (const m of meshes) {
    const nv = m.positions.length / 3;
    let maxIndex = 0;
    for (const i of m.indices) if (i > maxIndex) maxIndex = i;
    const u32 = maxIndex > 65535;
    const pos = Buffer.from(new Float32Array(m.positions).buffer);
    const nrm = Buffer.from(new Float32Array(m.normals).buffer);
    const uv = Buffer.from(new Float32Array(m.uvs).buffer);
    const idx = Buffer.from(
      (u32 ? Uint32Array.from(m.indices) : Uint16Array.from(m.indices)).buffer,
    );
    const bounds = meshBoundsOf(m.positions);
    packed.push({
      name: m.name,
      material: m.material,
      vertexCount: nv,
      indexCount: m.indices.length,
      indexType: u32 ? 'u32' : 'u16',
      section: {
        position: { offset: push(pos), length: pos.byteLength },
        normal: { offset: push(nrm), length: nrm.byteLength },
        uv: { offset: push(uv), length: uv.byteLength },
        index: { offset: push(idx), length: idx.byteLength },
      },
      bounds: {
        center: round3(bounds.center),
        radius: Math.round(bounds.radius * 1e6) / 1e6,
      },
    });
  }
  const buffer = Buffer.concat(chunks);
  return {
    meshes: packed,
    meta: {
      file: binFile,
      byteLength: buffer.byteLength,
      endianness: 'little',
      layout: 'position:f32x3,normal:f32x3,uv:f32x2,index:u16|u32',
    },
    buffer,
  };
}

// ---- Main -----------------------------------------------------------------
if (!existsSync(xnbRoot)) {
  console.error('convert-xnb: XNB content dir not found:', xnbRoot);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const manifest = { generator: 'tools/convert-xnb.mjs', models: {} };
let ok = 0;
const failed = [];
for (const folder of readdirSync(xnbRoot).sort()) {
  const dir = join(xnbRoot, folder);
  if (!statSync(dir).isDirectory()) continue;
  const files = readdirSync(dir).filter((f) => /\.xnb$/i.test(f)).sort();
  const models = files.filter((f) => /^model\d+\.xnb$/i.test(f));
  const colors = files.filter((f) => /^color\d+\.xnb$/i.test(f));
  const convertOne = (file, outName) => {
    try {
      const json = convert(join(dir, file), folder, file);
      const binFile = outName.replace(/\.json$/, '.bin');
      const packed = packBinary(json.meshes, binFile);
      // Binary sidecar replaces the inline vertex arrays; everything else
      // (names, materials, bounds, nodes) stays in the JSON.
      const out = {
        ...json,
        version: 2,
        binary: packed.meta,
        meshes: packed.meshes,
      };
      if (!CHECK) {
        writeFileSync(join(outDir, outName), JSON.stringify(out));
        writeFileSync(join(outDir, binFile), packed.buffer);
      }
      const tris = json.meshes.reduce((n, m) => n + m.indices.length / 3, 0);
      const jsonBytes = Buffer.byteLength(JSON.stringify(out));
      manifest.models[outName] = {
        source: json.source,
        meshes: json.meshes.length,
        triangles: tris,
        materials: json.materials.map((m) => m.name),
        binary: { file: binFile, byteLength: packed.meta.byteLength },
        bytes: { json: jsonBytes, bin: packed.meta.byteLength },
        bounds: {
          center: json.boundingSphere.center.map((v) => +v.toFixed(2)),
          radius: +json.boundingSphere.radius.toFixed(2),
        },
        zRange: [json.boundingBox.min[2], json.boundingBox.max[2]].map((v) => +v.toFixed(2)),
      };
      ok++;
      const m = json.boundingSphere;
      console.log(`ok ${outName}: ${json.meshes.length} mesh(es), ${tris} tris, r=${m.radius.toFixed(2)} c=(${m.center.map((v) => v.toFixed(2)).join(',')}) json=${jsonBytes}B bin=${packed.meta.byteLength}B`);
    } catch (e) {
      failed.push(`${folder}/${file}: ${e.message}`);
      console.error(`FAIL ${folder}/${file}: ${e.message}`);
    }
  };
  models.forEach((file, k) => convertOne(file, k === 0 ? `${folder}.json` : `${folder}_lod${k}.json`));
  colors.forEach((file, k) => convertOne(file, k === 0 ? `${folder}_color.json` : `${folder}_color${k}.json`));
}
if (!CHECK) writeFileSync(join(outDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`\nconvert-xnb: ${ok} converted, ${failed.length} failed`);
if (failed.length) { console.log('failed:\n - ' + failed.join('\n - ')); process.exitCode = 1; }
