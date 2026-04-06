import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    exclude: ['test/interop/**'],
    globals: false,
  },
});
