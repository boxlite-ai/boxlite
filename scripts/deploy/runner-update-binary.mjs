#!/usr/bin/env node
// Upgrade the boxlite-runner binary on the live Runner EC2 in-place.
//
// JS twin of runner-update-binary.sh — same CLI contract, same env inputs,
// same SSM flow. The bash script remains the authority; behavioural parity is
// enforced by scripts/deploy/tests/parity/run.sh.
//
// The remote upgrade payload (the script SSM runs on the runner) is NOT
// duplicated here: it is parsed out of the sibling runner-update-binary.sh
// heredoc at runtime and expanded with the same bash here-document semantics.
// One payload, two orchestrators — the halves cannot drift.
//
// Usage:
//   scripts/deploy/runner-update-binary.mjs                  # version from Cargo.toml
//   scripts/deploy/runner-update-binary.mjs 0.9.7            # official GitHub release
//   scripts/deploy/runner-update-binary.mjs 0.9.7-dev-123-58d8f01bcd02
//   scripts/deploy/runner-update-binary.mjs --output-dir /tmp/dist 0.9.7-dev-123-58d8f01bcd02
//   scripts/deploy/runner-update-binary.mjs --tarball dist/boxlite-runner-v...-linux-amd64.tar.gz
//   AWS_REGION=us-west-2 scripts/deploy/runner-update-binary.mjs
//   STAGE=production scripts/deploy/runner-update-binary.mjs
//   RUNNER_INSTANCE_ID=i-0123456789abcdef0 scripts/deploy/runner-update-binary.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..')

function die(msg) {
  process.stderr.write(`error: ${msg}\n`)
  process.exit(1)
}

function env(name, fallback = '') {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

function aws(args) {
  return execFileSync('aws', args, { encoding: 'utf8' }).trim()
}

function awsRun(args) {
  execFileSync('aws', args, { stdio: ['ignore', 'inherit', 'inherit'] })
}

function commandOnPath(cmd) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    try {
      fs.accessSync(path.join(dir, cmd), fs.constants.X_OK)
      return true
    } catch {
      /* keep looking */
    }
  }
  return false
}

// ── bash here-document semantics ─────────────────────────────────────────────
// Replicates what `read -r -d '' SCRIPT <<EOF` does to the payload in the .sh:
// \<newline> joins lines, \$ \` \\ unescape, unescaped ${NAME} expands, and
// read's IFS handling trims leading/trailing whitespace.
function expandHeredoc(text, vars) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') {
      const n = text[i + 1]
      if (n === '\n') {
        i++ // line continuation: both chars vanish
      } else if (n === '$' || n === '`' || n === '\\') {
        out += n
        i++
      } else {
        out += c
      }
      continue
    }
    if (c === '$' && text[i + 1] === '{') {
      const close = text.indexOf('}', i + 2)
      const name = close > 0 ? text.slice(i + 2, close) : ''
      if (!/^\w+$/.test(name)) die(`heredoc expansion of unsupported form: \${${name}}`)
      if (!(name in vars)) die(`heredoc references unknown variable: ${name}`)
      out += vars[name]
      i = close
      continue
    }
    if (c === '$' && /\w/.test(text[i + 1] || '')) {
      die(`heredoc uses unbraced expansion at offset ${i}; port it explicitly`)
    }
    out += c
  }
  return out.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '')
}

function remotePayloadTemplate() {
  const authority = path.join(SCRIPT_DIR, 'runner-update-binary.sh')
  let src
  try {
    src = fs.readFileSync(authority, 'utf8')
  } catch {
    die(`bash authority not found next to this script: ${authority}\n       the JS twin sources its remote payload from the .sh — ship both files together`)
  }
  const lines = src.split('\n')
  const start = lines.findIndex((l) => l.includes("read -r -d '' SCRIPT <<EOF"))
  const end = lines.findIndex((l, i) => i > start && l === 'EOF')
  if (start < 0 || end < 0) die(`could not locate the SSM payload heredoc in ${authority}`)
  return lines.slice(start + 1, end).join('\n') + '\n'
}

// ── env defaults (mirror the .sh header block) ───────────────────────────────
let STAGE = env('STAGE', 'dev')
const DEV_AWS_REGION = env('DEV_AWS_REGION', 'ap-southeast-1')
const DEV_RUNNER_INSTANCE_NAME = env('DEV_RUNNER_INSTANCE_NAME', 'boxlite-dev-runner-default')
const DEV_RUNNER_INSTANCE_ID = env('DEV_RUNNER_INSTANCE_ID')
const PROD_AWS_REGION = env('PROD_AWS_REGION', 'us-west-2')
const PROD_RUNNER_INSTANCE_NAME = env('PROD_RUNNER_INSTANCE_NAME', 'boxlite-prod-runner-default')
const PROD_RUNNER_INSTANCE_ID = env('PROD_RUNNER_INSTANCE_ID')
let AWS_REGION = env('AWS_REGION')
let RUNNER_INSTANCE_NAME = env('RUNNER_INSTANCE_NAME')
let RUNNER_INSTANCE_ID = env('RUNNER_INSTANCE_ID')
let ARTIFACT_DIR = env('RUNNER_ARTIFACT_DIR', path.join(REPO_ROOT, 'dist'))
let RUNNER_ARTIFACT_S3_URI = env('RUNNER_ARTIFACT_S3_URI')
const RUNNER_DOWNLOAD_CONNECT_TIMEOUT_SECONDS = env('RUNNER_DOWNLOAD_CONNECT_TIMEOUT_SECONDS', '15')
const RUNNER_DOWNLOAD_MAX_TIME_SECONDS = env('RUNNER_DOWNLOAD_MAX_TIME_SECONDS', '600')
const RUNNER_CHECKSUM_DOWNLOAD_MAX_TIME_SECONDS = env('RUNNER_CHECKSUM_DOWNLOAD_MAX_TIME_SECONDS', '120')
const SSM_WAIT_TIMEOUT_SECONDS = Number(env('SSM_WAIT_TIMEOUT_SECONDS', '1800'))
const SSM_WAIT_POLL_SECONDS = env('SSM_WAIT_POLL_SECONDS', '10')
let VERSION = ''
let LOCAL_TARBALL_OVERRIDE = ''

const USAGE = `Upgrade the boxlite-runner binary on the live Runner EC2 in-place.
See runner-update-binary.sh --help for the full option list (same contract).
`

// ── argv (mirror the .sh option loop) ────────────────────────────────────────
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  switch (arg) {
    case '--output-dir':
    case '--artifact-dir':
      if (i + 1 >= argv.length) die(`${arg} requires a value`)
      ARTIFACT_DIR = argv[++i]
      break
    case '--version':
      if (i + 1 >= argv.length) die('--version requires a value')
      VERSION = argv[++i]
      break
    case '--tarball':
      if (i + 1 >= argv.length) die('--tarball requires a value')
      LOCAL_TARBALL_OVERRIDE = argv[++i]
      break
    case '-h':
    case '--help':
      process.stdout.write(USAGE)
      process.exit(0)
      break
    default:
      if (arg.startsWith('-')) {
        process.stderr.write(`error: unknown option ${arg}\n${USAGE}`)
        process.exit(1)
      }
      if (VERSION) {
        process.stderr.write(`error: unexpected extra argument ${arg}\n${USAGE}`)
        process.exit(1)
      }
      VERSION = arg
  }
}

if (!commandOnPath('aws')) die('required command not found: aws')

if (STAGE === 'prod') STAGE = 'production'
if (STAGE !== 'dev' && STAGE !== 'production') die(`STAGE must be dev or production (got: ${STAGE})`)

if (STAGE === 'dev') {
  AWS_REGION = AWS_REGION || DEV_AWS_REGION
  RUNNER_INSTANCE_ID = RUNNER_INSTANCE_ID || DEV_RUNNER_INSTANCE_ID
  RUNNER_INSTANCE_NAME = RUNNER_INSTANCE_NAME || DEV_RUNNER_INSTANCE_NAME
} else {
  AWS_REGION = AWS_REGION || PROD_AWS_REGION
  RUNNER_INSTANCE_ID = RUNNER_INSTANCE_ID || PROD_RUNNER_INSTANCE_ID
  RUNNER_INSTANCE_NAME = RUNNER_INSTANCE_NAME || PROD_RUNNER_INSTANCE_NAME
}

if (!VERSION) {
  if (LOCAL_TARBALL_OVERRIDE) {
    const base = path.basename(LOCAL_TARBALL_OVERRIDE)
    const m = base.match(/^boxlite-runner-v(.+)-linux-amd64\.tar\.gz$/)
    if (!m) die(`could not infer version from tarball name: ${base}`)
    VERSION = m[1]
  } else {
    const cargo = fs.readFileSync(path.join(REPO_ROOT, 'Cargo.toml'), 'utf8')
    const m = cargo.match(/^version *= *"([^"]+)"/m)
    VERSION = m ? m[1] : ''
  }
  if (!VERSION) die(`could not read version from Cargo.toml at ${path.join(REPO_ROOT, 'Cargo.toml')}`)
}

const ASSET_TARBALL = `boxlite-runner-v${VERSION}-linux-amd64.tar.gz`
const LOCAL_TARBALL = LOCAL_TARBALL_OVERRIDE || path.join(ARTIFACT_DIR, ASSET_TARBALL)
const LOCAL_SHA = `${LOCAL_TARBALL}.sha256`
const devIdx = VERSION.indexOf('-dev-')
const RUNTIME_CACHE_VERSION = devIdx >= 0 ? VERSION.slice(0, devIdx) : VERSION
const IS_DEV_VERSION = VERSION.includes('-dev-')

if (IS_DEV_VERSION) {
  if (!fs.existsSync(LOCAL_TARBALL)) {
    process.stderr.write(`error: local dev runner tarball not found: ${LOCAL_TARBALL}\n`)
    process.stderr.write('       run scripts/deploy/build-runner-binary.sh first, or set --output-dir/RUNNER_ARTIFACT_DIR\n')
    process.exit(1)
  }
  if (!fs.existsSync(LOCAL_SHA)) {
    process.stderr.write(`error: local dev runner checksum not found: ${LOCAL_SHA}\n`)
    process.stderr.write('       run scripts/deploy/build-runner-binary.sh first\n')
    process.exit(1)
  }
}

if (IS_DEV_VERSION) {
  console.log(`==> Upgrading boxlite-runner from local dev artifact v${VERSION} on stage=${STAGE} region=${AWS_REGION}`)
} else {
  console.log(`==> Upgrading boxlite-runner from GitHub release v${VERSION} on stage=${STAGE} region=${AWS_REGION}`)
}

let INSTANCE_ID = RUNNER_INSTANCE_ID
if (!INSTANCE_ID) {
  const out = aws([
    'ec2', 'describe-instances',
    '--region', AWS_REGION,
    '--filters',
    `Name=tag:Name,Values=${RUNNER_INSTANCE_NAME}`,
    'Name=instance-state-name,Values=running',
    '--query', 'Reservations[].Instances[].InstanceId',
    '--output', 'text',
  ])
  const ids = out.split(/\s+/).filter(Boolean)
  if (ids.length !== 1) {
    process.stderr.write(`error: expected exactly one running runner instance, found ${ids.length}\n`)
    process.stderr.write(`       region=${AWS_REGION} stage=${STAGE} name=${RUNNER_INSTANCE_NAME}\n`)
    if (ids.length > 0) process.stderr.write(`       matches: ${ids.join(' ')}\n`)
    process.stderr.write('       set RUNNER_INSTANCE_ID=i-... to target an instance explicitly\n')
    process.exit(1)
  }
  INSTANCE_ID = ids[0]
}
console.log(`    instance: ${INSTANCE_ID}`)

let DOWNLOAD_TARBALL_URL
let DOWNLOAD_SHA_URL
if (IS_DEV_VERSION) {
  if (!RUNNER_ARTIFACT_S3_URI) {
    const accountId = aws(['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'])
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
    RUNNER_ARTIFACT_S3_URI = `s3://boxlite-${STAGE}-runner-builds/tmp/runner-rollouts/${accountId}/${VERSION}/${ts}`
  }
  const remoteTarballUrl = `${RUNNER_ARTIFACT_S3_URI.replace(/\/$/, '')}/${ASSET_TARBALL}`
  const remoteShaUrl = `${remoteTarballUrl}.sha256`
  console.log(`==> Uploading local artifact to ${RUNNER_ARTIFACT_S3_URI}`)
  awsRun(['s3', 'cp', '--region', AWS_REGION, LOCAL_TARBALL, remoteTarballUrl])
  awsRun(['s3', 'cp', '--region', AWS_REGION, LOCAL_SHA, remoteShaUrl])
  DOWNLOAD_TARBALL_URL = aws(['s3', 'presign', '--region', AWS_REGION, remoteTarballUrl, '--expires-in', '3600'])
  DOWNLOAD_SHA_URL = aws(['s3', 'presign', '--region', AWS_REGION, remoteShaUrl, '--expires-in', '3600'])
} else {
  const releaseRepository = env('BOXLITE_RELEASE_REPOSITORY', 'boxlite-ai/boxlite')
  const releaseTag = env('BOXLITE_RELEASE_TAG', `v${VERSION}`)
  const releaseBaseUrl = `https://github.com/${releaseRepository}/releases/download/${releaseTag}`
  DOWNLOAD_TARBALL_URL = `${releaseBaseUrl}/${ASSET_TARBALL}`
  DOWNLOAD_SHA_URL = `${DOWNLOAD_TARBALL_URL}.sha256`
  console.log(`==> Target runner will download ${DOWNLOAD_TARBALL_URL}`)
}

const SCRIPT = expandHeredoc(remotePayloadTemplate(), {
  RUNTIME_CACHE_VERSION,
  VERSION,
  RUNNER_DOWNLOAD_CONNECT_TIMEOUT_SECONDS,
  RUNNER_DOWNLOAD_MAX_TIME_SECONDS,
  RUNNER_CHECKSUM_DOWNLOAD_MAX_TIME_SECONDS,
  DOWNLOAD_TARBALL_URL,
  DOWNLOAD_SHA_URL,
})

// Hand the script to SSM base64-encoded, exactly like the .sh (see its note on
// why: a single token with no shell metacharacters).
const SCRIPT_B64 = Buffer.from(SCRIPT, 'utf8').toString('base64')
const CMD_ID = aws([
  'ssm', 'send-command',
  '--region', AWS_REGION,
  '--document-name', 'AWS-RunShellScript',
  '--instance-ids', INSTANCE_ID,
  '--comment', `boxlite-runner upgrade to v${VERSION}`,
  '--parameters', `commands=["echo ${SCRIPT_B64} | base64 -d | bash"]`,
  '--query', 'Command.CommandId',
  '--output', 'text',
])

console.log(`    command:  ${CMD_ID}`)
console.log(`==> Waiting for SSM command to finish (timeout=${SSM_WAIT_TIMEOUT_SECONDS}s)...`)

function invocation(query) {
  return aws([
    'ssm', 'get-command-invocation',
    '--region', AWS_REGION,
    '--command-id', CMD_ID,
    '--instance-id', INSTANCE_ID,
    '--query', query,
    '--output', 'text',
  ])
}

let STATUS = ''
const deadline = Date.now() + SSM_WAIT_TIMEOUT_SECONDS * 1000
for (;;) {
  try {
    STATUS = invocation('Status')
  } catch {
    STATUS = ''
  }
  if (['Success', 'Failed', 'Cancelled', 'TimedOut', 'Cancelling'].includes(STATUS)) break
  if (Date.now() >= deadline) {
    process.stderr.write(`error: SSM command still ${STATUS || 'unknown'} after ${SSM_WAIT_TIMEOUT_SECONDS}s\n`)
    process.exit(1)
  }
  execFileSync('sleep', [SSM_WAIT_POLL_SECONDS])
}

STATUS = invocation('Status')

console.log()
console.log(`==> SSM status: ${STATUS}`)
console.log()
console.log(invocation('StandardOutputContent'))

if (STATUS !== 'Success') {
  console.log()
  console.log('==> stderr:')
  console.log(invocation('StandardErrorContent'))
  process.exit(1)
}
