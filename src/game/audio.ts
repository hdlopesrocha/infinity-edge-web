// Audio: Web Audio SFX/voices + <audio> music loop.

import { SFX, VOICES } from './config';

function soundUrl(name: string): string {
  // The 2013 cues ship as uncompressed WAV (8.5 MB); the build transcodes them
  // to MP3 (~0.5 MB, 6%) -- see tools/copy-assets.mjs. The Web Audio API
  // decodes either, so the only difference is the transfer.
  return (import.meta.env.BASE_URL + `assets/sounds/${name}.mp3`).replace(/([^:])\/\//g, '$1/');
}

function musicUrl(): string {
  return (import.meta.env.BASE_URL + 'assets/sounds/sound.mp3').replace(/([^:])\/\//g, '$1/');
}

class AudioManager {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private musicEl: HTMLAudioElement | null = null;
  private unlocked = false;
  musicVolume = 0.5;
  muted = false;

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
    try {
      if (!this.musicEl) {
        this.musicEl = new Audio(musicUrl());
        this.musicEl.loop = true;
        this.musicEl.volume = this.muted ? 0 : this.musicVolume;
        const p = this.musicEl.play();
        if (p) {
          p.catch(() => {
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
