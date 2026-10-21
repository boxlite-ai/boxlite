// Bundles the control plane into one file so deploying is "copy dist/server.mjs and run it".
import { copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

// The SQL guard parses with libpg-query's wasm build. Its emscripten loader is CommonJS-style:
// it reads `__dirname` and loads libpg-query.wasm from there. An ESM bundle has no __dirname,
// so free references to it are pointed at the bundle's own directory (banner below) and the wasm
// ships beside dist/server.mjs.
const pgQueryDir = dirname(createRequire(import.meta.url).resolve('libpg-query'));

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  // The CP runs inside a BoxLite `node` image Box, which ships Node 22.
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // pg optionally requires pg-native; it is never installed.
  external: ['pg-native'],
  define: { __dirname: '__bundleDirname', __filename: '__bundleFilename' },
  // Bundled CJS deps (pg, libpg-query) call require() and read __dirname; give the ESM bundle both.
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      "import { fileURLToPath as __fu } from 'node:url';",
      'const require = __cr(import.meta.url);',
      'const __bundleFilename = __fu(import.meta.url);',
      "const __bundleDirname = __bundleFilename.slice(0, __bundleFilename.lastIndexOf('/'));",
    ].join(' '),
  },
  logLevel: 'warning',
});

copyFileSync(join(pgQueryDir, 'libpg-query.wasm'), 'dist/libpg-query.wasm');
