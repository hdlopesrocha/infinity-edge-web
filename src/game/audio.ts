// Audio: Web Audio API for SFX + voices, <audio> for looping music.
// Port of ResourceCenter audio (MediaPlayer looping Song + SoundEffect.Play +
// Voice text lines). Autoplay policy: everything unlocks on first user gesture.

export const SFX = [
  'button', 'bulletSound', 'missileSound', 'hitSound', 'addonSound',
  'absorbSound', 'closeExplosion', 'farExplosion',
] as const;

export const VOICES = [
  'Welcome', 'Warning', 'TargetAquired', 'MissileIncoming',
  'IncomingHomingMissile', 'CriticalDamage', 'NewEnemyWave', 'Teleported',
  'YouWereTeleported', 'LeavingFieldOfBattle', 'ObjectiveCompleted', 'YouLost',
  'OurFlagWasStolen', 'OurTeamHasTheFlag', 'EnemyTeamHasTheFlag',
  'OurTeamRecoveredTheFlag', 'EnemyTeamRecoveredTheFlag',
] as const;

export const VOICE_TEXT: Record<string, string> = {
  Welcome: 'Welcome to Infinity Edge',
  Warning: 'Warning',
  TargetAquired: 'Target acquired',
  MissileIncoming: 'Missile incoming',
  IncomingHomingMissile: 'Incoming homing missile',
  CriticalDamage: 'Critical damage',
  NewEnemyWave: 'New enemy wave',
  Teleported: 'Teleported',
  YouWereTeleported: 'You were teleported',
  LeavingFieldOfBattle: 'Leaving field of battle',
  ObjectiveCompleted: 'Objective completed',
  YouLost: 'You lost',
  OurFlagWasStolen: 'Our flag was stolen',
  OurTeamHasTheFlag: 'Our team has the flag',
  EnemyTeamHasTheFlag: 'Enemy team has the flag',
  OurTeamRecoveredTheFlag: 'Our team recovered the flag',
  EnemyTeamRecoveredTheFlag: 'Enemy team recovered the flag',
};

function assetUrl(kind: 'sfx' | 'music', name: string): string {
  const ext = kind === 'music' ? 'mp3' : 'wav';
  return import.meta.env.BASE_URL + `assets/sounds/${name}.${ext}`;
}

class AudioManager {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private musicEl: HTMLAudioElement | null = null;
  private unlocked = false;
  musicVolume = 0.7;
  muted = false;

  /** Must be called from a user gesture at least once. */
  unlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    try {
      if (!this.ctx) this.ctx = new AudioContext();
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      /* no audio */
    }
    // Start looping music like Game1.LoadContent (MediaPlayer, IsRepeating).
    try {
      if (!this.musicEl) {
        this.musicEl = new Audio(assetUrl('music', 'sound'));
        this.musicEl.loop = true;
        this.musicEl.volume = this.muted ? 0 : this.musicVolume;
        const p = this.musicEl.play();
        if (p) p.catch(() => {
          /* still blocked; retry on next gesture */
          this.unlocked = false;
        });
      } else if (this.musicEl.paused) {
        this.musicEl.volume = this.muted ? 0 : this.musicVolume;
        void this.musicEl.play().catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
  }

  setMusicVolume(v: number): void {
    this.musicVolume = v;
    if (this.musicEl) this.musicEl.volume = this.muted ? 0 : v;
  }

  private async buffer(name: string): Promise<AudioBuffer | null> {
    if (!this.ctx) return null;
    const hit = this.buffers.get(name);
    if (hit) return hit;
    try {
      const res = await fetch(assetUrl('sfx', name));
      if (!res.ok) return null;
      const data = await res.arrayBuffer();
      const buf = await this.ctx.decodeAudioData(data);
      this.buffers.set(name, buf);
      return buf;
    } catch {
      return null;
    }
  }

  /** Fire-and-forget SFX (SoundEffect.Play). */
  async play(name: string, volume = 1): Promise<void> {
    if (!this.unlocked || this.muted) return;
    try {
      if (!this.ctx) this.ctx = new AudioContext();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      const buf = await this.buffer(name);
      if (!buf || !this.ctx) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const g = this.ctx.createGain();
      g.gain.value = volume;
      src.connect(g).connect(this.ctx.destination);
      src.start();
    } catch {
      /* ignore */
    }
  }

  /** Voice line + subtitle text (Voice.Play + GetText). Returns subtitle. */
  async speak(name: string): Promise<string> {
    void this.play(name, 1);
    return VOICE_TEXT[name] ?? name;
  }
}

export const audio = new AudioManager();
