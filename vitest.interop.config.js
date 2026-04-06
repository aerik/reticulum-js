import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/interop/**/*.test.js'],
    globals: false,
    testTimeout: 30000,
  },
});
