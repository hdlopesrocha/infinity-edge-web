import { describe, expect, it } from 'vitest';
import {
  AIMBOT_PRESETS, DEFAULT_AIMBOT_ID, aimbotEngages, applyAimbotPreset, resolveAimbot,
} from '../src/game/aimbot';
import { defaultOptions } from '../src/game/resources';

describe('aimbot preset catalogue', () => {
  it('ships exactly three presets, each with the full shape', () => {
    expect(AIMBOT_PRESETS).toHaveLength(3);
    for (const p of AIMBOT_PRESETS) {
      expect(typeof p.id).toBe('string');
      expect(p.id.length).toBeGreaterThan(0);
      expect(typeof p.label).toBe('string');
      expect(typeof p.aimbotAngle).toBe('number');
      expect(typeof p.aimbotDistance).toBe('number');
      expect(typeof p.aimbotThreshold).toBe('number');
      expect(typeof p.assist).toBe('number');
    }
    // Distinct ids so a stored option resolves unambiguously.
    expect(new Set(AIMBOT_PRESETS.map((p) => p.id)).size).toBe(3);
  });

  it('orders the presets easiest first and defaults to the easiest', () => {
    expect(DEFAULT_AIMBOT_ID).toBe(AIMBOT_PRESETS[0].id);
    expect(defaultOptions().aimbot).toBe(DEFAULT_AIMBOT_ID);
    const [easiest, ...harder] = AIMBOT_PRESETS;
    for (const p of harder) {
      // Smaller dot = wider aim cone; longer range, more forgiving stick gate
      // and stronger assist all make the easiest preset the most helpful.
      expect(easiest.aimbotAngle).toBeLessThan(p.aimbotAngle);
      expect(easiest.aimbotDistance).toBeGreaterThan(p.aimbotDistance);
      expect(easiest.aimbotThreshold).toBeGreaterThan(p.aimbotThreshold);
      expect(easiest.assist).toBeGreaterThanOrEqual(p.assist);
    }
  });

  it('resolves known ids and falls back to the default for missing/invalid ones', () => {
    for (const p of AIMBOT_PRESETS) expect(resolveAimbot(p.id).id).toBe(p.id);
    expect(resolveAimbot('nope').id).toBe(DEFAULT_AIMBOT_ID);
    expect(resolveAimbot('').id).toBe(DEFAULT_AIMBOT_ID);
    expect(resolveAimbot(undefined).id).toBe(DEFAULT_AIMBOT_ID);
    expect(resolveAimbot(null).id).toBe(DEFAULT_AIMBOT_ID);
  });

  it('applies a preset onto a ship carrier', () => {
    const ship = { aimbotAngle: 0.9, aimbotDistance: 128, aimbotThreshold: 0.35 };
    applyAimbotPreset(ship, AIMBOT_PRESETS[2]);
    expect(ship).toEqual({
      aimbotAngle: AIMBOT_PRESETS[2].aimbotAngle,
      aimbotDistance: AIMBOT_PRESETS[2].aimbotDistance,
      aimbotThreshold: AIMBOT_PRESETS[2].aimbotThreshold,
    });
  });
});

describe('aimbotEngages', () => {
  it('engages below the threshold', () => {
    expect(aimbotEngages(0, 0.35)).toBe(true);
    expect(aimbotEngages(0.34, 0.35)).toBe(true);
  });

  it('engages exactly at the threshold', () => {
    expect(aimbotEngages(0.35, 0.35)).toBe(true);
    expect(aimbotEngages(0, 0)).toBe(true);
  });

  it('does not engage above the threshold', () => {
    expect(aimbotEngages(0.36, 0.35)).toBe(false);
    expect(aimbotEngages(1, 0.35)).toBe(false);
    expect(aimbotEngages(0.5, 0)).toBe(false);
  });
});
