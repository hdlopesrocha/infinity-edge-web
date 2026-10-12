// ResourceCenter port: options (exact defaults), voices/SFX registries,
// model/texture caches, seeded RNG, background level hook.
// Audio playout itself lives in audio.ts; RC resolves names and positions.

import { loadModel } from '../engine/model';
import type { GpuModel } from '../engine/model';
import { loadTextureAny, peekTexture } from '../engine/texture';
import type { TexEntry } from '../engine/texture';
import type { Renderer } from '../engine/renderer';
import type { ModelData } from './objects';
import { MODELS } from './config';
import { audio } from './audio';

export interface Options {
  username: string;
  wireframe: boolean;
  detail: number;
  distance: number;
  musicVolume: number;
  billboards: boolean;
  motionBlur: boolean;
  cheats: boolean;
  axisX: boolean;
  axisY: boolean;
}

/** Exact Options.cs defaults. */
export function defaultOptions(): Options {
  return {
    username: 'Infinity Fan',
    wireframe: false,
    detail: 2,
    distance: 192,
    musicVolume: 0.5,
    billboards: false,
    motionBlur: false,
    cheats: false,
    axisX: false,
    axisY: false,
  };
}

const OPTIONS_KEY = 'ie3d.options.xml';

export function loadOptions(): Options {
  const d = defaultOptions();
  try {
    const raw = localStorage.getItem(OPTIONS_KEY);
    if (!raw) return d;
    const doc = new DOMParser().parseFromString(raw, 'text/xml');
    const el = doc.querySelector('Options');
    if (!el || el.getAttribute('_version') !== '1.0.0.2') {
      localStorage.removeItem(OPTIONS_KEY); // version mismatch -> wipe (verbatim)
      return d;
    }
    const g = (n: string, fb: string) => el.getAttribute(n) ?? fb;
    const b = (n: string, fb: boolean) => {
      const v = el.getAttribute(n);
      return v == null ? fb : v === 'True' || v === 'true';
    };
    return {
      username: g('_userName', d.username),
      wireframe: b('_wireframe', d.wireframe),
      detail: parseInt(g('_detail', '2'), 10),
      distance: parseInt(g('_distance', '192'), 10),
      musicVolume: parseFloat(g('_musicVolume', '0.5')),
      billboards: b('_billboards', d.billboards),
      motionBlur: b('_motionBlur', d.motionBlur),
      axisX: b('_axisX', d.axisX),
      axisY: b('_axisY', d.axisY),
      cheats: d.cheats, // never serialized (verbatim)
    };
  } catch {
    return d;
  }
}

export function saveOptions(o: Options): void {
  try {
    const xml =
      `<Options _version="1.0.0.2" _userName="${o.username.replace(/"/g, '')}" ` +
      `_wireframe="${o.wireframe}" _detail="${o.detail}" _distance="${o.distance}" ` +
      `_musicVolume="${o.musicVolume}" _billboards="${o.billboards}" ` +
      `_motionBlur="${o.motionBlur}" _axisY="${o.axisY}" _axisX="${o.axisX}" />`;
    localStorage.setItem(OPTIONS_KEY, xml);
  } catch {
    /* ignore */
  }
}

export function clearGameData(): string[] {
  const removed: string[] = [];
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.endsWith('.svg') || k.endsWith('.ghs') || k.endsWith('.ie3d'))) keys.push(k);
    }
    keys.forEach((k) => {
      localStorage.removeItem(k);
      removed.push(k);
    });
  } catch {
    /* ignore */
  }
  return removed;
}

export class RC {
  options: Options = loadOptions();
  renderer: Renderer;
  seed = 123456789;
  private models = new Map<string, ModelData>();
  private texCache = new Map<string, TexEntry | null>();
  musicStarted = false;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
  }

  /** Maths._random uniform [0,1). */
  random = (): number => {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  };

  baseUrl(path: string): string {
    return (import.meta.env.BASE_URL + path).replace(/([^:])\/\//g, '$1/');
  }

  modelUrl(alias: string): string {
    return this.baseUrl(`assets/models/${alias}.json`);
  }

  private texCandidates(alias: string): string[] {
    const names = alias.startsWith('_') ? [alias, alias.slice(1)] : [alias, '_' + alias];
    const out: string[] = [];
    for (const n of names) {
      out.push(this.baseUrl(`assets/textures/${n}.png`));
      out.push(this.baseUrl(`assets/textures/${n}.jpg`));
    }
    return out;
  }

  /** Preload every model/texture a level needs (ContentManager warm-up). */
  async preload(modelNames: string[], texAliases: string[]): Promise<void> {
    const gl = this.renderer.gl;
    await Promise.all(modelNames.map((m) => loadModel(gl, this.modelUrl(m)).catch(() => null)));
    await Promise.all(texAliases.map((t) => loadTextureAny(gl, this.texCandidates(t)).catch(() => null)));
    // bind ModelData records
    for (const name of modelNames) {
      if (this.models.has(name)) continue;
      const cfg = MODELS.find((m) => m.name === name);
      const gpu: GpuModel | null = await loadModel(gl, this.modelUrl(name)).catch(() => null);
      if (!gpu) continue;
      const diffuseTex = gpu.materials[0]?.texture;
      const tex = diffuseTex
        ? await loadTextureAny(gl, [this.baseUrl(diffuseTex)]).catch(() => null)
        : null;
      const icon = await loadTextureAny(gl, this.texCandidates(name + '_icon')).catch(() => null);
      this.models.set(name, {
        name,
        gpu,
        tex,
        icon: icon && icon.url !== '__fallback__' ? icon : null,
        flares: { engine: cfg?.engineFlares ?? [], color: cfg?.colorFlares ?? [] },
        friction: 1,
      });
    }
  }

  model(name: string): ModelData | null {
    return this.models.get(name) ?? null;
  }

  /** Synchronous texture for per-frame draw code (preload/ensureTex first). */
  tex(alias: string): TexEntry | null {
    const hit = this.texCache.get(alias);
    if (hit !== undefined) return hit;
    for (const url of this.texCandidates(alias)) {
      const e = peekTexture(url);
      if (e) {
        this.texCache.set(alias, e);
        return e;
      }
    }
    return null;
  }

  async ensureTex(alias: string): Promise<void> {
    if (this.texCache.has(alias)) return;
    const e = await loadTextureAny(this.renderer.gl, this.texCandidates(alias));
    this.texCache.set(alias, e.url === '__fallback__' ? null : e);
  }

  playSfx(name: string, volume = 1, pan = 0): void {
    void audio.sfx(name, volume, pan);
  }

  playVoice(field: string): string {
    return audio.voice(field);
  }

  startMusic(): void {
    if (this.musicStarted) return;
    this.musicStarted = true;
    audio.setMusicVolume(this.options.musicVolume);
    audio.unlock();
  }
}
