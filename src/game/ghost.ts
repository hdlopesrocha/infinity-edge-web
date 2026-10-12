// Ghost recording: port of GhostRecord.cs / importGhost .ghs files.
// Samples the player ship position over time, persists via the binary
// protocol framing (MsgType.GhostData, gzip-compressed) in localStorage —
// the web equivalent of IsolatedStorage .ghs files. Time-trial briefings
// report the stored ghost like the original importGhost flow.

import { decodeMessage, encodeMessage, MsgType } from './net';

export interface GhostSample {
  t: number; // seconds since level start
  pos: [number, number, number];
}

export interface GhostData {
  level: string;
  samples: GhostSample[];
}

const PREFIX = 'ie3d.ghost.';

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class GhostRecorder {
  private samples: GhostSample[] = [];
  private start = 0;

  begin(): void {
    this.samples = [];
    this.start = performance.now();
  }

  /** Record one sample (call ~1-2 Hz; GameView calls each second). */
  sample(pos: [number, number, number]): void {
    this.samples.push({ t: (performance.now() - this.start) / 1000, pos });
    if (this.samples.length > 3600) this.samples.shift();
  }

  get count(): number {
    return this.samples.length;
  }

  /** Serialize with protocol framing (gzip when beneficial). */
  serialize(level: string): Uint8Array {
    const floats = new Float32Array(this.samples.length * 4);
    this.samples.forEach((s, i) => {
      floats[i * 4] = s.t;
      floats[i * 4 + 1] = s.pos[0];
      floats[i * 4 + 2] = s.pos[1];
      floats[i * 4 + 3] = s.pos[2];
    });
    const payload = new Uint8Array(floats.buffer);
    const levelBytes = new TextEncoder().encode(level);
    const framed = new Uint8Array(2 + levelBytes.length + payload.length);
    framed[0] = levelBytes.length & 0xff;
    framed[1] = (levelBytes.length >> 8) & 0xff;
    framed.set(levelBytes, 2);
    framed.set(payload, 2 + levelBytes.length);
    return encodeMessage(MsgType.GhostData, framed, { compress: true });
  }

  save(level: string): void {
    try {
      localStorage.setItem(PREFIX + level, toB64(this.serialize(level)));
    } catch {
      /* storage unavailable */
    }
  }

  static async load(level: string): Promise<GhostData | null> {
    try {
      const raw = localStorage.getItem(PREFIX + level);
      if (!raw) return null;
      const msg = await decodeMessage(fromB64(raw));
      if (msg.type !== MsgType.GhostData) return null;
      const body = msg.payload;
      const nameLen = body[0] | (body[1] << 8);
      const name = new TextDecoder().decode(body.slice(2, 2 + nameLen));
      const floats = new Float32Array(body.buffer, body.byteOffset + 2 + nameLen);
      const samples: GhostSample[] = [];
      for (let i = 0; i + 4 <= floats.length; i += 4) {
        samples.push({ t: floats[i], pos: [floats[i + 1], floats[i + 2], floats[i + 3]] });
      }
      return { level: name, samples };
    } catch {
      return null; // malformed/decompression errors never break the game
    }
  }

  static has(level: string): boolean {
    try {
      return localStorage.getItem(PREFIX + level) !== null;
    } catch {
      return false;
    }
  }
}
