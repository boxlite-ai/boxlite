// A real build step: stamp the build time into a generated asset, so the e2e can tell builds apart.
import { mkdirSync, writeFileSync } from 'node:fs'
mkdirSync('dist', { recursive: true })
writeFileSync('dist/build.json', JSON.stringify({ built_at: new Date().toISOString(), version: process.env.APP_VERSION ?? 'v1' }))
