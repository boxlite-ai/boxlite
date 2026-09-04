import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderDexConfig } from './local-dex-env.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const raw = fs.readFileSync(path.join(here, '..', 'dex', 'config.yaml'), 'utf8')

test('dev render keeps the documented admin@boxlite.dev / password login', () => {
  const out = renderDexConfig(raw, { dexIssuer: 'http://localhost:5556/dex', dashboardUrl: 'http://localhost:3000' })
  assert.match(out, /enablePasswordDB: true/)
  assert.match(out, /email: 'admin@boxlite\.dev'/)
  assert.match(out, /\$2a\$10\$2b2cU8CPhOTaGrs1HRQuAueS7JTT5ZHsHSzYiFPm1leZck7Mc8T4W/)
})

test('dev render substitutes placeholders and never emits wildcard CORS', () => {
  const out = renderDexConfig(raw, { dexIssuer: 'http://localhost:5556/dex', dashboardUrl: 'http://localhost:3000' })
  assert.ok(!out.includes('${DEX_ALLOWED_ORIGINS}'), 'DEX_ALLOWED_ORIGINS placeholder left unrendered')
  assert.ok(!out.includes("allowedOrigins: ['*']"), 'wildcard CORS present')
  assert.match(out, /allowedOrigins: \['http:\/\/localhost:3000'/)
})
