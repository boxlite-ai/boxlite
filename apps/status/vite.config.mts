/// <reference types="vitest" />

import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig } from 'vite'
import checker from 'vite-plugin-checker'

export default defineConfig((mode) => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/apps/status',
  server: {
    host: '0.0.0.0',
    port: 3002,
  },
  plugins: [
    react(),
    mode.command === 'build' &&
      checker({
        typescript: {
          tsconfigPath: './tsconfig.app.json',
        },
      }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: '../dist/apps/status',
    emptyOutDir: true,
    reportCompressedSize: true,
  },
  test: {
    environment: 'jsdom',
  },
}))
