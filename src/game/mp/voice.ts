// Push-to-talk voice chat that rides the multiplayer data channels as raw
// PCM: no codec, no audio library.
//
// Wire format (frozen; every peer must agree):
//   [u8 speakerIndex][int16 little-endian mono samples...]
// The wire sample rate is fixed at 16 kHz so peers never need to know each
// other's device rates: capture resamples down to it and playback resamples
// back up to whatever the output AudioContext runs at.
//
// The pure helpers stay browser-free so vitest can exercise the wire format
// and the resampling math in Node; every Web Audio use is guarded and
// enable() reports failure by returning false instead of throwing.

export const VOICE_SAMPLE_RATE = 16000;

/** Samples in one outgoing capture frame (~64 ms at 16 kHz). */
const CAPTURE_FRAME_SAMPLES = (VOICE_SAMPLE_RATE * 64) / 1000;

/** Latency budget per speaker; past this the oldest audio is dropped. */
const PLAYBACK_BACKLOG_SECONDS = 0.25;

/**
 * Linear-interpolation resample of 16-bit PCM. Pure and dependency-free so
 * the rate conversion is testable without any audio hardware.
 */
export function resamplePcm16(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (input.length === 0 || fromRate === toRate) return new Int16Array(input);
  // Guard bad rates instead of producing NaN/Infinity lengths downstream.
  if (!(fromRate > 0) || !(toRate > 0)) return new Int16Array(input);
  const length = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Int16Array(length);
  const step = fromRate / toRate;
  const last = input.length - 1;
  for (let i = 0; i < length; i++) {
    const pos = i * step;
    const i0 = Math.min(Math.floor(pos), last);
    const i1 = Math.min(i0 + 1, last);
    const t = pos - i0;
    out[i] = Math.round(input[i0] * (1 - t) + input[i1] * t);
  }
  return out;
}

/** Converts float samples in [-1, 1] to int16, clamping instead of wrapping. */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const v = Math.max(-1, Math.min(1, input[i]));
    // -32768 stays exact on the negative side; the positive side must stop at
    // 32767 or +1 would overflow the cast.
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32768)));
  }
  return out;
}

/** Converts int16 samples to floats in [-1, 1), the inverse of floatToPcm16. */
export function pcm16ToFloat(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i] / 32768;
  return out;
}

/** Root-mean-square level in 0..1, used by the UI microphone meter. */
export function rmsLevel(input: Int16Array): number {
  if (input.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < input.length; i++) {
    const v = input[i] / 32768;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / input.length));
}

/** Speaker index occupies one byte; anything else is clamped into range. */
function speakerByte(speaker: number): number {
  if (!Number.isFinite(speaker)) return 0;
  return Math.max(0, Math.min(255, Math.floor(speaker)));
}

/** Encodes one wire frame: [u8 speaker][int16 LE samples...]. */
export function encodeVoiceFrame(speaker: number, pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(1 + pcm.length * 2);
  out[0] = speakerByte(speaker);
  const view = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(1 + i * 2, pcm[i], true);
  return out;
}

/**
 * Decodes one wire frame. Returns null for malformed input: empty frames, a
 * frame without a sample, or a sample list with a dangling byte (truncated).
 */
export function decodeVoiceFrame(frame: Uint8Array): { speaker: number; pcm: Int16Array } | null {
  if (!frame || !(frame instanceof Uint8Array)) return null;
  if (frame.length < 3 || frame.length % 2 === 0) return null;
  const pcm = new Int16Array((frame.length - 1) >> 1);
  const view = new DataView(frame.buffer, frame.byteOffset + 1, pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(i * 2, true);
  return { speaker: frame[0], pcm };
}

export interface VoiceCaptureOptions {
  deviceId?: string;
}

/** One speaker's playback state: queued chunks plus a scheduling cursor. */
interface PlaybackQueue {
  /** Context-rate mono chunks not yet handed to the audio graph. */
  chunks: Float32Array[];
  /** Scheduled sources, kept only so a latency skip can cancel them. */
  sources: AudioBufferSourceNode[];
  /** Context time at which the next queued chunk starts. */
  cursor: number;
}

export class VoiceChat {
  /** Called with 16 kHz mono PCM chunks (~40-80 ms each) while enabled. */
  onFrame: ((pcm: Int16Array) => void) | null = null;

  private active = false;
  private disposed = false;
  /** Bumped by disable()/dispose(), invalidating an in-flight enable(). */
  private generation = 0;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  /** Input device rate, cached so the callback never touches a closed context. */
  private ctxRate = VOICE_SAMPLE_RATE;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private inputLevel = 0;
  private pending = new Int16Array(CAPTURE_FRAME_SAMPLES);
  private pendingFill = 0;
  private queues = new Map<number, PlaybackQueue>();

  get enabled(): boolean {
    return this.active;
  }

  /**
   * Asks for the microphone and starts capturing. Returns false (never
   * throws) when permission is denied, no device exists, or the browser has
   * no usable Web Audio implementation.
   */
  async enable(options: VoiceCaptureOptions = {}): Promise<boolean> {
    if (this.disposed) return false;
    if (this.active) return true;
    if (typeof window === 'undefined' || typeof AudioContext === 'undefined') return false;
    const media: MediaDevices | undefined = navigator.mediaDevices;
    if (!media || typeof media.getUserMedia !== 'function') return false;

    const gen = ++this.generation;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    try {
      const audio: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      if (options.deviceId) audio.deviceId = { exact: options.deviceId };
      stream = await media.getUserMedia({ audio });
      // disable()/dispose() may land while the permission prompt is up.
      if (gen !== this.generation) throw new Error('voice capture superseded');
      ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(1024, 1, 1);
      processor.onaudioprocess = (ev) => this.process(ev, processor);
      source.connect(processor);
      // Connect the (never written) output so the processor keeps being
      // clocked; silently outputting means nothing is monitored, no feedback.
      processor.connect(ctx.destination);
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);

      this.stream = stream;
      this.ctx = ctx;
      this.ctxRate = ctx.sampleRate;
      this.source = source;
      this.processor = processor;
      this.pendingFill = 0;
      this.inputLevel = 0;
      this.active = true;
      return true;
    } catch {
      // Permission denied, no device, or broken Web Audio: release what was
      // already acquired and let the caller show "microphone unavailable".
      this.release(stream, ctx);
      return false;
    }
  }

  /** Stops capture and playback; a later enable() can start them again. */
  disable(): void {
    this.generation++;
    this.active = false;
    this.inputLevel = 0;
    this.pendingFill = 0;
    const processor = this.processor;
    this.processor = null;
    if (processor) {
      try { processor.onaudioprocess = null; processor.disconnect(); } catch { /* already detached */ }
    }
    const source = this.source;
    this.source = null;
    if (source) {
      try { source.disconnect(); } catch { /* already detached */ }
    }
    const stream = this.stream;
    this.stream = null;
    const ctx = this.ctx;
    this.ctx = null;
    this.release(stream, ctx);
    this.clearQueues();
  }

  /** Terminal teardown: like disable(), and enable() will refuse to restart. */
  dispose(): void {
    this.disable();
    this.disposed = true;
    this.onFrame = null;
  }

  /** Latest input level 0..1 for the UI meter; 0 while disabled. */
  level(): number {
    return this.active ? this.inputLevel : 0;
  }

  /**
   * Plays one received frame for a speaker. Per-speaker queues; safe to call
   * with junk, and a no-op when capture (and therefore the context) is off.
   */
  play(speaker: number, pcm: Int16Array): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') return;
    if (!(pcm instanceof Int16Array) || pcm.length === 0) return;
    if (pcm.length > VOICE_SAMPLE_RATE) return; // over a second: not a voice frame
    try {
      const key = speakerByte(speaker);
      let queue = this.queues.get(key);
      if (!queue) {
        queue = { chunks: [], sources: [], cursor: 0 };
        this.queues.set(key, queue);
      }
      const now = ctx.currentTime;
      if (queue.cursor < now) queue.cursor = now; // the queue ran dry
      // Latency cap: once a speaker's backlog passes the budget, discard it
      // and re-anchor at "now" so delay cannot grow without bound.
      if (queue.cursor - now > PLAYBACK_BACKLOG_SECONDS) {
        this.cancelQueue(queue);
        queue.cursor = now;
      }
      const up = resamplePcm16(pcm, VOICE_SAMPLE_RATE, ctx.sampleRate);
      queue.chunks.push(pcm16ToFloat(up));
      this.drain(queue, ctx, now);
    } catch { /* a bad frame must never break the caller */ }
  }

  /** Drops queued audio for a speaker, e.g. when they leave the room. */
  forget(speaker: number): void {
    const key = speakerByte(speaker);
    const queue = this.queues.get(key);
    if (!queue) return;
    this.cancelQueue(queue);
    this.queues.delete(key);
  }

  /** Downmixes a ScriptProcessor callback and packs it into wire frames. */
  private process(ev: AudioProcessingEvent, processor: ScriptProcessorNode): void {
    if (!this.active || this.processor !== processor) return;
    try {
      const input = ev.inputBuffer;
      const frames = input.length;
      const channels = Math.max(1, input.numberOfChannels);
      const mono = new Float32Array(frames);
      for (let c = 0; c < channels; c++) {
        const data = input.getChannelData(c);
        for (let i = 0; i < frames; i++) mono[i] += data[i];
      }
      if (channels > 1) {
        for (let i = 0; i < frames; i++) mono[i] /= channels;
      }
      const pcm = resamplePcm16(floatToPcm16(mono), this.ctxRate, VOICE_SAMPLE_RATE);
      this.inputLevel = rmsLevel(pcm);
      this.appendFrame(pcm);
    } catch { /* never throw out of an audio callback */ }
  }

  /**
   * Packs callbacks into whole ~64 ms frames: 1024 script-processor frames
   * are only ~21 ms at 48 kHz, so forwarding each callback would triple the
   * number of data-channel messages for no benefit.
   */
  private appendFrame(pcm: Int16Array): void {
    let offset = 0;
    while (offset < pcm.length) {
      const take = Math.min(this.pending.length - this.pendingFill, pcm.length - offset);
      this.pending.set(pcm.subarray(offset, offset + take), this.pendingFill);
      this.pendingFill += take;
      offset += take;
      if (this.pendingFill === this.pending.length) {
        this.pendingFill = 0;
        // Hand out a copy: the accumulator is reused for the next frame.
        try { this.onFrame?.(this.pending.slice()); } catch { /* consumer error */ }
      }
    }
  }

  /** Hands each queued chunk to the graph at, and after, the cursor. */
  private drain(queue: PlaybackQueue, ctx: AudioContext, now: number): void {
    while (queue.chunks.length > 0) {
      const chunk = queue.chunks.shift()!;
      const buffer = ctx.createBuffer(1, Math.max(1, chunk.length), ctx.sampleRate);
      buffer.getChannelData(0).set(chunk);
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(ctx.destination);
      const startAt = Math.max(queue.cursor, now);
      node.start(startAt);
      queue.cursor = startAt + buffer.duration;
      queue.sources.push(node);
      node.onended = () => {
        const i = queue.sources.indexOf(node);
        if (i >= 0) queue.sources.splice(i, 1);
      };
    }
  }

  /** Stops scheduled sources and drops queued chunks for one speaker. */
  private cancelQueue(queue: PlaybackQueue): void {
    queue.chunks.length = 0;
    for (const node of queue.sources) {
      try {
        node.onended = null;
        node.stop();
        node.disconnect();
      } catch { /* already ended */ }
    }
    queue.sources.length = 0;
  }

  private clearQueues(): void {
    for (const queue of this.queues.values()) this.cancelQueue(queue);
    this.queues.clear();
  }

  /** Stops tracks and closes the context, tolerating every failure mode. */
  private release(stream: MediaStream | null, ctx: AudioContext | null): void {
    if (stream) {
      try {
        for (const track of stream.getTracks()) track.stop();
      } catch { /* already stopped */ }
    }
    if (ctx) {
      try {
        if (ctx.state !== 'closed') void ctx.close().catch(() => undefined);
      } catch { /* already closed */ }
    }
  }
}
