// Converted model data: binary sidecar ranges, bounds and validation.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createGpuModel, validateModel } from '../src/engine/model';
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

  it('every model JSON validates as a version-1 (inline) model', () => {
    for (const f of files) {
      const data = JSON.parse(readFileSync(join(MODELS, f), 'utf8')) as ConvertedModel;
      validateModel(data);
      expect(data.version, f).toBe(1);
      for (const mesh of data.meshes) {
        expect(Array.isArray(mesh.positions), `${f} ${mesh.name} positions`).toBe(true);
        expect(Array.isArray(mesh.indices), `${f} ${mesh.name} indices`).toBe(true);
        expect(mesh.positions!.length, `${f} ${mesh.name} positions`).toBeGreaterThan(0);
        expect(mesh.indices!.length, `${f} ${mesh.name} indices`).toBeGreaterThan(0);
      }
    }
  });

  it('builds GPU meshes straight from the inline JSON', () => {
    const f = files.includes('Fighter3.json') ? 'Fighter3.json' : files[0];
    const data = JSON.parse(readFileSync(join(MODELS, f), 'utf8')) as ConvertedModel;
    const { gl, calls } = fakeGl();
    const gpu = createGpuModel(gl, data);
    expect(gpu.meshes).toHaveLength(data.meshes.length);
    expect(gpu.meshes[0].indexCount).toBe(data.meshes[0].indices!.length);
    expect(calls.buffers).toBe(data.meshes.length * 4);
    expect(gpu.boundingSphere.radius).toBeGreaterThan(0);
  });

  it('mesh bounds cover every vertex of the inline data', () => {
    const f = files.includes('Asteroid1.json') ? 'Asteroid1.json' : files[0];
    const data = JSON.parse(readFileSync(join(MODELS, f), 'utf8')) as ConvertedModel;
    const c = data.boundingSphere.center;
    const r = data.boundingSphere.radius;
    const pos = new Float32Array(data.meshes[0].positions!);
    let max = 0;
    for (let i = 0; i < pos.length; i += 3) {
      max = Math.max(max, Math.hypot(pos[i] - c[0], pos[i + 1] - c[1], pos[i + 2] - c[2]));
    }
    expect(max).toBeLessThanOrEqual(r + 1e-3);
    expect(r).toBeLessThanOrEqual(max + 1e-2);
  });

  it('rejects a model with bad positions', () => {
    const data = JSON.parse(readFileSync(join(MODELS, files[0]), 'utf8')) as ConvertedModel;
    data.meshes[0].positions = [1, 2];
    expect(() => validateModel(data)).toThrow(/bad positions/);
  });

  it('keeps the inline data verbatim but uploads GL-wound triangles', () => {
    const f = files.includes('Asteroid1.json') ? 'Asteroid1.json' : files[0];
    const data = JSON.parse(readFileSync(join(MODELS, f), 'utf8')) as ConvertedModel;

    const srcPos = new Float32Array(data.meshes[0].positions!);
    const srcIdx = data.meshes[0].indices!.some((i) => i > 65535)
      ? new Uint32Array(data.meshes[0].indices!)
      : new Uint16Array(data.meshes[0].indices!);

    const { gl, calls } = fakeGl();
    const gpu = createGpuModel(gl, data);
    const uploadedIdx = calls.elements[0];
    expect(uploadedIdx.length).toBe(srcIdx.length);
    let flipped = 0;
    for (let i = 0; i + 2 < srcIdx.length; i += 3) {
      if (uploadedIdx[i + 1] === srcIdx[i + 2] && uploadedIdx[i + 2] === srcIdx[i + 1]) flipped++;
    }
    expect(flipped).toBe(srcIdx.length / 3);
    expect(uploadedIdx).not.toBe(srcIdx);

    const uploadedPos = calls.array[0];
    expect(uploadedPos.length).toBe(srcPos.length);
    let posEqual = true;
    for (let i = 0; i < srcPos.length; i++) if (uploadedPos[i] !== srcPos[i]) { posEqual = false; break; }
    expect(posEqual).toBe(true);

    expect(ccwAgreement(uploadedPos, calls.array[1], uploadedIdx)).toBeGreaterThan(0.99);
  });

});
