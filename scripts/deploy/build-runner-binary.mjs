#!/usr/bin/env node
// Build the Linux amd64 boxlite-runner tarball without GitHub Actions.
//
// JS twin of build-runner-binary.sh — same CLI contract, same inputs, same
// artifact layout. The bash script remains the authority; behavioural parity
// is enforced by scripts/deploy/tests/parity/run.sh. Pick the implementation
// at the orchestration layer (ops-console OPS_RUNNER_IMPL); do not let the
// two drift apart — port fixes to both or flip the default deliberately.
//
// Usage:
//   scripts/deploy/build-runner-binary.mjs
//   scripts/deploy/build-runner-binary.mjs --output-dir /tmp
//   BOXLITE_RUNNER_BUILD_NUMBER=123 scripts/deploy/build-runner-binary.mjs
//   scripts/deploy/build-runner-binary.mjs --skip-setup
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const USAGE = `Build the Linux amd64 boxlite-runner tarball without GitHub Actions.

Options:
  --output-dir DIR   Directory for the runner tarball. Default: ./dist
  --build-number ID  Ordered dev build sequence. Default: BOXLITE_RUNNER_BUILD_NUMBER,
                     GITHUB_RUN_NUMBER, or current UTC timestamp.
  --skip-setup       Skip \`make setup:build\`.
  -h, --help         Show this help.
`

function die(msg) {
  process.stderr.write(`error: ${msg}\n`)
  process.exit(1)
}

function run(cmd, args, opts = {}) {
  // stdio inherit keeps build output streaming to the job log like bash does.
  execFileSync(cmd, args, { cwd: ROOT_DIR, stdio: 'inherit', ...opts })
}

function runCapture(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT_DIR, encoding: 'utf8', ...opts }).trim()
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

// ── argv ─────────────────────────────────────────────────────────────────────
let outputDir = path.join(ROOT_DIR, 'dist')
let runSetup = true
let buildSequence = process.env.BOXLITE_RUNNER_BUILD_NUMBER || process.env.GITHUB_RUN_NUMBER || ''

const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  switch (arg) {
    case '--output-dir':
      if (i + 1 >= argv.length) die('--output-dir requires a value')
      outputDir = argv[++i]
      break
    case '--build-number':
      if (i + 1 >= argv.length) die('--build-number requires a value')
      buildSequence = argv[++i]
      break
    case '--skip-setup':
      runSetup = false
      break
    case '-h':
    case '--help':
      process.stdout.write(USAGE)
      process.exit(0)
      break
    default:
      process.stderr.write(`error: unknown argument ${arg}\n${USAGE}`)
      process.exit(1)
  }
}

process.chdir(ROOT_DIR)

// Mirror bash `command -v`: a PATH lookup, not an execution — the parity
// harness compares issued commands, and probes must not appear in that log.
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
for (const cmd of ['cargo', 'go', 'make', 'sha256sum', 'tar']) {
  if (!commandOnPath(cmd)) die(`required command not found: ${cmd}`)
}

function findEmbeddedRuntimeDir(guestSha256) {
  const buildRoot = path.join(ROOT_DIR, 'target', 'release', 'build')
  const candidates = []
  let crates = []
  try {
    crates = fs.readdirSync(buildRoot)
  } catch {
    crates = []
  }
  for (const crate of crates.sort()) {
    if (!crate.startsWith('boxlite-')) continue
    const runtimeDir = path.join(buildRoot, crate, 'out', 'runtime')
    let stat
    try {
      stat = fs.statSync(runtimeDir)
    } catch {
      continue
    }
    if (stat.isDirectory()) candidates.push(runtimeDir)
  }
  for (const runtimeDir of candidates.sort()) {
    const guest = path.join(runtimeDir, 'boxlite-guest')
    if (!fs.existsSync(guest)) continue
    if (sha256File(guest) === guestSha256) return runtimeDir
  }
  process.stderr.write(`error: embedded runtime payload not found for guest hash ${guestSha256.slice(0, 12)}\n`)
  process.exit(1)
}

// Respect PATH shims / remote environments the same way bash does: ask uname,
// not the Node runtime, so both implementations see the same world.
const unameS = runCapture('uname', ['-s'])
const unameM = runCapture('uname', ['-m'])
if (unameS !== 'Linux' || unameM !== 'x86_64') {
  die('runner tarball build currently requires a Linux x86_64 builder')
}

const cargoToml = fs.readFileSync(path.join(ROOT_DIR, 'Cargo.toml'), 'utf8')
const versionMatch = cargoToml.match(/^version *= *"([^"]+)"/m)
const VERSION = versionMatch ? versionMatch[1] : ''
if (!VERSION) die('could not read version from Cargo.toml')

if (!buildSequence) {
  buildSequence = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}
buildSequence = buildSequence.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^v/, '')
if (!buildSequence) die('build sequence cannot be empty')

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp.'))
const goWorkPath = path.join(ROOT_DIR, 'apps', 'go.work')
const goWorkSumPath = path.join(ROOT_DIR, 'apps', 'go.work.sum')
const goWorkBackup = fs.existsSync(goWorkPath) ? fs.readFileSync(goWorkPath) : null
const goWorkSumBackup = fs.existsSync(goWorkSumPath) ? fs.readFileSync(goWorkSumPath) : null

function restoreGoWork() {
  if (goWorkBackup !== null) fs.writeFileSync(goWorkPath, goWorkBackup)
  else fs.rmSync(goWorkPath, { force: true })
  if (goWorkSumBackup !== null) fs.writeFileSync(goWorkSumPath, goWorkSumBackup)
  else fs.rmSync(goWorkSumPath, { force: true })
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
}

process.on('exit', restoreGoWork)
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => process.exit(1))
}

try {
  const goMod = fs.readFileSync(path.join(ROOT_DIR, 'apps', 'runner', 'go.mod'), 'utf8')
  const goVersionMatch = goMod.match(/^go (\S+)/m)
  const GO_VERSION = goVersionMatch ? goVersionMatch[1] : ''
  if (!GO_VERSION) die('could not read Go version from apps/runner/go.mod')

  fs.writeFileSync(
    goWorkPath,
    `go ${GO_VERSION}\n\nuse (\n\t./runner\n\t./common-go\n\t./api-client-go\n\t../sdks/go\n)\n`,
  )

  const headSha = runCapture('git', ['rev-parse', '--short', 'HEAD'])
  console.log(`==> Building boxlite-runner from package v${VERSION} at ${headSha}`)
  console.log(`==> Non-release artifact version prefix: v${VERSION}-dev-${buildSequence}`)

  console.log('==> Cleaning runner build artifacts')
  run('cargo', ['clean', '-p', 'boxlite', '-p', 'boxlite-c', '-p', 'boxlite-shim', '-p', 'boxlite-guest'])
  for (const rel of [
    'sdks/go/libboxlite.a',
    'target/release/libboxlite.a',
    'target/release/libboxlite.so',
    'target/release/boxlite-shim',
    'target/x86_64-unknown-linux-gnu/release/boxlite-shim',
    'target/x86_64-unknown-linux-musl/release/boxlite-guest',
  ]) {
    fs.rmSync(path.join(ROOT_DIR, rel), { force: true })
  }
  fs.rmSync(path.join(ROOT_DIR, 'sdks', 'c', 'dist'), { recursive: true, force: true })

  if (runSetup) run('make', ['setup:build'])

  run('scripts/build/build-shim.sh', ['--profile', 'release'])
  run('scripts/build/build-guest.sh', ['--profile', 'release'])

  const GUEST_BIN = path.join(ROOT_DIR, 'target', 'x86_64-unknown-linux-musl', 'release', 'boxlite-guest')
  let guestStat
  try {
    guestStat = fs.statSync(GUEST_BIN)
  } catch {
    guestStat = null
  }
  if (!guestStat || !(guestStat.mode & 0o111)) die(`guest binary not found after build: ${GUEST_BIN}`)
  const GUEST_SHA256 = sha256File(GUEST_BIN)
  const RUNTIME_SUFFIX = GUEST_SHA256.slice(0, 12)
  const RUNTIME_CACHE_SUFFIX = `dev-${buildSequence}-${RUNTIME_SUFFIX}`
  const RUNNER_VERSION = `${VERSION}-${RUNTIME_CACHE_SUFFIX}`

  console.log(`==> Building libboxlite with runtime cache key v${RUNNER_VERSION}`)
  run('make', ['dist:c'])
  console.log('==> Fixing libboxlite Go runtime symbols')
  run('bash', [
    path.join(ROOT_DIR, 'scripts', 'build', 'fix-go-symbols.sh'),
    path.join(ROOT_DIR, 'target', 'release', 'libboxlite.a'),
  ])
  const RUNTIME_DIR = findEmbeddedRuntimeDir(GUEST_SHA256)
  run('tar', ['czf', path.join(TMP_DIR, 'boxlite-runtime.tar.gz'), '-C', RUNTIME_DIR, '.'])
  console.log(`==> Wrote embedded runtime payload from ${RUNTIME_DIR}`)
  fs.copyFileSync(path.join(ROOT_DIR, 'target', 'release', 'libboxlite.a'), path.join(ROOT_DIR, 'sdks', 'go', 'libboxlite.a'))

  run('go', ['-C', 'apps/runner', 'mod', 'download'])
  run('go', ['-C', 'apps/common-go', 'mod', 'download'])
  run('go', ['-C', 'apps/api-client-go', 'mod', 'download'])

  const RUNNER_BIN = path.join(TMP_DIR, 'boxlite-runner')
  run(
    'go',
    [
      'build',
      '-C', 'apps',
      '-ldflags', `-X github.com/boxlite-ai/runner/internal.Version=${RUNNER_VERSION}`,
      '-o', RUNNER_BIN,
      './runner/cmd/runner',
    ],
    { env: { ...process.env, CGO_ENABLED: '1', GOOS: 'linux', GOARCH: 'amd64' } },
  )
  fs.writeFileSync(path.join(TMP_DIR, 'boxlite-runner.guest.sha256'), `${GUEST_SHA256}  boxlite-guest\n`)
  console.log(`==> Wrote guest hash sidecar ${GUEST_SHA256.slice(0, 12)}`)
  fs.writeFileSync(path.join(TMP_DIR, 'boxlite-runner.runtime-suffix'), `${RUNTIME_CACHE_SUFFIX}\n`)
  console.log(`==> Runtime cache directory: v${RUNNER_VERSION}`)

  fs.mkdirSync(outputDir, { recursive: true })
  const TARBALL = path.join(outputDir, `boxlite-runner-v${RUNNER_VERSION}-linux-amd64.tar.gz`)
  run('tar', [
    'czf', TARBALL,
    '-C', TMP_DIR,
    'boxlite-runner',
    'boxlite-runner.guest.sha256',
    'boxlite-runner.runtime-suffix',
    'boxlite-runtime.tar.gz',
  ])

  fs.writeFileSync(`${TARBALL}.sha256`, `${sha256File(TARBALL)}  ${TARBALL}\n`)

  console.log(`==> Wrote ${TARBALL}`)
  console.log(`==> Wrote ${TARBALL}.sha256`)
} catch (err) {
  if (err && err.status) process.exit(err.status)
  throw err
}
