// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Roll out a boxlite-runner binary to the live Runner EC2 via SSM.
 *
 * This is intentionally part of apps/infra: the target instance, AWS region,
 * and deploy role all belong to the SST-managed infrastructure lane. The script
 * does not replace the EC2 instance; it swaps /usr/local/bin/boxlite-runner,
 * restarts the systemd unit, and rolls back if the new binary fails to start.
 *
 * Usage:
 *   node scripts/rollout-runner-binary.mjs
 *   node scripts/rollout-runner-binary.mjs 0.9.5
 *   BOXLITE_RUNNER_TARBALL_URL=<url> STAGE=dev node scripts/rollout-runner-binary.mjs
 *   BOXLITE_RUNNER_INSTANCE_ID=i-... node scripts/rollout-runner-binary.mjs 0.9.5
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '../../..')
const AWS_REGION = process.env.AWS_REGION || 'ap-southeast-1'
const STAGE = process.env.STAGE || process.env.SST_STAGE || 'dev'
const INSTANCE_ID = process.env.BOXLITE_RUNNER_INSTANCE_ID || ''
const DEV_TARBALL_URL = process.env.BOXLITE_RUNNER_TARBALL_URL || ''
const DEV_SHA256_URL = process.env.BOXLITE_RUNNER_TARBALL_SHA256_URL || ''

function runAws(args, options = {}) {
  return execFileSync('aws', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', options.stderr || 'pipe'],
  }).trim()
}

function cargoVersion() {
  const cargoToml = readFileSync(resolve(REPO_ROOT, 'Cargo.toml'), 'utf8')
  const match = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)
  if (!match) {
    throw new Error(`could not read version from ${resolve(REPO_ROOT, 'Cargo.toml')}`)
  }
  return match[1]
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function resolveInstanceId() {
  if (INSTANCE_ID) return INSTANCE_ID
  return runAws([
    'ec2',
    'describe-instances',
    '--region',
    AWS_REGION,
    '--filters',
    'Name=tag:Name,Values=boxlite-runner-default',
    'Name=instance-state-name,Values=running',
    '--query',
    'Reservations[].Instances[].InstanceId',
    '--output',
    'text',
  ])
}

function buildRemoteScript(assetUrl, shaUrl) {
  return `set -euo pipefail
ASSET_URL=${shellQuote(assetUrl)}
SHA_URL=${shellQuote(shaUrl)}

echo "current version:"
/usr/local/bin/boxlite-runner --version || true

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
curl -fsSL "$ASSET_URL" -o "$WORK/runner.tar.gz"
if curl -fsSL "$SHA_URL" -o "$WORK/runner.sha256"; then
  EXPECTED=$(awk '{print $1}' "$WORK/runner.sha256")
  ACTUAL=$(sha256sum "$WORK/runner.tar.gz" | awk '{print $1}')
  [ "$EXPECTED" = "$ACTUAL" ] || { echo "FATAL: checksum mismatch (want $EXPECTED got $ACTUAL)" >&2; exit 1; }
  echo "checksum verified ($ACTUAL)"
else
  echo "WARNING: no .sha256 at $SHA_URL; installing without integrity verification" >&2
fi
tar -xzf "$WORK/runner.tar.gz" -C "$WORK"
test -x "$WORK/boxlite-runner" || { echo "FATAL: tarball has no boxlite-runner binary" >&2; exit 1; }

HAD_PREVIOUS=false
if [ -x /usr/local/bin/boxlite-runner ]; then
  cp -a /usr/local/bin/boxlite-runner /usr/local/bin/boxlite-runner.bak
  HAD_PREVIOUS=true
fi
systemctl stop boxlite-runner || true
if install -m 0755 "$WORK/boxlite-runner" /usr/local/bin/boxlite-runner && systemctl start boxlite-runner && sleep 2 && systemctl is-active --quiet boxlite-runner; then
  [ "$HAD_PREVIOUS" = true ] && rm -f /usr/local/bin/boxlite-runner.bak
  echo "systemd unit: active"
  echo "new version:"
  /usr/local/bin/boxlite-runner --version || true
else
  echo "upgrade failed; rolling back" >&2
  if [ "$HAD_PREVIOUS" = true ]; then
    mv -f /usr/local/bin/boxlite-runner.bak /usr/local/bin/boxlite-runner
    systemctl restart boxlite-runner || true
  fi
  journalctl -u boxlite-runner --no-pager -n 50 || true
  exit 1
fi
`
}

const explicitVersion = process.argv[2] || ''
const version = explicitVersion || cargoVersion()

console.log(`==> Rolling out boxlite-runner on stage=${STAGE} region=${AWS_REGION}`)

const targetInstanceId = resolveInstanceId()
if (!targetInstanceId || targetInstanceId === 'None') {
  console.error(`error: no running boxlite-runner-default instance found in region ${AWS_REGION}`)
  process.exit(1)
}
console.log(`    instance: ${targetInstanceId}`)

let assetUrl
if (DEV_TARBALL_URL) {
  if (STAGE === 'prod' || STAGE === 'production') {
    console.error(`error: BOXLITE_RUNNER_TARBALL_URL is not allowed on stage=${STAGE} (prod installs released versions only)`)
    process.exit(1)
  }
  assetUrl = DEV_TARBALL_URL
  console.log('    source: dev tarball URL')
} else {
  assetUrl = `https://github.com/boxlite-ai/boxlite/releases/download/v${version}/boxlite-runner-v${version}-linux-amd64.tar.gz`
  console.log(`    source: release v${version}`)
}
const shaUrl = DEV_SHA256_URL || `${assetUrl}.sha256`

const scriptB64 = Buffer.from(buildRemoteScript(assetUrl, shaUrl), 'utf8').toString('base64')
const commandId = runAws([
  'ssm',
  'send-command',
  '--region',
  AWS_REGION,
  '--document-name',
  'AWS-RunShellScript',
  '--instance-ids',
  targetInstanceId,
  '--comment',
  `boxlite-runner rollout ${version}`,
  '--parameters',
  `commands=["echo ${scriptB64} | base64 -d | bash"]`,
  '--query',
  'Command.CommandId',
  '--output',
  'text',
])

console.log(`    command:  ${commandId}`)
console.log('==> Waiting for SSM command to finish...')

execFileSync(
  'aws',
  ['ssm', 'wait', 'command-executed', '--region', AWS_REGION, '--command-id', commandId, '--instance-id', targetInstanceId],
  { stdio: 'inherit' },
)

const status = runAws([
  'ssm',
  'get-command-invocation',
  '--region',
  AWS_REGION,
  '--command-id',
  commandId,
  '--instance-id',
  targetInstanceId,
  '--query',
  'Status',
  '--output',
  'text',
])

console.log(`\n==> SSM status: ${status}\n`)
const stdout = runAws([
  'ssm',
  'get-command-invocation',
  '--region',
  AWS_REGION,
  '--command-id',
  commandId,
  '--instance-id',
  targetInstanceId,
  '--query',
  'StandardOutputContent',
  '--output',
  'text',
])
if (stdout && stdout !== 'None') console.log(stdout)

if (status !== 'Success') {
  console.log('\n==> stderr:')
  const stderr = runAws([
    'ssm',
    'get-command-invocation',
    '--region',
    AWS_REGION,
    '--command-id',
    commandId,
    '--instance-id',
    targetInstanceId,
    '--query',
    'StandardErrorContent',
    '--output',
    'text',
  ])
  if (stderr && stderr !== 'None') console.error(stderr)
  process.exit(1)
}
