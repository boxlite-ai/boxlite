// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Seed a new stage's deploy-time env config from an existing stage's, into AWS SSM.
 *
 * Bootstrapping a fresh stage (e.g. prod) needs the same /boxlite/<stage>/env/*
 * parameters dev already has. Most carry over verbatim or with a domain swap; a handful
 * are stage-identity (Auth0 tenant, SSH keys, the runner's private IP) that this script
 * CANNOT know — it leaves those blank on purpose and prints the exact put-parameter
 * command to fill each, so nothing wrong is silently written.
 *
 * Three buckets (see CLASSIFY below):
 *   copy   : value carries over unchanged (e.g. POSTHOG_API_KEY, INTERNAL_ADMIN_EMAILS)
 *   domain : value is the source value with <dev-domain> rewritten to <prod-domain> (STACK_DOMAIN only)
 *   blank  : stage-identity / Auth0-coupled, unknowable here → SKIPPED, listed with a ready-to-paste
 *            command (OIDC_AUDIENCE + OIDC_* tenant creds, PUBLIC_OIDC_DOMAIN, SSH_*_B64, RUNNER_PRIVATE_IP).
 *            OIDC_AUDIENCE looks domain-shaped (dev = https://dev.boxlite.ai/api) but is whatever the prod
 *            Auth0 API is named — a wrong guess silently breaks JWT validation, so it must be set by hand.
 * Any source key not classified defaults to `blank` (safe — never auto-copy the unknown).
 *
 * Secrets stay between this machine and AWS: copied values are passed to the AWS CLI as
 * argv (no shell interpolation) and are NEVER printed — only KEY names and the two
 * non-secret derived domains are logged.
 *
 * Usage (dry-run by default — prints the plan, writes nothing):
 *   AWS_PROFILE=boxlite-sso node scripts/seed-prod-from-dev.mjs
 *   AWS_PROFILE=boxlite-sso node scripts/seed-prod-from-dev.mjs --apply        # actually write
 *   node scripts/seed-prod-from-dev.mjs --source-stage dev --target-stage prod
 *   node scripts/seed-prod-from-dev.mjs --dev-domain dev.boxlite.ai --prod-domain app.boxlite.ai
 *   BOXLITE_CONFIG_REGION=us-west-2 node scripts/seed-prod-from-dev.mjs         # override config region
 */

import { execFileSync } from 'node:child_process'

// SSM config region is FIXED (not the deploy region): all stages' config lives in ap-southeast-1
// regardless of where the stage deploys, matching sst-with-cloudflare.mjs. Override BOXLITE_CONFIG_REGION.
const REGION = process.env.BOXLITE_CONFIG_REGION || 'ap-southeast-1'

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const APPLY = process.argv.includes('--apply')
const SOURCE_STAGE = arg('--source-stage', 'dev')
const TARGET_STAGE = arg('--target-stage', 'prod')
const DEV_DOMAIN = arg('--dev-domain', 'dev.boxlite.ai')
const PROD_DOMAIN = arg('--prod-domain', 'app.boxlite.ai')

// How each env key crosses from the source stage to the target stage.
const CLASSIFY = {
  // domain — rewrite <dev-domain> to <prod-domain> in the source value
  STACK_DOMAIN: 'domain',
  // copy — same value in both stages
  INTERNAL_ADMIN_EMAILS: 'copy',
  POSTHOG_API_KEY: 'copy',
  POSTHOG_HOST: 'copy',
  SVIX_AUTH_TOKEN: 'copy',
  DEV_CLICKHOUSE_ENABLED: 'copy',
  DEV_CLICKHOUSE_EBS_GB: 'copy',
  OIDC_MANAGEMENT_API_ENABLED: 'copy',
  // blank — stage-identity / Auth0-coupled / unknowable here; SKIP and list for manual seeding
  OIDC_AUDIENCE: 'blank', // = the prod Auth0 API's audience id; must equal what you create in Auth0, not a domain guess
  OIDC_ISSUER_BASE_URL: 'blank',
  OIDC_CLIENT_ID: 'blank',
  OIDC_MANAGEMENT_API_AUDIENCE: 'blank',
  OIDC_MANAGEMENT_API_CLIENT_ID: 'blank',
  OIDC_MANAGEMENT_API_CLIENT_SECRET: 'blank',
  PUBLIC_OIDC_DOMAIN: 'blank',
  SSH_HOST_KEY_B64: 'blank',
  SSH_PRIVATE_KEY_B64: 'blank',
  RUNNER_PRIVATE_IP: 'blank', // filled after the first deploy from the runner's private IP
}

function readSourceEnv(stage) {
  const path = `/boxlite/${stage}/env/`
  let json
  try {
    json = execFileSync(
      'aws',
      ['ssm', 'get-parameters-by-path', '--region', REGION, '--path', path, '--recursive',
        '--with-decryption', '--query', 'Parameters[].{Name:Name,Value:Value}', '--output', 'json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString().split('\n')[0] : err.message
    console.error(`seed-prod-from-dev: cannot read ${path}* in ${REGION}: ${msg}`)
    process.exit(1)
  }
  const params = JSON.parse(json)
  const out = new Map()
  for (const p of params || []) out.set(p.Name.slice(path.length), p.Value)
  return out
}

function putParam(key, value) {
  const name = `/boxlite/${TARGET_STAGE}/env/${key}`
  execFileSync(
    'aws',
    ['ssm', 'put-parameter', '--region', REGION, '--name', name, '--type', 'SecureString', '--overwrite', '--value', value],
    { stdio: ['ignore', 'ignore', 'pipe'] }, // never echo the value or the version output
  )
}

const source = readSourceEnv(SOURCE_STAGE)
console.log(
  `seed-prod-from-dev: ${SOURCE_STAGE} -> ${TARGET_STAGE} | region=${REGION} | ` +
    `${DEV_DOMAIN} -> ${PROD_DOMAIN} | ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (nothing written)'}`,
)
console.log(`  source has ${source.size} key(s) under /boxlite/${SOURCE_STAGE}/env/\n`)

const written = []
const blanks = []
let failures = 0

for (const [key, srcVal] of source) {
  const kind = CLASSIFY[key] || 'blank' // unknown keys are not auto-copied
  if (kind === 'blank') {
    blanks.push(key)
    continue
  }
  let value = srcVal
  let note = 'copied'
  if (kind === 'domain') {
    value = srcVal.split(DEV_DOMAIN).join(PROD_DOMAIN)
    note = `${srcVal} -> ${value}` // non-secret domains: safe to show the rewrite
    if (!srcVal.includes(DEV_DOMAIN)) {
      note = `WARNING source value has no '${DEV_DOMAIN}' to rewrite; writing as-is (${value})`
    }
  }
  if (APPLY) {
    try {
      putParam(key, value)
    } catch (err) {
      const msg = err.stderr ? err.stderr.toString().split('\n')[0] : err.message
      console.error(`  ✗ ${key}: ${msg}`)
      failures++
      continue
    }
  }
  written.push(key)
  console.log(`  ${APPLY ? '✓' : '·'} ${key.padEnd(34)} ${kind === 'domain' ? note : 'copied'}`)
}

console.log(`\n  ${APPLY ? 'wrote' : 'would write'} ${written.length} key(s); ${blanks.length} left BLANK (need a human):`)
for (const key of blanks) {
  console.log(
    `    /boxlite/${TARGET_STAGE}/env/${key}\n` +
      `      aws ssm put-parameter --region ${REGION} --type SecureString --overwrite \\\n` +
      `        --name /boxlite/${TARGET_STAGE}/env/${key} --value '<...>'`,
  )
}

console.log(
  `\n  Cloudflare creds are NOT handled here. Seed the target stage's (a fresh prod-scoped\n` +
    `  token is recommended) before the first deploy:\n` +
    `    aws ssm put-parameter --region ${REGION} --type SecureString --overwrite \\\n` +
    `      --name /boxlite/${TARGET_STAGE}/cloudflare-api-token  --value '<token>'\n` +
    `    aws ssm put-parameter --region ${REGION} --type SecureString --overwrite \\\n` +
    `      --name /boxlite/${TARGET_STAGE}/cloudflare-account-id --value '<account-id>'`,
)

if (failures) {
  console.error(`\nseed-prod-from-dev: ${failures} write(s) failed`)
  process.exit(1)
}
console.log(`\nseed-prod-from-dev: ${APPLY ? 'done' : 'dry-run complete — re-run with --apply to write'}`)
