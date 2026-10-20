import { describe, expect, it } from 'vitest';
import {
  createCloudTextures, fbm3, makePerm, perlin3, perlinCloudAlpha,
} from '../src/engine/noise';

describe('Perlin noise', () => {
  it('is deterministic for a seed', () => {
    const a = makePerm(1337);
    const b = makePerm(1337);
    for (let i = 0; i < 20; i++) {
      const x = i * 0.37, y = i * 0.71, z = i * 0.13;
      expect(perlin3(x, y, z, a)).toBe(perlin3(x, y, z, b));
    }
  });

  it('tiles the lattice with the period', () => {
    const perm = makePerm(7);
    for (let i = 0; i < 8; i++) {
      const x = i * 0.41, y = i * 0.23, z = i * 0.17;
      expect(perlin3(x, y, z, perm, 16)).toBeCloseTo(perlin3(x + 16, y, z, perm, 16), 12);
      expect(perlin3(x, y, z, perm, 16)).toBeCloseTo(perlin3(x, y + 16, z, perm, 16), 12);
      expect(perlin3(x, y, z, perm, 16)).toBeCloseTo(perlin3(x, y, z + 16, perm, 16), 12);
    }
  });

  it('keeps the fBm field in its documented range', () => {
    const perm = makePerm(99);
    for (let i = 0; i < 400; i++) {
      const n = fbm3(i * 0.37, i * 0.71, i * 0.13, perm, 5);
      expect(n).toBeGreaterThanOrEqual(-1.0001);
      expect(n).toBeLessThanOrEqual(1.0001);
    }
  });
});

describe('Perlin cloud sprites', () => {
  it('is transparent at the corners', () => {
    const perm = makePerm(0x1e3d);
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      expect(perlinCloudAlpha(u, v, perm, 0.5)).toBe(0);
    }
  });

  it('forms a dense but wispy blob in [0, 1]', () => {
    const perm = makePerm(0x1e3d);
    let max = 0;
    let covered = 0;
    let sum = 0;
    const n = 64;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const a = perlinCloudAlpha(x / (n - 1), y / (n - 1), perm, 0.5);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(1);
        max = Math.max(max, a);
        sum += a;
        if (a > 0.05) covered++;
      }
    }
    // A dense core with transparent corners, and enough coverage to read as a
    // cloud without filling the whole sprite (the old holoSmoke silhouette).
    expect(max).toBeGreaterThan(0.9);
    expect(covered).toBeGreaterThan(n * n * 0.1);
    expect(covered).toBeLessThan(n * n * 0.6);
    expect(sum / (n * n)).toBeGreaterThan(0.05);
    expect(sum / (n * n)).toBeLessThan(0.35);
  });

  it('produces a different cloud for a different seed', () => {
    const a = makePerm(1);
    const b = makePerm(2);
    let diff = 0;
    for (let i = 0; i < 64; i++) {
      const x = i / 64, y = ((i * 37) % 64) / 64;
      diff += Math.abs(perlinCloudAlpha(x, y, a, 0.5) - perlinCloudAlpha(x, y, b, 0.5));
    }
    expect(diff).toBeGreaterThan(0.5);
  });

  it('uploads one RGBA sprite per variant', () => {
    const uploads: { width: number; height: number; data: Uint8Array }[] = [];
    let created = 0;
    let mips = 0;
    const gl = {
      createTexture: () => ({ id: ++created }),
      bindTexture: () => undefined,
      texParameteri: () => undefined,
      generateMipmap: () => { mips++; },
      texImage2D: (
        _target: number, _level: number, _internal: number,
        width: number, height: number, _border: number,
        _format: number, _type: number, data: Uint8Array,
      ) => { uploads.push({ width, height, data }); },
    } as unknown as WebGL2RenderingContext;

    const texs = createCloudTextures(gl, 2, 32, 123);
    expect(texs).toHaveLength(2);
    expect(texs.map((t) => t.url)).toEqual(['__perlinCloud0__', '__perlinCloud1__']);
    expect(texs.every((t) => t.width === 32 && t.height === 32)).toBe(true);
    expect(uploads).toHaveLength(2);
    expect(mips).toBe(2);
    for (const upload of uploads) {
      expect(upload.data).toHaveLength(32 * 32 * 4);
      let maxAlpha = 0;
      for (let i = 3; i < upload.data.length; i += 4) maxAlpha = Math.max(maxAlpha, upload.data[i]);
      expect(maxAlpha).toBeGreaterThan(100);
    }
  });
});
