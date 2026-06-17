// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Run an `sst` command with the Cloudflare provider credentials loaded.
 *
 * The Cloudflare provider initializes inside `app()` (sst.config.ts), before
 * `run()` exists — so its credentials can't be `sst.Secret` like the app
 * secrets. They live in AWS SSM Parameter Store (SecureString) instead, keyed
 * per stage, and this wrapper fetches + exports them just before invoking sst.
 * App secrets are NOT handled here; sst resolves those from its own store.
 *
 * Wired into the dev/deploy/remove npm scripts, plus a passthrough:
 *   npm run deploy -- --stage dev      → node sst-with-cloudflare.mjs deploy --stage dev
 *   npm run sst -- diff --stage dev     → any other subcommand
 *
 * One access gate: a deployer already needs AWS credentials to deploy, so the
 * same credentials fetch the Cloudflare token from SSM — nothing extra to share.
 *
 * Seed the parameters once per stage:
 *   aws ssm put-parameter --region ap-southeast-1 --type SecureString \
 *     --name /boxlite/<stage>/cloudflare-api-token   --value "<token>"
 *   aws ssm put-parameter --region ap-southeast-1 --type SecureString \
 *     --name /boxlite/<stage>/cloudflare-account-id  --value "<account-id>"
 *
 * A credential already in the environment is used as-is (works offline / before
 * the params are seeded). Missing creds are a warning, not a hard stop: commands
 * that don't touch Cloudflare (e.g. `unlock`) still run, and sst surfaces its own
 * error for one that does.
 */

import { execFileSync, spawnSync } from 'node:child_process'

const REGION = process.env.AWS_REGION || 'ap-southeast-1'

// SSM param consulted only when the matching env var is unset.
const CREDS = [
  { env: 'CLOUDFLARE_API_TOKEN', param: 'cloudflare-api-token' },
  { env: 'CLOUDFLARE_DEFAULT_ACCOUNT_ID', param: 'cloudflare-account-id' },
]

const sstArgs = process.argv.slice(2)
if (sstArgs.length === 0) {
  console.error('sst-with-cloudflare: expected an sst subcommand (e.g. "deploy --stage dev")')
  process.exit(1)
}

// Resolve the stage from the sst args (--stage x or --stage=x); the SSM path is
// per-stage. Falls back to SST_STAGE then "dev".
function resolveStage(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--stage' && args[i + 1]) return args[i + 1]
    const m = args[i].match(/^--stage=(.+)$/)
    if (m) return m[1]
  }
  return process.env.SST_STAGE || 'dev'
}

function fetchFromSsm(name) {
  try {
    const out = execFileSync(
      'aws',
      ['ssm', 'get-parameter', '--region', REGION, '--name', name, '--with-decryption', '--query', 'Parameter.Value', '--output', 'text'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim()
    return out && out !== 'None' ? out : null
  } catch (err) {
    if (err.code === 'ENOENT') console.warn('sst-with-cloudflare: `aws` CLI not found; skipping SSM lookup')
    return null // ParameterNotFound / auth error → warn below and let sst decide
  }
}

const stage = resolveStage(sstArgs)

for (const { env, param } of CREDS) {
  if (process.env[env]) continue // already provided — don't touch
  const name = `/boxlite/${stage}/${param}`
  const value = fetchFromSsm(name)
  if (value) {
    process.env[env] = value
  } else {
    console.warn(
      `sst-with-cloudflare: ${env} not in env and ${name} not in SSM (${REGION}); ` +
        `seed it with: aws ssm put-parameter --region ${REGION} --type SecureString --name ${name} --value <...>`,
    )
  }
}

// node_modules/.bin is on PATH because this runs via `npm run`, so `sst` resolves.
const result = spawnSync('sst', sstArgs, { stdio: 'inherit', env: process.env })
if (result.error) {
  console.error(`sst-with-cloudflare: failed to launch sst: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
