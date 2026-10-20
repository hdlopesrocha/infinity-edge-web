// Procedural 3D gradient noise (Perlin) baked into a tileable 3D texture.
//
// The smoke particles sample this texture in world space with a time offset, so
// the density fields evolve like real smoke instead of being a static sprite.
// A classic improved-Perlin lattice with a permutation table derived from a
// fixed seed keeps the asset deterministic across sessions and machines.
//
// The holoSmoke bitmaps that backed the old billboard clouds were themselves
// Perlin cloud sprites. createCloudTextures() now regenerates that scenery at
// runtime from the same noise, so the level 'cloud' objects did not disappear
// when their PNG assets were removed.

import type { TexEntry } from './texture';

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Deterministic 32-bit LCG so the permutation table never changes. */
export function makePerm(seed: number): Uint8Array {
  const p = new Uint8Array(512);
  let s = seed >>> 0;
  const next = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s;
  };
  const base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = next() % (i + 1);
    const t = base[i];
    base[i] = base[j];
    base[j] = t;
  }
  for (let i = 0; i < 512; i++) p[i] = base[i & 255];
  return p;
}

function grad(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

/** Classic Perlin noise in [-1, 1]; period tiles the lattice (for wrapping). */
export function perlin3(x: number, y: number, z: number, perm: Uint8Array, period = 256): number {
  const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
  const X = ((fx % period) + period) % period;
  const Y = ((fy % period) + period) % period;
  const Z = ((fz % period) + period) % period;
  const xf = x - fx, yf = y - fy, zf = z - fz;
  const u = fade(xf), v = fade(yf), w = fade(zf);
  const A = perm[X] + Y, AA = perm[A & 255] + Z, AB = perm[(A + 1) & 255] + Z;
  const B = perm[(X + 1) & 255] + Y, BA = perm[B & 255] + Z, BB = perm[(B + 1) & 255] + Z;
  const x1 = lerp(grad(perm[AA & 255], xf, yf, zf), grad(perm[BA & 255], xf - 1, yf, zf), u);
  const x2 = lerp(grad(perm[AB & 255], xf, yf - 1, zf), grad(perm[BB & 255], xf - 1, yf - 1, zf), u);
  const y1 = lerp(x1, x2, v);
  const x3 = lerp(grad(perm[(AA + 1) & 255], xf, yf, zf - 1), grad(perm[(BA + 1) & 255], xf - 1, yf, zf - 1), u);
  const x4 = lerp(grad(perm[(AB + 1) & 255], xf, yf - 1, zf - 1), grad(perm[(BB + 1) & 255], xf - 1, yf - 1, zf - 1), u);
  const y2 = lerp(x3, x4, v);
  return lerp(y1, y2, w);
}

/** Fractal (fBm) variant used for the density field; returns roughly [-1, 1]. */
export function fbm3(x: number, y: number, z: number, perm: Uint8Array, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * perlin3(x * f, y * f, z * f, perm);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Perlin cloud density in [0, 1] at unit coordinates (u, v). The old holoSmoke
 * sprites were Photoshop Perlin clouds: a dense, irregular blob with wispy
 * edges, internal holes and transparent corners. This reproduces that shape
 * from a multi-octave fBm core, a low-frequency contour warp and a soft radial
 * mask, with no bitmap input. The steep 0.45..0.58 threshold is deliberately
 * contrasty: it turns the smooth fBm into clumps and gaps like the originals
 * instead of a uniform foggy disc.
 */
export function perlinCloudAlpha(u: number, v: number, perm: Uint8Array, z: number): number {
  const dx = u * 2 - 1;
  const dy = v * 2 - 1;
  const r = Math.hypot(dx, dy);
  // Break the circular silhouette: warp the radius with a coarse field.
  const warp = fbm3(u * 1.25 + 0.3, v * 1.25 + 0.7, z + 2, perm, 3);
  const rr = r * (0.8 + 0.42 * warp);
  const detail = fbm3(u * 3.4 + 1.1, v * 3.4 + 2.7, z, perm, 6);
  const fine = fbm3(u * 7 + 4.2, v * 7 + 0.9, z + 4.3, perm, 4);
  const shape = 0.5 + 0.5 * (detail * 0.7 + fine * 0.3);
  const mask = 1 - smoothstep(0.12, 0.92, rr);
  return smoothstep(0.45, 0.58, shape + 0.06 * mask) * mask;
}

/**
 * Generate the seven cloud sprites that used to be `_holoSmoke1..7.png`.
 * They are uploaded once (RC caches them), carry no URL and are drawn by the
 * existing additive billboard batch exactly like the old PNG clouds: the level
 * 'cloud' objects keep their 100-unit size, 0.2 alpha and random positions.
 *
 * 128x128 RGBA keeps the original sprite resolution; the grayscale body is a
 * little brighter than the old average so the additive pass still reads on the
 * dark space background.
 */
export function createCloudTextures(
  gl: WebGL2RenderingContext, count = 7, size = 128, seed = 0x1e3d,
): TexEntry[] {
  const out: TexEntry[] = [];
  for (let variant = 0; variant < count; variant++) {
    const perm = makePerm(seed + variant * 0x9e3779b1);
    const z = variant * 13.7 + 0.5;
    const data = new Uint8Array(size * size * 4);
    let i = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const a = perlinCloudAlpha(x / (size - 1), y / (size - 1), perm, z);
        // The billboard pass is additive: RGB is the cloud's brightness and
        // alpha its density. 150 matches the old sprites' grey body.
        data[i++] = 150;
        data[i++] = 150;
        data[i++] = 150;
        data[i++] = Math.round(a * 255);
      }
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
    out.push({ tex, url: `__perlinCloud${variant}__`, width: size, height: size });
  }
  return out;
}

export interface NoiseTexture {
  tex: WebGLTexture;
  size: number;
  entry: TexEntry;
}

/**
 * Build a tileable RGBA 3D noise texture:
 *   R = Perlin fBm                        (density)
 *   G = |Perlin| ridged                   (wispy detail)
 *   B = coarse Perlin                     (large scale drift)
 *   A = 1
 * Sampling with REPEAT + LINEAR gives smooth, looping evolution when the shader
 * scrolls the coordinates over time.
 */
export function createNoiseTexture(gl: WebGL2RenderingContext, size = 48, seed = 1337): NoiseTexture {
  const perm = makePerm(seed);
  const data = new Uint8Array(size * size * size * 4);
  const scale = 4 / size;
  let i = 0;
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const px = x * scale, py = y * scale, pz = z * scale;
        const fbm = fbm3(px, py, pz, perm, 4);
        const ridged = 1 - Math.abs(perlin3(px * 2, py * 2, pz * 2, perm));
        const coarse = perlin3(px * 0.5, py * 0.5, pz * 0.5, perm);
        data[i++] = Math.round((fbm * 0.5 + 0.5) * 255);
        data[i++] = Math.round(ridged * 255);
        data[i++] = Math.round((coarse * 0.5 + 0.5) * 255);
        data[i++] = 255;
      }
    }
  }
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_3D, tex);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, size, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.bindTexture(gl.TEXTURE_3D, null);
  return { tex, size, entry: { tex, url: '__noise3d__', width: size, height: size } };
}
