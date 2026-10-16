// ResourceCenter: options (exact defaults/XML), voices/SFX, model LOD/color.

import { loadModelOptional } from '../engine/model';
import type { GpuModel } from '../engine/model';
import { loadTextureAny, peekTexture } from '../engine/texture';
import type { TexEntry } from '../engine/texture';
import type { Renderer } from '../engine/renderer';
import type { ModelData } from './objects';
import { MODELS, TEXTURES } from './config';
import { LEVEL_FILES, loadLevel } from './levels';
import { ensureManifests, modelFiles, textureFiles } from './assetmanifest';
import { audio } from './audio';

export interface Options {
  username: string;
  wireframe: boolean;
  detail: number;
  distance: number;
  musicVolume: number;
  billboards: boolean;
  cheats: boolean;
  axisX: boolean;
  axisY: boolean;
}

export function defaultOptions(): Options {
  return {
    username: 'Infinity Fan', wireframe: false, detail: 2, distance: 192,
    // C# default is false; the shipped screenshots (SS1–SS8) and the MonoGame
    // port run show the special effects (star/cloud billboards + engine
    // flares), so the web build defaults to on.
    musicVolume: 0.5, billboards: true, cheats: false,
    axisX: false, axisY: false,
  };
}

/** Textures the 2013 build sampled with LinearWrap (no mipmaps): the map
 *  border hexagon. */
const WALL_TEXTURES = new Set(['hexagon', '_hexagon']);

const OPTIONS_KEY = 'options.ie3d';
const OPTIONS_VERSION = '1.0.0.5';

export function loadOptions(): Options {
  const d = defaultOptions();
  try {
    const raw = localStorage.getItem(OPTIONS_KEY);
    if (!raw) return d;
    const el = new DOMParser().parseFromString(raw, 'text/xml').querySelector('Options');
    if (!el || el.getAttribute('_version') !== OPTIONS_VERSION) {
      // Old/unknown options: keep what still applies, but re-apply the web
      // defaults once (Special Effects on: SS1-SS8 and the MonoGame port run
      // show the star/cloud billboards + engine flares).
      localStorage.removeItem(OPTIONS_KEY);
      return { ...d, ...(el ? {} : {}) };
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
      axisX: b('_axisX', d.axisX),
      axisY: b('_axisY', d.axisY),
      cheats: d.cheats,
    };
  } catch {
    return d;
  }
}

export function saveOptions(o: Options): void {
  try {
    localStorage.setItem(
      OPTIONS_KEY,
      `<Options _version="${OPTIONS_VERSION}" _userName="${o.username.replace(/"/g, '')}" ` +
        `_wireframe="${o.wireframe}" _detail="${o.detail}" _distance="${o.distance}" ` +
        `_musicVolume="${o.musicVolume}" _billboards="${o.billboards}" ` +
        `_axisY="${o.axisY}" _axisX="${o.axisX}" />`,
    );
  } catch { /* ignore */ }
}

/** CommandClearGame: wipe saves (.ie3d/.svg/.ghs in this port). */
export function clearGameData(): string[] {
  const removed: string[] = [];
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.endsWith('.ie3d') || k.endsWith('.svg') || k.endsWith('.ghs'))) keys.push(k);
    }
    keys.forEach((k) => {
      localStorage.removeItem(k);
      removed.push(k);
    });
  } catch { /* ignore */ }
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
    const files = textureFiles();
    const out: string[] = [];
    for (const n of names) {
      for (const ext of ['png', 'jpg']) {
        const file = `${n}.${ext}`;
        // The generated manifest lists what actually exists; without it we keep
        // probing (the loader tolerates the 404s).
        if (files && !files.has(file)) continue;
        out.push(this.baseUrl(`assets/textures/${file}`));
      }
    }
    return out;
  }

  /** Preload models (solid+color LODs) + HUD textures. */
  async preload(modelNames: string[], texAliases: string[]): Promise<void> {
    const gl = this.renderer.gl;
    await Promise.all(texAliases.map((t) => this.ensureTex(t)));
    // Models are independent: load them in parallel (the published build is
    // network-bound, so the sequential loop dominated the first-load time).
    const jobs: Promise<void>[] = [];
    for (const name of modelNames) {
      if (this.models.has(name)) continue;
      const pending = this.modelJobs.get(name);
      if (pending) {
        jobs.push(pending);
        continue;
      }
      const job = this.loadModel(gl, name).finally(() => this.modelJobs.delete(name));
      this.modelJobs.set(name, job);
      jobs.push(job);
    }
    await Promise.all(jobs);
  }

  private modelJobs = new Map<string, Promise<void>>();

  private async loadModel(gl: WebGL2RenderingContext, name: string): Promise<void> {
    if (this.models.has(name)) return;
    // The existence checks below read the generated manifest; without it the
    // loader probes optional variants (Wheel_color.json) that do not exist,
    // which is a 404 on the published build. Wait for the list first.
    await ensureManifests();
    const cfg = MODELS.find((m) => m.name === name);
    const detail = cfg?.detail ?? 1;
    // Model files are named after the Objects/ folder (ModelConfig.directory);
    // several aliases differ from it (adShield -> AddonShield, ...).
    const fileBase = cfg?.directory.split('/').pop() ?? name;
    const models = modelFiles();
    const exists = (file: string): boolean => !models || models.has(file);
    const solidJobs: Promise<GpuModel | null>[] = [];
    for (let i = 0; i < detail; i++) {
      const file = i === 0 ? `${fileBase}.json` : `${fileBase}_lod${i}.json`;
      solidJobs.push(exists(file) ? loadModelOptional(gl, this.modelUrl(file.slice(0, -5))) : Promise.resolve(null));
    }
    const colorJobs: Promise<GpuModel | null>[] = [];
    for (let i = 0; i < detail; i++) {
      const file = i === 0 ? `${fileBase}_color.json` : `${fileBase}_color${i}.json`;
      colorJobs.push(exists(file) ? loadModelOptional(gl, this.modelUrl(file.slice(0, -5))) : Promise.resolve(null));
    }
    const [solid, colorAll] = await Promise.all([
      Promise.all(solidJobs),
      Promise.all(colorJobs),
    ]);
    const color: (GpuModel | null)[] = [];
    if (colorAll[0]) {
      color.push(colorAll[0]);
      for (let i = 1; i < colorAll.length; i++) color.push(colorAll[i]);
    }
    const gpu0 = solid[0] ?? color[0];
    if (!gpu0) return;
    const texJobs: Promise<TexEntry | null>[] = gpu0.materials.map((mat) =>
      mat.texture
        ? loadTextureAny(gl, [this.baseUrl(mat.texture)]).catch(() => null)
        : Promise.resolve(null),
    );
    const iconJob = loadTextureAny(gl, this.texCandidates(fileBase + '_icon')).catch(() => null);
    const [texResults, icon] = await Promise.all([Promise.all(texJobs), iconJob]);
    const texes: (TexEntry | null)[] = texResults.map((t) => (t && t.url !== '__fallback__' ? t : null));
    const tex = texes.find((t) => t) ?? null;
    this.models.set(name, {
      name,
      solid: solid.length ? solid : [gpu0],
      color: color.length ? color : [gpu0],
      tex,
      texes,
      icon: icon && icon.url !== '__fallback__' ? icon : null,
      flares: { engine: cfg?.engineFlares ?? [], color: cfg?.colorFlares ?? [] },
      friction: 1,
      detail,
    });
  }

  /**
   * Eagerly load *everything* the game can ask for (all models with their LODs,
   * icons and textures, every UI/texture alias and the level JSONs) so the boot
   * screen can show a real progress bar and the menus/games never stall.
   * `onProgress(done, total)` is called as items complete.
   */
  async preloadAll(onProgress?: (done: number, total: number) => void): Promise<void> {
    const gl = this.renderer.gl;
    await ensureManifests();
    const extraTex = [
      'holoSmoke1', 'holoSmoke2', 'holoSmoke3', 'holoSmoke4', 'holoSmoke5', 'holoSmoke6', 'holoSmoke7',
      'hexagon', 'aim', 'over',
    ];
    const texAliases = [...new Set([...Object.keys(TEXTURES), ...extraTex])];
    const modelNames = MODELS.map((m) => m.name);
    const levelKeys = Object.keys(LEVEL_FILES);
    const total = texAliases.length + modelNames.length + levelKeys.length;
    let done = 0;
    const bump = (): void => {
      done++;
      onProgress?.(done, total);
    };
    const texJobs = texAliases.map((t) => this.ensureTex(t).then(bump, bump));
    const modelJobs = modelNames.map((n) => this.loadModel(gl, n).then(bump, bump));
    const levelJobs = levelKeys.map((k) => loadLevel(k).then(bump, bump));
    await Promise.all([...texJobs, ...modelJobs, ...levelJobs]);
    // Assets are in; the RC caches are warm, so rebuilds from now on are cheap.
    onProgress?.(total, total);
  }

  /**
   * Drop every cached ModelData/TexEntry. Called when the WebGL context was
   * restored: the GPU objects those wrappers hold belong to the lost context,
   * and nothing else clears this map (the engine caches are separate), so a
   * rebuilt scene would keep drawing with dead VAOs and textures -- a black
   * frame with the game still running.
   */
  clearCaches(): void {
    this.models.clear();
    this.texCache.clear();
  }

  model(name: string): ModelData | null {
    return this.models.get(name) ?? null;
  }

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
    if (e.url !== '__fallback__' && WALL_TEXTURES.has(alias)) {
      // The original draws the map border with SamplerState.LinearWrap (no
      // mipmaps). The border quads tile the hexagon texture ~1024x across a
      // 2048-unit face, so with mipmapping the sampled level is the 1x1 average
      // (a flat white wash) and the hexagon grid disappears; linear filtering
      // keeps the pattern visible, exactly like the 2013 build.
      const gl = this.renderer.gl;
      gl.bindTexture(gl.TEXTURE_2D, e.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
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
