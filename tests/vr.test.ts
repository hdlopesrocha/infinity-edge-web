import { describe, expect, it } from 'vitest';
import { isVrLongPress, VR_LONG_PRESS_MS } from '../src/game/vr';

describe('VR long-press threshold', () => {
  it('keeps short taps short', () => {
    expect(isVrLongPress(0)).toBe(false);
    expect(isVrLongPress(VR_LONG_PRESS_MS - 1)).toBe(false);
  });

  it('classifies the threshold itself as a long press', () => {
    expect(isVrLongPress(VR_LONG_PRESS_MS)).toBe(true);
    expect(isVrLongPress(VR_LONG_PRESS_MS + 250)).toBe(true);
  });

  it('uses a 600-800 ms hold across both VR paths', () => {
    expect(VR_LONG_PRESS_MS).toBeGreaterThanOrEqual(600);
    expect(VR_LONG_PRESS_MS).toBeLessThanOrEqual(800);
  });
});
