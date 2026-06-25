/// <reference types='vitest' />
import { nxCopyAssetsPlugin } from '@nx/vite/plugins/nx-copy-assets.plugin'
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { defineConfig } from 'vite'
import { analyzer } from 'vite-bundle-analyzer'
import checker from 'vite-plugin-checker'

const outDir = '../dist/apps/dashboard'

export default defineConfig((mode) => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/apps/dashboard',
  server: {
    port: 3000,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        // Defaults to the local API. Override with DASHBOARD_API_PROXY_TARGET to
        // point the dashboard at a remote API (e.g. https://dev.boxlite.ai) through
        // this same-origin proxy, so the browser never makes a cross-origin
        // (CORS-gated) request — Vite talks to the API server-to-server.
        target: process.env.DASHBOARD_API_PROXY_TARGET || 'http://localhost:3001',
        ws: true,
        changeOrigin: true,
        rewriteWsOrigin: true,
      },
    },
    watch: {
      ignored: ['**/node_modules/**'],
    },
  },
  plugins: [
    react(),
    nxViteTsPaths(),
    nxCopyAssetsPlugin(['*.md']),
    // enforce typechecking for build mode
    mode.command === 'build' &&
      checker({
        typescript: {
          tsconfigPath: './tsconfig.app.json',
        },
      }),

    {
      name: 'exclude-msw',
      apply: 'build',
      writeBundle() {
        if (mode.mode === 'production') {
          const mswPath = path.resolve(__dirname, outDir, 'mockServiceWorker.js')

          if (fs.existsSync(mswPath)) {
            fs.rmSync(mswPath)
            console.log('Removed mockServiceWorker.js from production build.')
          }
        }
      },
    },
    analyzer({
      openAnalyzer: false,
      analyzerPort: 4000,
      enabled: mode.mode === 'analyze',
    }),
  ],
  resolve: {
    alias: [
      // Target @ but not @boxlite-ai,
      {
        // find: /^@(?!boxlite-ai)/,
        find: '@',
        replacement: path.resolve(__dirname, './src'), // Make sure this points to dashboard's src
      },
    ],
  },
  // Uncomment this if you are using workers.
  // worker: {
  //  plugins: [ nxViteTsPaths() ],
  // },
  optimizeDeps: {
    exclude: ['tar'],
  },
  build: {
    outDir,
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    // we'd ideally polyfill it but until https://github.com/davidmyersdev/vite-plugin-node-polyfills/issues/118 gets resolved we can just exclude it
    rollupOptions: {
      external: ['tar'],
      output: {
        // Pin two broadly-shared vendor groups into stable, cacheable chunks:
        // @tanstack/* (react-query + react-table are both on the first-paint
        // boxes path) and react-router. Everything else is intentionally left
        // to Rollup's default splitting, so deps used ONLY by lazy routes
        // (recharts on Admin/Billing, xterm/monaco on box-details) land in those
        // async chunks instead of the eager entry — a catch-all `vendor` bucket
        // would force them back eager.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('@tanstack')) return 'tanstack'
          if (id.includes('react-router') || id.includes('@remix-run/router')) return 'router'
          return undefined
        },
      },
    },
  },
}))
