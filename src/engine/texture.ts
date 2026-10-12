// Texture loading, caching, filtering, mipmaps.
// Port of TextureCache.cs (AVL-dict lazy cache) + LinearWrap sampler state
// used in Map.Draw. Textures are referenced by alias (TextureConfig.xml names).

export interface TexEntry {
  tex: WebGLTexture;
  image: TexImageSource;
  url: string;
  width: number;
  height: number;
}

const cache = new Map<string, TexEntry>();
const pending = new Map<string, Promise<TexEntry>>();
// 1x1 white fallback so draws never break when an asset is missing.
let fallback: TexEntry | null = null;

function makeFallback(gl: WebGL2RenderingContext): TexEntry {
  if (fallback) return fallback;
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([255, 255, 255, 255]),
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  const c = document.createElement('canvas');
  c.width = 1;
  c.height = 1;
  fallback = { tex, image: c, url: '__fallback__', width: 1, height: 1 };
  return fallback;
}

export function getFallback(gl: WebGL2RenderingContext): TexEntry {
  return makeFallback(gl);
}

/** Upload an image with LinearWrap + mipmaps (matches XNA LinearWrap). */
export function uploadTexture(gl: WebGL2RenderingContext, image: TexImageSource): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

/** Load (and cache) a texture URL. Never rejects: falls back to white pixel. */
export function loadTexture(gl: WebGL2RenderingContext, url: string): Promise<TexEntry> {
  const hit = cache.get(url);
  if (hit) return Promise.resolve(hit);
  const p = pending.get(url);
  if (p) return p;
  const job = new Promise<TexEntry>((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    (img as HTMLImageElement).crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const tex = uploadTexture(gl, img);
        const e: TexEntry = { tex, image: img, url, width: img.width, height: img.height };
        cache.set(url, e);
        resolve(e);
      } catch {
        resolve(makeFallback(gl));
      }
    };
    img.onerror = () => resolve(makeFallback(gl));
    img.src = url;
  });
  pending.set(url, job);
  job.finally(() => pending.delete(url));
  return job;
}

/** Synchronous cache lookup (may be undefined before load). */
export function peekTexture(url: string): TexEntry | undefined {
  return cache.get(url);
}

/** Load the first URL that resolves (alias probing .png -> .jpg). */
export async function loadTextureAny(
  gl: WebGL2RenderingContext,
  urls: string[],
): Promise<TexEntry> {
  for (const url of urls) {
    const hit = cache.get(url);
    if (hit) return hit;
  }
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok) return loadTexture(gl, url);
    } catch {
      /* try next */
    }
  }
  // Last resort: attempt direct image loads in order.
  for (const url of urls) {
    const e = await loadTexture(gl, url);
    if (e.url !== '__fallback__') return e;
  }
  return makeFallback(gl);
}

export function clearTextureCache(gl: WebGL2RenderingContext): void {
  for (const e of cache.values()) gl.deleteTexture(e.tex);
  cache.clear();
  pending.clear();
  fallback = null;
}

export function textureCacheSize(): number {
  return cache.size;
}
