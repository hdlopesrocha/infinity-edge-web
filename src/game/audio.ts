// Audio: every sound (SFX, voices and the music loop) runs through WebAudio.
// The soundtrack is decoded into an AudioBuffer and looped by an
// AudioBufferSourceNode: there is no <audio> element or MediaElementSource.

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

/** Frequency-band energies returned to the party-mode beat tracker. */
export interface MusicLevels {
  /** Weighted 0..1 energy (bass-heavy). */
  energy: number;
  bass: number;
  mid: number;
  high: number;
}

const SILENT_LEVELS: MusicLevels = { energy: 0, bass: 0, mid: 0, high: 0 };

class AudioManager {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private unlocked = false;
  private muteState = false;
  private customName: string | null = null;
  private customUrl: string | null = null;
  private customLoaded = false;
  private customJob: Promise<void> | null = null;
  // Bumped when the selection changes so a slow startup read cannot overwrite
  // a newer choice made from the Options menu.
  private selection = 0;
  // WebAudio music graph: BufferSource -> Analyser -> Gain -> destination.
  // The analyser sits before the gain, so party mode still reacts while muted.
  private musicSource: AudioBufferSourceNode | null = null;
  private musicAnalyser: AnalyserNode | null = null;
  private musicGain: GainNode | null = null;
  private musicFreq: Uint8Array<ArrayBuffer> | null = null;
  private musicLoad = 0;
  private musicLoading = false;
  private musicStarted = false;
  musicVolume = 0.5;

  get muted(): boolean {
    return this.muteState;
  }

  set muted(v: boolean) {
    this.muteState = v;
    if (this.musicGain) this.musicGain.gain.value = v ? 0 : this.musicVolume;
  }

  private currentMusicUrl(): string {
    return this.customUrl ?? musicUrl();
  }

  private ensureMusicGraph(): void {
    if (!this.ctx || this.musicGain || this.musicAnalyser) return;
    try {
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.55;
      const gain = this.ctx.createGain();
      gain.gain.value = this.muted ? 0 : this.musicVolume;
      analyser.connect(gain);
      gain.connect(this.ctx.destination);
      this.musicAnalyser = analyser;
      this.musicGain = gain;
    } catch {
      this.musicAnalyser = null;
      this.musicGain = null;
    }
  }

  private setCustomTrack(name: string | null, url: string | null): void {
    const previous = this.customUrl;
    this.customName = name;
    this.customUrl = url;
    // Decode the replacement while the old buffer keeps looping; only swap
    // when the new track is ready.
    if (this.musicStarted) void this.loadAndPlayMusic();
    if (previous && previous !== url) revokeObjectUrl(previous);
  }

  unlock(): void {
    // Chrome logs "The AudioContext was not allowed to start" when the context
    // is created without user activation, so wait for a real gesture (the boot
    // call and the global first-gesture handler both land here).
    const ua = (navigator as unknown as { userActivation?: { hasBeenActive?: boolean } }).userActivation;
    if (ua && ua.hasBeenActive === false) return;
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        return;
      }
    }
    this.unlocked = true;
    this.ensureMusicGraph();
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
    // Read the saved track in the background; the default loop starts right
    // away and is swapped as soon as the file is ready.
    if (!this.customLoaded && !this.customJob) void this.refreshCustomMusic();
    if (!this.musicSource && !this.musicLoading) {
      this.musicStarted = true;
      void this.loadAndPlayMusic();
    }
  }

  setMusicVolume(v: number): void {
    this.musicVolume = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
    if (this.musicGain) this.musicGain.gain.value = this.muted ? 0 : this.musicVolume;
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

  /** True while the looping soundtrack is actually running. */
  playing(): boolean {
    return !!this.musicSource && this.ctx?.state === 'running';
  }

  /**
   * Decode and loop the selected soundtrack. The old source keeps playing
   * until the new buffer is ready; a failed replacement leaves it untouched.
   */
  private async loadAndPlayMusic(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    const token = ++this.musicLoad;
    const url = this.currentMusicUrl();
    this.musicLoading = true;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`music ${res.status}`);
      const data = await res.arrayBuffer();
      if (data.byteLength === 0) throw new Error('empty music file');
      const buffer = await ctx.decodeAudioData(data);
      if (token !== this.musicLoad || this.ctx !== ctx) return;
      this.stopMusicSource();
      this.startMusicSource(buffer);
    } catch {
      if (token === this.musicLoad && !this.musicSource) this.musicStarted = false;
    } finally {
      if (token === this.musicLoad) this.musicLoading = false;
    }
  }

  private startMusicSource(buffer: AudioBuffer): void {
    if (!this.ctx || !this.musicAnalyser) return;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(this.musicAnalyser);
    source.onended = () => {
      // A loop only ends when stopped or the context dies. Clearing the flag
      // lets the next gesture / visibility event restart the soundtrack.
      if (this.musicSource === source) {
        this.musicSource = null;
        this.musicStarted = false;
      }
    };
    try {
      source.start();
      this.musicSource = source;
      this.musicStarted = true;
    } catch {
      try { source.disconnect(); } catch { /* already detached */ }
    }
  }

  private stopMusicSource(): void {
    const source = this.musicSource;
    this.musicSource = null;
    if (!source) return;
    source.onended = null;
    try { source.stop(); } catch { /* already stopped */ }
    try { source.disconnect(); } catch { /* already detached */ }
  }

  /** Read the music spectrum for party mode; silence when no track is playing. */
  musicLevels(): MusicLevels {
    if (!this.ctx || !this.musicAnalyser || !this.musicSource || this.ctx.state !== 'running') {
      return SILENT_LEVELS;
    }
    const analyser = this.musicAnalyser;
    const bins = analyser.frequencyBinCount;
    if (!this.musicFreq || this.musicFreq.length !== bins) this.musicFreq = new Uint8Array(bins);
    const data = this.musicFreq;
    analyser.getByteFrequencyData(data);
    const binHz = this.ctx.sampleRate / analyser.fftSize;
    const lowEnd = Math.max(1, Math.min(bins, Math.round(250 / binHz)));
    const midEnd = Math.max(lowEnd + 1, Math.min(bins, Math.round(2500 / binHz)));
    const highEnd = Math.max(midEnd + 1, Math.min(bins, Math.round(10000 / binHz)));
    const band = (start: number, end: number): number => {
      let sum = 0;
      for (let i = start; i < end; i++) sum += data[i];
      return end > start ? sum / (end - start) / 255 : 0;
    };
    const bass = band(0, lowEnd);
    const mid = band(lowEnd, midEnd);
    const high = band(midEnd, highEnd);
    return {
      energy: Math.min(1, bass * 0.65 + mid * 0.25 + high * 0.1),
      bass,
      mid,
      high,
    };
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
