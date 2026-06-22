// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Seed a stage's deploy-time env config + secrets into AWS SSM Parameter Store,
 * so CI (GitHub Actions) can deploy with the SAME config a laptop's .env provides.
 *
 * Reads a .env file and writes each KEY=VALUE to /boxlite/<stage>/env/<KEY> as a
 * SecureString. The companion `sst-with-cloudflare.mjs` loads these back at deploy
 * time (an env var already set always wins, so laptops keep using .env unchanged).
 *
 * Secrets stay between this machine and AWS: values are passed to the AWS CLI as
 * argv (no shell interpolation) and are NEVER printed — only KEY names are logged.
 *
 * Usage:
 *   node scripts/seed-deploy-env-ssm.mjs                      # apps/infra/.env -> stage dev
 *   node scripts/seed-deploy-env-ssm.mjs --env .env --stage dev
 *   AWS_PROFILE=boxlite-sso node scripts/seed-deploy-env-ssm.mjs
 *   node scripts/seed-deploy-env-ssm.mjs --dry-run            # list keys, write nothing
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const REGION = process.env.AWS_REGION || 'ap-southeast-1'

// Machine-specific or handled-elsewhere — never seed these.
//   AWS_PROFILE       : a local profile name; on CI it would break OIDC creds.
//   CLOUDFLARE_*      : already seeded at /boxlite/<stage>/cloudflare-* and loaded
//                       by sst-with-cloudflare.mjs's existing CREDS path.
const EXCLUDE = new Set(['AWS_PROFILE', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_DEFAULT_ACCOUNT_ID'])

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const DRY = process.argv.includes('--dry-run')
const envPath = arg('--env', '.env') // default: ./.env (run from apps/infra)
const stage = arg('--stage', process.env.SST_STAGE || 'dev')

function parseEnv(text) {
  const out = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    let [, key, val] = m
    // strip a single layer of matching surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out.push([key, val])
  }
  return out
}

let text
try {
  text = readFileSync(envPath, 'utf8')
} catch {
  console.error(`seed-deploy-env-ssm: cannot read env file at '${envPath}' (cwd: ${process.cwd()})`)
  process.exit(1)
}

const pairs = parseEnv(text).filter(([k, v]) => !EXCLUDE.has(k) && v !== '')
console.log(`seed-deploy-env-ssm: stage=${stage} region=${REGION} -> /boxlite/${stage}/env/* (${pairs.length} keys)`)

let ok = 0
let failed = 0
for (const [key, val] of pairs) {
  const name = `/boxlite/${stage}/env/${key}`
  if (DRY) {
    console.log(`  would put ${name}`)
    continue
  }
  try {
    execFileSync(
      'aws',
      ['ssm', 'put-parameter', '--region', REGION, '--name', name, '--type', 'SecureString', '--overwrite', '--value', val],
      { stdio: ['ignore', 'ignore', 'pipe'] }, // never echo the value or the version output
    )
    console.log(`  ✓ ${key}`)
    ok++
  } catch (err) {
    const msg = (err.stderr ? err.stderr.toString() : err.message).split('\n')[0]
    console.error(`  ✗ ${key}: ${msg}`)
    failed++
  }
}
console.log(DRY ? 'seed-deploy-env-ssm: dry-run, nothing written' : `seed-deploy-env-ssm: wrote ${ok}/${pairs.length}`)
if (failed > 0) process.exit(1)
