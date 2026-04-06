/**
 * Vite config for building the browser bundle.
 *
 * Produces:
 *   dist/reticulum.es.js  — ESM bundle
 *   dist/reticulum.umd.js — UMD bundle (for <script> tags)
 *
 * Usage: npx vite build --config vite.browser.config.js
 */

import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(import.meta.dirname, 'src/browser.js'),
      name: 'Reticulum',
      formats: ['es', 'umd'],
      fileName: (format) => `reticulum.${format}.js`,
    },
    outDir: 'dist',
    target: 'es2020',
    minify: false, // keep readable for debugging
    rollupOptions: {
      // Mark Node-only modules as external (shouldn't be imported by browser.js,
      // but just in case any transitive import pulls them in)
      external: ['net', 'dgram', 'fs', 'fs/promises', 'os', 'path', 'crypto'],
    },
  },
});
