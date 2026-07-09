// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Run an `sst` command with the Cloudflare provider credentials loaded.
 *
 * The Cloudflare provider initializes inside `app()` (sst.config.ts), before
 * `run()` exists — so its credentials can't be `sst.Secret` like the app
 * secrets. They live in AWS SSM Parameter Store (SecureString) instead, keyed
 * per stage, and this wrapper fetches + exports them just before invoking sst.
 * App secrets are normally resolved by SST from its own store. For self-hosted
 * deploys, set BOXLITE_ENV_SOURCE=ssm to sync /boxlite/<stage>/env/* into this
 * app's .env and load the subset that SST models as sst.Secret.
 *
 * Wired into the dev/deploy/remove npm scripts, plus a passthrough:
 *   npm run deploy -- --stage dev      → node sst-with-cloudflare.mjs deploy --stage dev
 *   npm run sst -- diff --stage dev     → any other subcommand
 *
 * One access gate: a deployer already needs AWS credentials to deploy, so the
 * same credentials fetch the Cloudflare token from SSM — nothing extra to share.
 *
 * Seed the parameters once per stage:
 *   aws ssm put-parameter --region <stage-region> --type SecureString \
 *     --name /boxlite/<stage>/cloudflare-api-token   --value "<token>"
 *   aws ssm put-parameter --region <stage-region> --type SecureString \
 *     --name /boxlite/<stage>/cloudflare-account-id  --value "<account-id>"
 *
 * A credential already in the environment is used as-is (works offline / before
 * the params are seeded). Missing creds are a warning, not a hard stop: commands
 * that don't touch Cloudflare (e.g. `unlock`) still run, and sst surfaces its own
 * error for one that does.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const DEFAULT_REGION = 'ap-southeast-1'
const STAGE_REGIONS = {
  dev: 'ap-southeast-1',
  prod: 'us-west-2',
  production: 'us-west-2',
}

// SSM param consulted only when the matching env var is unset.
const CREDS = [
  { env: 'CLOUDFLARE_API_TOKEN', param: 'cloudflare-api-token' },
  { env: 'CLOUDFLARE_DEFAULT_ACCOUNT_ID', param: 'cloudflare-account-id' },
]

const CONFIG_COMMANDS = new Set(['deploy', 'dev', 'diff', 'remove'])
const DEFAULT_PRODUCT_ENV_PREFIX_TEMPLATE = '/boxlite/{stage}/env'
const DEFAULT_SST_SECRET_KEYS = [
  'OIDC_CLIENT_ID',
  'OIDC_MANAGEMENT_API_CLIENT_ID',
  'OIDC_MANAGEMENT_API_CLIENT_SECRET',
  'POSTHOG_API_KEY',
  'SVIX_AUTH_TOKEN',
  'SSH_PRIVATE_KEY_B64',
  'SSH_HOST_KEY_B64',
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

function runAws(args, options = {}) {
  return execFileSync('aws', args, {
    encoding: 'utf8',
    env: { ...process.env, AWS_REGION: REGION },
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  })
}

function fetchFromSsm(name) {
  try {
    const out = runAws(
      ['ssm', 'get-parameter', '--region', REGION, '--name', name, '--with-decryption', '--query', 'Parameter.Value', '--output', 'text'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim()
    return out && out !== 'None' ? out : null
  } catch (err) {
    if (err.code === 'ENOENT') console.warn('sst-with-cloudflare: `aws` CLI not found; skipping SSM lookup')
    return null // ParameterNotFound / auth error → warn below and let sst decide
  }
}

function dotenvLine(key, value) {
  return `${key}=${JSON.stringify(value)}`
}

function writeAtomically(file, body) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, body, { mode: 0o600 })
  renameSync(tmp, file)
  chmodSync(file, 0o600)
}

function envPrefixForStage() {
  const explicit = process.env.BOXLITE_ENV_SSM_PREFIX || process.env.OPS_PRODUCT_ENV_SSM_PREFIX
  const template =
    process.env.BOXLITE_ENV_SSM_PREFIX_TEMPLATE ||
    process.env.OPS_PRODUCT_ENV_SSM_PREFIX_TEMPLATE ||
    DEFAULT_PRODUCT_ENV_PREFIX_TEMPLATE
  const source = explicit || template
  return source.replaceAll('{stage}', stage)
}

function sstSecretKeys() {
  return new Set(
    (process.env.BOXLITE_SST_SECRET_KEYS || process.env.OPS_PRODUCT_SST_SECRET_KEYS || DEFAULT_SST_SECRET_KEYS.join(','))
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean),
  )
}

function syncProductEnvFromSsm() {
  const source = process.env.BOXLITE_ENV_SOURCE || process.env.SST_ENV_SOURCE || 'local'
  if (source !== 'ssm' || !CONFIG_COMMANDS.has(sstArgs[0])) return

  const prefix = envPrefixForStage()
  const outFile = process.env.BOXLITE_ENV_FILE || process.env.OPS_PRODUCT_ENV_FILE || join(process.cwd(), '.env')
  let params
  try {
    const stdout = runAws([
      'ssm',
      'get-parameters-by-path',
      '--region',
      REGION,
      '--path',
      prefix,
      '--recursive',
      '--with-decryption',
      '--query',
      'Parameters[].{Name:Name,Value:Value,Version:Version}',
      '--output',
      'json',
    ])
    params = JSON.parse(stdout || '[]')
  } catch (err) {
    const detail = err.stderr ? String(err.stderr).trim() : err.message
    console.error(`sst-env-sync: failed to read ${prefix} from SSM (${REGION}): ${detail}`)
    process.exit(1)
  }

  const records = params
    .map((param) => ({
      key: String(param.Name || '').split('/').filter(Boolean).pop(),
      value: String(param.Value ?? ''),
      version: Number(param.Version || 0),
    }))
    .filter((param) => param.key)
    .sort((a, b) => a.key.localeCompare(b.key))

  if (records.length === 0) {
    console.error(`sst-env-sync: no parameters found under ${prefix} in ${REGION}; seed SSM before running SST with BOXLITE_ENV_SOURCE=ssm`)
    process.exit(1)
  }

  writeAtomically(outFile, `${records.map((param) => dotenvLine(param.key, param.value)).join('\n')}\n`)

  const secretKeys = sstSecretKeys()
  const secretLines = records
    .filter((param) => secretKeys.has(param.key) && param.value)
    .map((param) => dotenvLine(param.key, param.value))

  if (secretLines.length) {
    const tempDir = mkdtempSync(join(tmpdir(), 'boxlite-sst-secrets-'))
    const secretFile = join(tempDir, '.sst-secrets.env')
    try {
      writeFileSync(secretFile, `${secretLines.join('\n')}\n`, { mode: 0o600 })
      console.log(`sst-env-sync: wrote ${outFile} (${records.length} key(s) from ${prefix}); loading ${secretLines.length} SST secret(s)`)
      execFileSync('sst', ['secret', 'load', secretFile, '--stage', stage], { stdio: 'inherit', env: process.env })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  } else {
    console.log(`sst-env-sync: wrote ${outFile} (${records.length} key(s) from ${prefix}); no SST secrets matched`)
  }

  console.log(
    `::ops-audit::${JSON.stringify({
      phase: 'env-sync',
      stage,
      region: REGION,
      prefix,
      keyVersions: records.map((param) => ({ key: param.key, version: param.version })),
      sstSecretKeys: records.filter((param) => secretKeys.has(param.key) && param.value).map((param) => param.key),
    })}`,
  )
}

const stage = resolveStage(sstArgs)
const REGION = process.env.BOXLITE_AWS_REGION || process.env.AWS_REGION || STAGE_REGIONS[stage] || DEFAULT_REGION

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

syncProductEnvFromSsm()

// node_modules/.bin is on PATH because this runs via `npm run`, so `sst` resolves.
const result = spawnSync('sst', sstArgs, { stdio: 'inherit', env: process.env })
if (result.error) {
  console.error(`sst-with-cloudflare: failed to launch sst: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
