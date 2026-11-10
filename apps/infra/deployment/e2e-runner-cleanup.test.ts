// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { type TestContext } from 'node:test'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const workflow: any = load(readFileSync(join(root, '.github/workflows/e2e-local.yml'), 'utf8'))
const steps: any[] = workflow.jobs['e2e-tests'].steps
const preflight = steps.find((step) => step.name === 'Disk-pressure cache eviction')
const finalizers = steps.slice(steps.findIndex((step) => step.name === 'Run integration tests') + 1)
  .filter((step) => step.name === 'Post-run disk-pressure cache eviction')
const gib = 1024 ** 3

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-disk-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const workspace = join(dir, 'old checkout')
  const home = join(dir, 'runner home')
  const temp = join(dir, 'temp files')
  const bin = join(dir, 'bin')
  for (const path of [workspace, home, temp, bin]) mkdirSync(path)
  function file(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'keep or reclaim')
    return path
  }
  const cache = file(join(workspace, 'target/boxlite-test/cache'))
  const debug = file(join(workspace, 'target/debug/build'))
  const release = file(join(workspace, 'target/release/build'))
  const preserved = ['src/lib.rs', 'target/native/library', 'target/nextest/results.xml'].map((path) => file(join(workspace, path)))
  preserved.push(file(join(home, '.cargo/bin/rustc')), file(join(temp, 'boxlite-rescue/log')))
  const disposable = [file(join(home, '.boxlite/image')), file(join(temp, 'boxlite-test with spaces/log'))]
  // Only df is simulated; pressure changes when the production shell removes files.
  writeFileSync(join(bin, 'df'), `#!/bin/bash
set -eu
[[ "\${DF_ERROR:-}" != yes ]] || exit 9
if [[ "\${DF_BAD:-}" == yes ]]; then printf 'header\\ninvalid 90%%\\n'; exit; fi
free=$((60 * 1024 ** 3)); used=30
if [[ -e "$BLOCKING_PATH" || "\${NEVER_RECOVER:-}" == yes ]]; then
  free=$PRESSURE_BYTES; used=$PRESSURE_PCT
fi
case "$*" in
  *--output=avail,pcent*) printf 'Avail Use%%\\n%s %s%%\\n' "$free" "$used" ;;
  *--output=avail*) printf 'Avail\\n%sG\\n' "$((free / 1024 ** 3))" ;;
  *--output=pcent*) printf 'Use%%\\n%s%%\\n' "$used" ;;
  *) exit 8 ;;
esac
`, { mode: 0o755 })
  // Confine the old workflow's absolute /tmp glob during full-revert runs.
  writeFileSync(join(bin, 'rm'), `#!/bin/bash
set -eu
[[ "\${RM_ERROR:-}" != yes ]] || exit 13
for path in "$@"; do
  [[ "$path" == -* ]] && continue
  resolved=$(realpath -m -- "$path")
  [[ "$resolved" == "$FIXTURE_ROOT/"* ]] || exit 91
done
exec /bin/rm "$@"
`, { mode: 0o755 })
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, TMPDIR: temp,
    GITHUB_WORKSPACE: workspace, FIXTURE_ROOT: dir, BLOCKING_PATH: cache,
    PRESSURE_BYTES: String(10 * gib), PRESSURE_PCT: '90',
  }
  function run(step = preflight, extra = {}, cwd = workspace) {
    return spawnSync('bash', ['-e', '-c', step.run], {
      cwd, env: { ...env, ...step.env, ...extra }, encoding: 'utf8', timeout: 5000,
    })
  }
  return { dir, workspace, home, temp, file, cache, debug, release, disposable, preserved, run }
}

for (const phase of ['before', 'after']) {
  test(`${phase} tests: reclaim caches without helper files from the PR head`, (t) => {
    const f = fixture(t)
    const git = (args: string[]) => spawnSync('git', args, { cwd: f.workspace, encoding: 'utf8' })
    assert.equal(git(['init', '-q']).status, 0)
    assert.equal(git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'Old checkout']).status, 0)
    const head = git(['rev-parse', 'HEAD']).stdout
    for (const step of phase === 'before' ? [preflight] : finalizers) {
      const result = f.run(step)
      assert.equal(result.status, 0, result.stderr + result.stdout)
    }
    assert.equal(existsSync(f.cache), false, 'job cache must be reclaimed')
    for (const path of f.disposable) assert.equal(existsSync(path), false, path)
    for (const path of [...f.preserved, f.debug, f.release]) assert.ok(existsSync(path), path)
    assert.equal(git(['rev-parse', 'HEAD']).stdout, head)
  })
}

for (const profile of ['debug', 'release', 'x86_64-unknown-linux-gnu/debug', 'aarch64-unknown-linux-musl/release']) {
  test(`escalates to Cargo ${profile} only while pressure remains`, (t) => {
    const f = fixture(t)
    const artifact = f.file(join(f.workspace, 'target', profile, 'object'))
    const result = f.run(preflight, { BLOCKING_PATH: artifact })
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.equal(existsSync(artifact), false)
    for (const path of f.preserved) assert.ok(existsSync(path), path)
    if (profile === 'debug') assert.ok(existsSync(f.release), 'stop after enough space is reclaimed')
  })
}

for (const [used, free, evict] of [[70, 60 * gib, true], [69, 50 * gib - 1, true], [69, 19 * gib, true], [69, 50 * gib, false]] as const) {
  test(`disk boundaries: ${used}% used and ${free} bytes free`, (t) => {
    const f = fixture(t)
    const result = f.run(preflight, { PRESSURE_PCT: String(used), PRESSURE_BYTES: String(free) })
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.equal(existsSync(f.cache), !evict)
    assert.ok(existsSync(f.debug))
  })
}

for (const extra of [{ DF_ERROR: 'yes' }, { DF_BAD: 'yes' }, { RM_ERROR: 'yes' }, { NEVER_RECOVER: 'yes' }]) {
  test(`cleanup reports failure: ${Object.keys(extra)[0]}`, (t) => {
    const f = fixture(t)
    const result = f.run(preflight, extra)
    assert.notEqual(result.status, 0)
    for (const path of f.preserved) assert.ok(existsSync(path), path)
    if (!('NEVER_RECOVER' in extra)) assert.ok(existsSync(f.cache), 'failed checks must not delete caches')
  })
}

for (const redirect of ['target', 'target/boxlite-test']) {
  test(`refuses symlink redirection at ${redirect}`, (t) => {
    const f = fixture(t)
    const outside = join(f.dir, 'unrelated')
    const sentinel = f.file(join(outside, redirect === 'target' ? 'boxlite-test/cache' : 'cache'))
    const link = join(f.workspace, redirect)
    rmSync(link, { recursive: true })
    symlinkSync(outside, link)
    const result = f.run(preflight, { BLOCKING_PATH: sentinel })
    assert.notEqual(result.status, 0)
    assert.ok(existsSync(sentinel))
  })
}

test('resolves cleanup paths from the workspace instead of the shell directory', (t) => {
  const f = fixture(t)
  const result = f.run(preflight, {}, f.dir)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(existsSync(f.cache), false)
})

test('cleanup surrounds builds, follows diagnostics, and respects failed debug sessions', () => {
  assert.equal(finalizers.length, 1)
  const final = finalizers[0]
  assert.equal(final.run, preflight.run, 'one shared cleanup policy')
  assert.equal(final['timeout-minutes'], 5)
  assert.ok(steps.indexOf(preflight) > steps.findIndex((step) => step.id === 'checkout'))
  assert.ok(steps.indexOf(preflight) < steps.findIndex((step) => step.name.startsWith('Install build dependencies')))
  assert.ok(steps.indexOf(final) > steps.findIndex((step) => step.name === 'Debug via SSH on failure'))
  assert.ok(steps.indexOf(final) > steps.findIndex((step) => step.name === 'Upload test logs on failure or cancellation'))
  for (const outcome of ['success', 'failure', 'cancelled']) {
    for (const debug of [false, true]) {
      for (const checkout of ['success', 'failure', 'skipped']) {
        const runs = runInNewContext(final.if, {
          always: () => true, failure: () => outcome === 'failure', inputs: { debug },
          steps: { checkout: { outcome: checkout } },
        })
        assert.equal(runs, checkout === 'success' && !(outcome === 'failure' && debug))
      }
    }
  }
})
