// Audio: Web Audio SFX/voices + <audio> music loop.

import { SFX, VOICES } from './config';
import { clearStoredMusic, loadStoredMusic } from './musicfile';

function soundUrl(name: string): string {
  // The 2013 cues ship as uncompressed WAV (8.5 MB); the build transcodes them
  // to MP3 (~0.5 MB, 6%) -- see tools/copy-assets.mjs. The Web Audio API
  // decodes either, so the only difference is the transfer.
  return (import.meta.env.BASE_URL + `assets/sounds/${name}.mp3`).replace(/([^:])\/\//g, '$1/');
}

function musicUrl(): string {
  return (import.meta.env.BASE_URL + 'assets/sounds/sound.mp3').replace(/([^:])\/\//g, '$1/');
}

function revokeObjectUrl(url: string | null): void {
  if (!url) return;
  try {
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(url);
    }
  } catch { /* already released */ }
}

class AudioManager {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private musicEl: HTMLAudioElement | null = null;
  private unlocked = false;
  private muteState = false;
  private customName: string | null = null;
  private customUrl: string | null = null;
  private customLoaded = false;
  private customJob: Promise<void> | null = null;
  // Bumped when the selection changes so a slow startup read cannot overwrite
  // a newer choice made from the Options menu.
  private selection = 0;
  musicVolume = 0.5;

  get muted(): boolean {
    return this.muteState;
  }

  set muted(v: boolean) {
    this.muteState = v;
    if (this.musicEl) this.musicEl.volume = v ? 0 : this.musicVolume;
  }

  private currentMusicUrl(): string {
    return this.customUrl ?? musicUrl();
  }

  /** Swap <audio>'s source without stopping a soundtrack that was playing. */
  private applyMusicSource(url: string): void {
    if (!this.musicEl) return;
    const wasPlaying = !this.musicEl.paused;
    try {
      this.musicEl.src = url;
      this.musicEl.loop = true;
      this.musicEl.volume = this.muted ? 0 : this.musicVolume;
      if (wasPlaying) {
        const p = this.musicEl.play();
        if (p) p.catch(() => undefined);
      }
    } catch { /* keep the previous element state */ }
  }

  private setCustomTrack(name: string | null, url: string | null): void {
    const previous = this.customUrl;
    this.customName = name;
    this.customUrl = url;
    this.applyMusicSource(url ?? musicUrl());
    if (previous && previous !== url) revokeObjectUrl(previous);
  }

  unlock(): void {
    // Chrome logs "The AudioContext was not allowed to start" when the context
    // is created without user activation, so wait for a real gesture (the boot
    // call and the global first-gesture handler both land here).
    const ua = (navigator as unknown as { userActivation?: { hasBeenActive?: boolean } }).userActivation;
    if (ua && ua.hasBeenActive === false) return;
    if (!this.unlocked) {
      this.unlocked = true;
      try {
        if (!this.ctx) this.ctx = new AudioContext();
        if (this.ctx.state === 'suspended') void this.ctx.resume();
      } catch { /* no audio */ }
    }
    // Read the saved track in the background; the default loop starts right
    // away and is swapped as soon as the file is ready.
    if (!this.customLoaded && !this.customJob) void this.refreshCustomMusic();
    try {
      if (!this.musicEl) {
        this.musicEl = new Audio(this.currentMusicUrl());
        this.musicEl.loop = true;
        this.musicEl.volume = this.muted ? 0 : this.musicVolume;
        const el = this.musicEl;
        const source = this.currentMusicUrl();
        const p = el.play();
        if (p) {
          p.catch(() => {
            // A source swap aborts this promise; only undo a failed start when
            // the same track is still the active one.
            if (this.musicEl !== el || this.currentMusicUrl() !== source) return;
            this.unlocked = false;
            this.musicEl = null;
          });
        }
      } else if (this.musicEl.paused) {
        this.musicEl.volume = this.muted ? 0 : this.musicVolume;
        void this.musicEl.play().catch(() => undefined);
      }
    } catch { /* silent */ }
  }

  setMusicVolume(v: number): void {
    this.musicVolume = v;
    if (this.musicEl) this.musicEl.volume = this.muted ? 0 : v;
  }

  /** Cached name of the saved custom track, or null for the default soundtrack. */
  customMusicName(): string | null {
    return this.customName;
  }

  hasCustomMusic(): boolean {
    return this.customName !== null;
  }

  /** Load the persisted track once (startup / Options mount). Never throws. */
  async refreshCustomMusic(): Promise<void> {
    if (this.customLoaded && !this.customJob) return;
    if (this.customJob) return this.customJob;
    const job = this.loadCustomTrack();
    this.customJob = job;
    try {
      await job;
    } finally {
      if (this.customJob === job) this.customJob = null;
    }
  }

  private async loadCustomTrack(): Promise<void> {
    const token = this.selection;
    let stored: { name: string; url: string } | null = null;
    try {
      stored = await loadStoredMusic();
    } catch {
      stored = null;
    }
    this.customLoaded = true;
    if (token !== this.selection) {
      // A newer selection won while IndexedDB was opening.
      if (stored) revokeObjectUrl(stored.url);
      return;
    }
    if (!stored) {
      if (this.customUrl) this.setCustomTrack(null, null);
      return;
    }
    this.setCustomTrack(stored.name, stored.url);
  }

  /**
   * Apply a selection returned by pickMusicFile (already persisted), or null
   * to go back to the bundled soundtrack. Returns the active custom name.
   */
  async useMusicFile(file: { name: string } | null): Promise<string | null> {
    this.customLoaded = true;
    const token = ++this.selection;
    if (!file) {
      try {
        await clearStoredMusic();
      } catch { /* best effort */ }
      if (token === this.selection) this.setCustomTrack(null, null);
      return null;
    }
    let stored: { name: string; url: string } | null = null;
    try {
      stored = await loadStoredMusic();
    } catch {
      stored = null;
    }
    if (token !== this.selection) {
      if (stored) revokeObjectUrl(stored.url);
      return this.customName;
    }
    if (!stored) {
      // Nothing playable in storage: don't claim a track that cannot play.
      this.setCustomTrack(null, null);
      return null;
    }
    this.setCustomTrack(stored.name, stored.url);
    return this.customName;
  }

  /** True while the looping soundtrack is audible. */
  playing(): boolean {
    return !!this.musicEl && !this.musicEl.paused;
  }

  private async buffer(name: string): Promise<AudioBuffer | null> {
    if (!this.ctx) return null;
    const hit = this.buffers.get(name);
    if (hit) return hit;
    try {
      const res = await fetch(soundUrl(name));
      if (!res.ok) return null;
      const data = await res.arrayBuffer();
      if (data.byteLength === 0) return null;
      const buf = await this.ctx.decodeAudioData(data);
      this.buffers.set(name, buf);
      return buf;
    } catch {
      return null;
    }
  }

  async sfx(name: string, volume = 1, pan = 0): Promise<void> {
    if (!this.unlocked) return;
    if (!(SFX as readonly string[]).includes(name) && !VOICES.some((v) => v.file === name)) return;
    try {
      if (!this.ctx) this.ctx = new AudioContext();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      const buf = await this.buffer(name);
      if (!buf || !this.ctx) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const g = this.ctx.createGain();
      g.gain.value = Math.max(0, Math.min(1, volume));
      const p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
      if (p) {
        p.pan.value = Math.max(-1, Math.min(1, pan));
        src.connect(g).connect(p).connect(this.ctx.destination);
      } else {
        src.connect(g).connect(this.ctx.destination);
      }
      src.start();
    } catch { /* ignore */ }
  }

  voice(field: string): string {
    const v = VOICES.find((x) => x.field === field);
    if (!v) return field;
    void this.sfx(v.file, 1, 0);
    return v.text;
  }
}

export const audio = new AudioManager();
