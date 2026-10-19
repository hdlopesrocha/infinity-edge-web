import { describe, expect, it } from 'vitest';
import { WORDMARK_FAMILY, loadWordmarkFont, wordmarkFont } from '../src/game/fonts';

describe('wordmark font', () => {
  it('uses the bundled Airstrike family with a readable fallback', () => {
    expect(WORDMARK_FAMILY).toBe('Airstrike');
    const stack = wordmarkFont(64.4);
    expect(stack).toContain('64px Airstrike');
    expect(stack).toContain('DejaVu Sans');
  });

  it('clamps non-positive sizes', () => {
    expect(wordmarkFont(0)).toContain('1px Airstrike');
    expect(wordmarkFont(-10)).toContain('1px Airstrike');
  });

  it('is Node-safe: loading resolves false without a DOM/font API', async () => {
    await expect(loadWordmarkFont()).resolves.toBe(false);
  });
});
