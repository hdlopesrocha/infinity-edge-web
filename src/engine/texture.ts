// Texture loading, caching, filtering, mipmaps (TextureCache port).
// LinearWrap sampler semantics; alias probing .png -> .jpg.

export interface TexEntry {
  tex: WebGLTexture;
  url: string;
  width: number;
  height: number;
}

const cache = new Map<string, TexEntry>();
const pending = new Map<string, Promise<TexEntry>>();
let fallback: TexEntry | null = null;

function makeFallback(gl: WebGL2RenderingContext): TexEntry {
  if (fallback) return fallback;
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  fallback = { tex, url: '__fallback__', width: 1, height: 1 };
  return fallback;
}

export function getFallback(gl: WebGL2RenderingContext): TexEntry {
  return makeFallback(gl);
}

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
        const e: TexEntry = { tex, url, width: img.width, height: img.height };
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

/** Try urls in order; first loadable wins, else white fallback. Never rejects. */
export async function loadTextureAny(gl: WebGL2RenderingContext, urls: string[]): Promise<TexEntry> {
  for (const url of urls) {
    const hit = cache.get(url);
    if (hit) return hit;
  }
  for (const url of urls) {
    const e = await loadTexture(gl, url);
    if (e.url !== '__fallback__') return e;
  }
  return makeFallback(gl);
}

export function peekTexture(url: string): TexEntry | undefined {
  return cache.get(url);
}

export function clearTextureCache(gl: WebGL2RenderingContext): void {
  for (const e of cache.values()) gl.deleteTexture(e.tex);
  cache.clear();
  pending.clear();
  fallback = null;
}

