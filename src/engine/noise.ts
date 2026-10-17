// Procedural 3D gradient noise (simplex) baked into a tileable 3D texture.
//
// The smoke particles sample this texture in world space with a time offset, so
// the density fields evolve like real smoke instead of being a static sprite.
// Simplex noise (Gustavson) has no axis-aligned artefacts and a cheaper
// gradient evaluation than classic Perlin; the permutation table is derived from
// a fixed seed so the asset stays deterministic across sessions and machines.
//
// The holoSmoke textures that used to back the old billboard clouds were
// generated with Perlin noise in Photoshop; the parameters below (scale, octave
// count, ridged detail, coarse drift) are kept identical so the procedural
// field matches that look.

import type { TexEntry } from './texture';

/** Deterministic 32-bit LCG so the permutation table never changes. */
function makePerm(seed: number): Uint8Array {
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

// ---- 3D simplex noise (Stefan Gustavson) ---------------------------------
const F3 = 1.0 / 3.0;
const G3 = 1.0 / 6.0;

function grad3(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

/** Simplex noise in roughly [-1, 1]; tiles the lattice for wrapping. */
export function simplex3(x: number, y: number, z: number, perm: Uint8Array, period = 256): number {
  const s = (x + y + z) * F3;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);
  const k = Math.floor(z + s);
  const t = (i + j + k) * G3;
  const X0 = i - t, Y0 = j - t, Z0 = k - t;
  const x0 = x - X0, y0 = y - Y0, z0 = z - Z0;

  let i1: number, j1: number, k1: number;
  let i2: number, j2: number, k2: number;
  if (x0 >= y0) {
    if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
    else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
  } else {
    if (y0 > z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    else if (z0 > x0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
  }
  const x1v = x0 - i1 + G3, y1v = y0 - j1 + G3, z1v = z0 - k1 + G3;
  const x2v = x0 - i2 + 2 * G3, y2v = y0 - j2 + 2 * G3, z2v = z0 - k2 + 2 * G3;
  const x3v = x0 - 1 + 3 * G3, y3v = y0 - 1 + 3 * G3, z3v = z0 - 1 + 3 * G3;

  const ii = ((i % period) + period) % period;
  const jj = ((j % period) + period) % period;
  const kk = ((k % period) + period) % period;
  const gi0 = perm[ii + perm[jj + perm[kk]]] & 255;
  const gi1 = perm[ii + i1 + perm[jj + j1 + perm[kk + k1]]] & 255;
  const gi2 = perm[ii + i2 + perm[jj + j2 + perm[kk + k2]]] & 255;
  const gi3 = perm[ii + 1 + perm[jj + 1 + perm[kk + 1]]] & 255;

  let n0 = 0, n1 = 0, n2 = 0, n3 = 0;
  let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
  if (t0 >= 0) { t0 *= t0; n0 = t0 * t0 * grad3(gi0, x0, y0, z0); }
  let t1 = 0.6 - x1v * x1v - y1v * y1v - z1v * z1v;
  if (t1 >= 0) { t1 *= t1; n1 = t1 * t1 * grad3(gi1, x1v, y1v, z1v); }
  let t2 = 0.6 - x2v * x2v - y2v * y2v - z2v * z2v;
  if (t2 >= 0) { t2 *= t2; n2 = t2 * t2 * grad3(gi2, x2v, y2v, z2v); }
  let t3 = 0.6 - x3v * x3v - y3v * y3v - z3v * z3v;
  if (t3 >= 0) { t3 *= t3; n3 = t3 * t3 * grad3(gi3, x3v, y3v, z3v); }
  return 32.0 * (n0 + n1 + n2 + n3);
}

/** Fractal (fBm) variant used for the density field; returns roughly [-1, 1]. */
export function fbm3(x: number, y: number, z: number, perm: Uint8Array, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * simplex3(x * f, y * f, z * f, perm);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

export interface NoiseTexture {
  tex: WebGLTexture;
  size: number;
  entry: TexEntry;
}

/**
 * Build a tileable RGBA 3D noise texture:
 *   R = simplex fBm                        (density)
 *   G = |simplex| ridged                   (wispy detail)
 *   B = coarse simplex                     (large scale drift)
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
        const ridged = 1 - Math.abs(simplex3(px * 2, py * 2, pz * 2, perm));
        const coarse = simplex3(px * 0.5, py * 0.5, pz * 0.5, perm);
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
