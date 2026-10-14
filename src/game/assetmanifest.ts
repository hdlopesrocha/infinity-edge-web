// Asset manifests: what actually exists under `assets/`.
//
// The game resolves textures and model variants by *probing* candidate names
// (`flare1.png` / `flare1.jpg` / `_flare1.png` / `_flare1.jpg`, `X.json` /
// `X_color.json`, ...). Most of those candidates do not exist in the original
// 2013 content, so the eager boot preload used to fire hundreds of 404s (and
// waste requests). Two generated manifests make the probing exact:
//
//   assets/models/MANIFEST.json    (written by tools/convert-xnb.mjs)
//   assets/textures/MANIFEST.json  (written by tools/asset-manifest.mjs)
//
// If a manifest is missing or fails to load the loaders fall back to probing,
// exactly like before.

const cache = new Map<string, Set<string> | null>();
const pending = new Map<string, Promise<Set<string> | null>>();

function url(file: string): string {
  return (import.meta.env.BASE_URL + file).replace(/([^:])\/\//g, '$1/');
}

async function loadList(file: string, key: 'models' | 'files'): Promise<Set<string> | null> {
  const hit = cache.get(file);
  if (hit !== undefined) return hit;
  const inFlight = pending.get(file);
  if (inFlight) return inFlight;
  const job = (async () => {
    try {
      const res = await fetch(url(file));
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as Record<string, unknown>;
      const raw = data[key];
      let names: string[];
      if (Array.isArray(raw)) names = raw as string[];
      else if (raw && typeof raw === 'object') names = Object.keys(raw as Record<string, unknown>);
      else throw new Error('unexpected manifest shape');
      const set = new Set(names);
      cache.set(file, set);
      return set;
    } catch {
      cache.set(file, null); // probing fallback
      return null;
    } finally {
      pending.delete(file);
    }
  })();
  pending.set(file, job);
  return job;
}

/** Model JSON names present in `assets/models/` (e.g. `Fighter3.json`). */
export function modelManifest(): Promise<Set<string> | null> {
  return loadList('assets/models/MANIFEST.json', 'models');
}

/** Texture file names relative to `assets/textures/` (e.g. `_flare1.png`). */
export function textureManifest(): Promise<Set<string> | null> {
  return loadList('assets/textures/MANIFEST.json', 'files');
}

/** Synchronous view of the loaded manifests (null until they arrive). */
export function modelFiles(): Set<string> | null {
  return cache.get('assets/models/MANIFEST.json') ?? null;
}

export function textureFiles(): Set<string> | null {
  return cache.get('assets/textures/MANIFEST.json') ?? null;
}

/** Await both manifests (the boot preload does this before loading anything). */
export async function ensureManifests(): Promise<void> {
  await Promise.all([modelManifest(), textureManifest()]);
}

/** Kick both fetches off early (the boot preload waits for them). */
export function warmManifests(): void {
  void modelManifest();
  void textureManifest();
}

/**
 * `true`/`false` when the manifest knows, `null` when there is no manifest
 * (callers then keep the old probing behaviour).
 */
export function manifestHas(set: Set<string> | null, name: string): boolean | null {
  return set ? set.has(name) : null;
}
