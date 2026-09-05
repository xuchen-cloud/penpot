import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: {
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        plugin: resolve(import.meta.dirname, 'src/plugin.ts'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'plugin' ? 'plugin.js' : 'assets/[name]-[hash].js',
      },
    },
  },
  preview: {
    port: 4302,
    cors: true,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
  },
});
