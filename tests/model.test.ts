// Converted model data: binary sidecar ranges, bounds and validation.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createGpuModelBinary, validateModel } from '../src/engine/model';
import type { ConvertedModel } from '../src/engine/model';

const MODELS = join(process.cwd(), 'public', 'assets', 'models');

/** A stubbed WebGL2 context: enough for buffer/VAO creation and asserts. */
function fakeGl() {
  const calls: { buffers: number; attribs: number; draws: string[] } = { buffers: 0, attribs: 0, draws: [] };
  const gl = {
    ARRAY_BUFFER: 1, ELEMENT_ARRAY_BUFFER: 2, STATIC_DRAW: 3, FLOAT: 4,
    UNSIGNED_SHORT: 5, UNSIGNED_INT: 6,
    createVertexArray: () => ({}),
    bindVertexArray: () => {},
    createBuffer: () => { calls.buffers++; return {}; },
    bindBuffer: () => {},
    bufferData: () => { calls.draws.push('bufferData'); },
    enableVertexAttribArray: () => { calls.attribs++; },
    vertexAttribPointer: () => {},
  };
  return { gl: gl as unknown as WebGL2RenderingContext, calls };
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
});
