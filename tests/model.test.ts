// Converted model data: binary sidecar ranges, bounds and validation.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createGpuModelBinary, validateModel } from '../src/engine/model';
import type { ConvertedModel } from '../src/engine/model';

const MODELS = join(process.cwd(), 'public', 'assets', 'models');

/** A stubbed WebGL2 context: enough for buffer/VAO creation and asserts. */
function fakeGl() {
  const calls: {
    buffers: number; attribs: number; draws: string[];
    array: Float32Array[]; elements: Array<Uint16Array | Uint32Array>;
  } = { buffers: 0, attribs: 0, draws: [], array: [], elements: [] };
  let bound: 'array' | 'element' | null = null;
  const gl = {
    ARRAY_BUFFER: 1, ELEMENT_ARRAY_BUFFER: 2, STATIC_DRAW: 3, FLOAT: 4,
    UNSIGNED_SHORT: 5, UNSIGNED_INT: 6,
    createVertexArray: () => ({}),
    bindVertexArray: () => {},
    createBuffer: () => { calls.buffers++; return {}; },
    bindBuffer: (target: number) => { bound = target === 1 ? 'array' : 'element'; },
    bufferData: (_target: number, data: unknown) => {
      calls.draws.push('bufferData');
      if (bound === 'array' && ArrayBuffer.isView(data)) calls.array.push(data as Float32Array);
      if (bound === 'element' && ArrayBuffer.isView(data)) calls.elements.push(data as Uint16Array | Uint32Array);
    },
    enableVertexAttribArray: () => { calls.attribs++; },
    vertexAttribPointer: () => {},
  };
  return { gl: gl as unknown as WebGL2RenderingContext, calls };
}

/** Fraction of triangles whose geometric normal agrees with the vertex normal. */
function ccwAgreement(
  positions: Float32Array, normals: Float32Array, indices: Uint16Array | Uint32Array,
): number {
  let agree = 0;
  const tris = indices.length / 3;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const gx = (positions[b + 1] - positions[a + 1]) * (positions[c + 2] - positions[a + 2])
      - (positions[b + 2] - positions[a + 2]) * (positions[c + 1] - positions[a + 1]);
    const gy = (positions[b + 2] - positions[a + 2]) * (positions[c] - positions[a])
      - (positions[b] - positions[a]) * (positions[c + 2] - positions[a + 2]);
    const gz = (positions[b] - positions[a]) * (positions[c + 1] - positions[a + 1])
      - (positions[b + 1] - positions[a + 1]) * (positions[c] - positions[a]);
    if (gx * normals[a] + gy * normals[a + 1] + gz * normals[a + 2] > 0) agree++;
  }
  return tris === 0 ? 0 : agree / tris;
}

const files = existsSync(MODELS)
  ? readdirSync(MODELS).filter((f) => f.endsWith('.json') && f !== 'MANIFEST.json')
  : [];

describe('converted model assets', () => {
  it('has the converted catalogue available', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('every model JSON validates and its sidecar matches the declared size', () => {
    for (const f of files) {
      const data = JSON.parse(readFileSync(join(MODELS, f), 'utf8')) as ConvertedModel;
      validateModel(data);
      expect(data.version).toBe(2);
      expect(data.binary, f).toBeTruthy();
      const bin = join(MODELS, data.binary!.file);
      expect(existsSync(bin), `${f} -> ${data.binary!.file}`).toBe(true);
      expect(readFileSync(bin).byteLength).toBe(data.binary!.byteLength);
    }
  });

  it('builds GPU meshes straight from the binary buffer', () => {
    const f = files.includes('Fighter3.json') ? 'Fighter3.json' : files[0];
    const data = JSON.parse(readFileSync(join(MODELS, f), 'utf8')) as ConvertedModel;
    const bin = readFileSync(join(MODELS, data.binary!.file));
    const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer;
    const { gl, calls } = fakeGl();
    const gpu = createGpuModelBinary(gl, data, buf);
    expect(gpu.meshes).toHaveLength(data.meshes.length);
    expect(gpu.meshes[0].indexCount).toBe(data.meshes[0].indexCount);
    expect(gpu.meshes[0].indexType).toBe(
      data.meshes[0].indexType === 'u32' ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
    );
    // positions + normals + uvs + indices per mesh, all uploaded at once.
    expect(calls.buffers).toBe(data.meshes.length * 4);
    expect(gpu.boundingSphere.radius).toBeGreaterThan(0);
  });

  it('mesh bounds cover every vertex of the sidecar', () => {
    const f = files.includes('Asteroid1.json') ? 'Asteroid1.json' : files[0];
    const data = JSON.parse(readFileSync(join(MODELS, f), 'utf8')) as ConvertedModel;
    const bin = readFileSync(join(MODELS, data.binary!.file));
    for (const mesh of data.meshes) {
      const pos = new Float32Array(
        bin.buffer, bin.byteOffset + mesh.section!.position.offset, mesh.vertexCount! * 3,
      );
      const c = mesh.bounds!.center;
      let max = 0;
      for (let i = 0; i < pos.length; i += 3) {
        max = Math.max(max, Math.hypot(pos[i] - c[0], pos[i + 1] - c[1], pos[i + 2] - c[2]));
      }
      expect(max).toBeLessThanOrEqual(mesh.bounds!.radius + 1e-3);
      expect(mesh.bounds!.radius).toBeLessThanOrEqual(max + 1e-2);
    }
  });

  it('rejects a model whose ranges fall outside the sidecar', () => {
    const data = JSON.parse(readFileSync(join(MODELS, files[0]), 'utf8')) as ConvertedModel;
    data.meshes[0].section!.position.offset = data.binary!.byteLength + 8;
    expect(() => validateModel(data)).toThrow(/outside binary/);
  });

  it('keeps the sidecar verbatim but uploads GL-wound triangles', () => {
    // The original content is authored for Direct3D/XNA, whose front faces are
    // clockwise; WebGL defaults to counter-clockwise. The sidecar therefore
    // disagrees with its normals, and the loader flips the index order on
    // upload. Both halves of that contract are asserted here.
    const f = files.includes('Asteroid1.json') ? 'Asteroid1.json' : files[0];
    const data = JSON.parse(readFileSync(join(MODELS, f), 'utf8')) as ConvertedModel;
    const bin = readFileSync(join(MODELS, data.binary!.file));
    const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer;

    const mesh = data.meshes[0];
    const s = mesh.section!;
    const srcPos = new Float32Array(buf, s.position.offset, mesh.vertexCount! * 3);
    const srcNor = new Float32Array(buf, s.normal.offset, mesh.vertexCount! * 3);
    const srcIdx = mesh.indexType === 'u32'
      ? new Uint32Array(buf, s.index.offset, mesh.indexCount!)
      : new Uint16Array(buf, s.index.offset, mesh.indexCount!);
    expect(ccwAgreement(srcPos, srcNor, srcIdx)).toBeLessThan(0.1);
    // ...and the bytes on disk are untouched by the flip.
    const { gl, calls } = fakeGl();
    const gpu = createGpuModelBinary(gl, data, buf);
    const uploaded = calls.elements[0];
    expect(uploaded.length).toBe(srcIdx.length);
    const pos = calls.array[0];
    const nor = calls.array[1];
    expect(ccwAgreement(pos, nor, uploaded)).toBeGreaterThan(0.9);
    expect(gpu.meshes[0].indexCount).toBe(srcIdx.length);
  });
});
