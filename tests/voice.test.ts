// Voice chat: the wire format, the pure DSP resampling helpers, and the
// Node-safe VoiceChat shell. No audio hardware is touched here -- browser
// paths need a real AudioContext, so the math carries the coverage.

import { describe, expect, it } from 'vitest';
import {
  VOICE_SAMPLE_RATE,
  VoiceChat,
  decodeVoiceFrame,
  encodeVoiceFrame,
  floatToPcm16,
  pcm16ToFloat,
  resamplePcm16,
  rmsLevel,
} from '../src/game/mp/voice';

describe('wire format', () => {
  it('pins the sample rate every peer must agree on', () => {
    expect(VOICE_SAMPLE_RATE).toBe(16000);
  });

  it('writes the speaker byte followed by little-endian samples', () => {
    const frame = encodeVoiceFrame(2, Int16Array.of(0x1234, -2));
    expect(Array.from(frame)).toEqual([2, 0x34, 0x12, 0xfe, 0xff]);
  });

  it('round-trips arbitrary samples', () => {
    const pcm = Int16Array.of(0, 1, -1, 32767, -32768, 4660, -4660);
    const decoded = decodeVoiceFrame(encodeVoiceFrame(5, pcm));
    expect(decoded).not.toBeNull();
    expect(decoded!.speaker).toBe(5);
    expect(Array.from(decoded!.pcm)).toEqual(Array.from(pcm));
  });

  it('clamps speaker indices into the single byte', () => {
    expect(encodeVoiceFrame(300, Int16Array.of(1))[0]).toBe(255);
    expect(encodeVoiceFrame(-7, Int16Array.of(1))[0]).toBe(0);
    expect(encodeVoiceFrame(NaN, Int16Array.of(1))[0]).toBe(0);
    expect(decodeVoiceFrame(encodeVoiceFrame(0, Int16Array.of(1)))!.speaker).toBe(0);
    expect(decodeVoiceFrame(encodeVoiceFrame(255, Int16Array.of(1)))!.speaker).toBe(255);
  });

  it('returns null for short, truncated, or empty frames', () => {
    expect(decodeVoiceFrame(new Uint8Array(0))).toBeNull();
    expect(decodeVoiceFrame(new Uint8Array([3]))).toBeNull();
    expect(decodeVoiceFrame(new Uint8Array([3, 0x10]))).toBeNull();
    // A dangling byte after the first sample: the frame was cut mid-sample.
    expect(decodeVoiceFrame(new Uint8Array([3, 0x10, 0x27, 0x00]))).toBeNull();
    const one = decodeVoiceFrame(new Uint8Array([3, 0x10, 0x27]));
    expect(one).not.toBeNull();
    expect(one!.speaker).toBe(3);
    expect(Array.from(one!.pcm)).toEqual([10000]);
  });
});

describe('resamplePcm16', () => {
  it('returns an identical copy for the same rate', () => {
    const input = Int16Array.of(0, 1000, -1000, 32767);
    const out = resamplePcm16(input, 44100, 44100);
    expect(out).not.toBe(input);
    expect(Array.from(out)).toEqual(Array.from(input));
  });

  it('doubles length and interpolates midpoints when upsampling 2x', () => {
    const out = resamplePcm16(Int16Array.of(0, 2000, 4000, 6000), 16000, 32000);
    expect(out.length).toBe(8);
    expect(Array.from(out)).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 6000]);
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]);
  });

  it('halves length when downsampling 2x', () => {
    const input = Int16Array.of(0, 1000, 2000, 3000, 4000, 5000, 6000, 7000);
    const out = resamplePcm16(input, 32000, 16000);
    expect(out.length).toBe(4);
    expect(Array.from(out)).toEqual([0, 2000, 4000, 6000]);
  });

  it('handles device rates that are not integer multiples', () => {
    const out = resamplePcm16(new Int16Array(4410).fill(1200), 44100, 16000);
    expect(out.length).toBe(1600);
    expect(out[0]).toBe(1200);
    expect(out[out.length - 1]).toBe(1200);
  });

  it('degenerates safely on empty input and bad rates', () => {
    expect(resamplePcm16(new Int16Array(0), 48000, 16000).length).toBe(0);
    expect(Array.from(resamplePcm16(Int16Array.of(1, 2), 0, 16000))).toEqual([1, 2]);
  });
});

describe('float and pcm conversion', () => {
  it('clamps floats to the int16 range', () => {
    const pcm = floatToPcm16(Float32Array.of(-1, 1, 2, -2, 0, 0.5));
    expect(Array.from(pcm)).toEqual([-32768, 32767, 32767, -32768, 0, 16384]);
  });

  it('round-trips every int16 value through floats', () => {
    const pcm = Int16Array.of(-32768, -12345, -1, 0, 1, 12345, 32767);
    expect(Array.from(floatToPcm16(pcm16ToFloat(pcm)))).toEqual(Array.from(pcm));
  });

  it('maps the pcm endpoints back to -1 and ~1', () => {
    const floats = pcm16ToFloat(Int16Array.of(-32768, 0, 32767));
    expect(floats[0]).toBe(-1);
    expect(floats[1]).toBe(0);
    expect(floats[2]).toBeCloseTo(1, 4);
  });
});

describe('rmsLevel', () => {
  it('is 0 for silence and empty input', () => {
    expect(rmsLevel(new Int16Array(0))).toBe(0);
    expect(rmsLevel(new Int16Array(128))).toBe(0);
  });

  it('is ~1 for a full-scale constant and ~0.5 for half scale', () => {
    expect(rmsLevel(new Int16Array(64).fill(32767))).toBeCloseTo(1, 3);
    expect(rmsLevel(new Int16Array(64).fill(-32768))).toBeCloseTo(1, 3);
    expect(rmsLevel(new Int16Array(64).fill(16384))).toBeCloseTo(0.5, 3);
  });
});

describe('VoiceChat (Node safety)', () => {
  it('constructs disabled and no-ops without browser audio', async () => {
    const voice = new VoiceChat();
    expect(voice.enabled).toBe(false);
    expect(voice.level()).toBe(0);
    expect(voice.onFrame).toBeNull();

    await expect(voice.enable()).resolves.toBe(false);
    await expect(voice.enable({ deviceId: 'default' })).resolves.toBe(false);
    expect(voice.enabled).toBe(false);

    expect(() => voice.play(1, Int16Array.of(1, 2))).not.toThrow();
    expect(() => voice.forget(1)).not.toThrow();
    expect(() => voice.disable()).not.toThrow();
    expect(() => voice.dispose()).not.toThrow();
    expect(voice.enabled).toBe(false);
    // dispose() is terminal: a pending or later enable() must stay off.
    await expect(voice.enable()).resolves.toBe(false);
  });

  it('tolerates junk sent to play', () => {
    const voice = new VoiceChat();
    expect(() => voice.play(NaN, new Int16Array(0))).not.toThrow();
    expect(() => voice.play(3, 'nope' as unknown as Int16Array)).not.toThrow();
    expect(() => voice.forget(NaN)).not.toThrow();
  });
});
