import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The converted assets under public/assets are read from disk by the model
    // test; everything else is pure logic (no DOM needed).
    testTimeout: 20000,
  },
});
