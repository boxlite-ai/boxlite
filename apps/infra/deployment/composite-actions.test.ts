// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * The composite actions under .github/actions/ carry logic that no other suite reaches:
 * run-in-manylinux assembles the container build script by hand, and sccache decides whether
 * RUSTC_WRAPPER may be exported at all. Both are shell, both are newline- and PATH-sensitive,
 * and neither shows up in a type check. release-safety.test.ts sweeps .github/workflows only,
 * so without this file an edit to an action is unguarded.
 *
 * These tests run the actions' own shell rather than a copy of it. A rewrite that changes the
 * emitted script or the export conditions fails here instead of on a runner.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { load as loadYaml } from 'js-yaml'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const ACTIONS_DIR = join(REPO_ROOT, '.github/actions')
const WORKFLOWS_DIR = join(REPO_ROOT, '.github/workflows')
const LOCAL_ACTION = './.github/actions/'

const readAction = (name: string): any =>
  loadYaml(readFileSync(join(ACTIONS_DIR, name, 'action.yml'), 'utf8'))

/** Run a bash fragment in a throwaway directory and hand back its result plus that directory. */
const runShell = (script: string, env: Record<string, string>, cwd: string) =>
  spawnSync('/usr/bin/env', ['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    cwd,
    env,
    encoding: 'utf8',
  })

test('every workflow reference to a composite action resolves and passes declared inputs', () => {
  // A `uses: ./...` that names a missing directory, or a `with:` key the action never declares,
  // fails only when the job runs — which for the release-only workflows means at release time.
  let checked = 0
  for (const file of readdirSync(WORKFLOWS_DIR).filter((name) => /\.ya?ml$/.test(name))) {
    const workflow: any = loadYaml(readFileSync(join(WORKFLOWS_DIR, file), 'utf8'))
    for (const [jobName, job] of Object.entries<any>(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        const uses = String(step.uses ?? '')
        if (!uses.startsWith(LOCAL_ACTION)) continue
        const name = uses.slice(LOCAL_ACTION.length)
        const manifest = join(ACTIONS_DIR, name, 'action.yml')
        assert.ok(existsSync(manifest), `${file} job '${jobName}' uses ${uses}, which has no action.yml`)

        const action: any = loadYaml(readFileSync(manifest, 'utf8'))
        const declared = new Set(Object.keys(action.inputs ?? {}))
        for (const key of Object.keys(step.with ?? {})) {
          assert.ok(declared.has(key), `${file} job '${jobName}' passes '${key}' to ${name}, which does not declare it`)
        }
        for (const [key, spec] of Object.entries<any>(action.inputs ?? {})) {
          if (spec?.required !== true || spec?.default !== undefined) continue
          assert.notEqual(
            (step.with ?? {})[key],
            undefined,
            `${file} job '${jobName}' omits required input '${key}' of ${name}`,
          )
        }
        checked += 1
      }
    }
  }
  // The count today. A drop means a call site went back inline, which is worth noticing rather
  // than silently tolerating; raise it when a new one is added.
  assert.ok(checked >= 45, `expected every composite-action call site swept, saw ${checked}`)
})

test('every job using a composite action checks the repository out first', () => {
  // A `uses: ./...` action is read from the workspace, so a job without a checkout cannot find it
  // — and a job that checks out *after* downloading artifacts loses them, since checkout cleans
  // the workspace. Swapping a remote action for a local one in a job that never needed a tree is
  // the easy way to introduce this, and it surfaces only when that job runs: for the release
  // upload jobs, that is at release time, with the assets silently missing.
  for (const file of readdirSync(WORKFLOWS_DIR).filter((name) => /\.ya?ml$/.test(name))) {
    const workflow: any = loadYaml(readFileSync(join(WORKFLOWS_DIR, file), 'utf8'))
    for (const [jobName, job] of Object.entries<any>(workflow.jobs ?? {})) {
      const steps: any[] = job.steps ?? []
      const firstLocal = steps.findIndex((step) => String(step.uses ?? '').startsWith(LOCAL_ACTION))
      if (firstLocal === -1) continue
      const checkout = steps.findIndex((step) => String(step.uses ?? '').includes('actions/checkout'))
      assert.notEqual(checkout, -1, `${file} job '${jobName}' uses a local action but never checks out`)
      assert.ok(
        checkout < firstLocal,
        `${file} job '${jobName}' checks out at step ${checkout}, after its first local action at ${firstLocal}`,
      )
      // And before anything that populates the workspace: checkout cleans it, so a download
      // placed first would be deleted by the very step that makes the local action resolvable.
      const firstDownload = steps.findIndex((step) => String(step.uses ?? '').includes('actions/download-artifact'))
      if (firstDownload !== -1) {
        assert.ok(
          checkout < firstDownload,
          `${file} job '${jobName}' checks out at step ${checkout}, after downloading artifacts at ${firstDownload}; checkout would clean them away`,
        )
      }
    }
  }
})

test('every composite action declares a name and description and marks its shells', () => {
  const names = readdirSync(ACTIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  assert.ok(names.length > 0, 'no composite actions found')

  for (const name of names) {
    const action = readAction(name)
    assert.ok(action.name, `${name} declares no name`)
    assert.ok(action.description, `${name} declares no description`)
    assert.equal(action.runs?.using, 'composite', `${name} is not a composite action`)
    for (const step of action.runs.steps ?? []) {
      if (step.run === undefined) continue
      // Composite `run:` steps are rejected at load time without an explicit shell.
      assert.equal(step.shell, 'bash', `${name} has a run step with shell '${step.shell}'`)
    }
    for (const [key, spec] of Object.entries<any>(action.inputs ?? {})) {
      assert.ok(spec?.description, `${name} input '${key}' has no description`)
    }
  }
})

/* ------------------------------------------------------------------ run-in-manylinux */

/** The action's own build.sh assembly, cut at the redirect so the docker run is left out. */
const manylinuxAssembly = (): string => {
  const action = readAction('run-in-manylinux')
  const run = String(action.runs.steps[0].run)
  const marker = '} > "$RUNNER_TEMP/build.sh"'
  const cut = run.indexOf(marker)
  assert.notEqual(cut, -1, 'the build.sh assembly moved; this test no longer covers it')
  return run.slice(0, cut + marker.length)
}

const generatedScript = (callerScript: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'boxlite-manylinux-'))
  try {
    const result = runShell(
      manylinuxAssembly(),
      { PATH: '/usr/bin:/bin', RUNNER_TEMP: dir, BUILD_SCRIPT: callerScript, TARGET: 'linux-x64-gnu' },
      dir,
    )
    assert.equal(result.status, 0, `assembly failed: ${result.stderr}`)
    return readFileSync(join(dir, 'build.sh'), 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the manylinux prologue reaches the container unchanged whatever the caller supplies', () => {
  // Every line of it is load-bearing — the safe.directory marking, the RUSTC_WRAPPER drop that
  // turns a cold cache into a slow build rather than a failed one, the guest restore, and the
  // toolchain PATH. A caller must not be able to displace any of it.
  const required = [
    'git config --global --add safe.directory /work',
    'unset RUSTC_WRAPPER',
    'GUEST_TARGET=$(scripts/util.sh --target)',
    'export SKIP_GUEST_BUILD=1',
    'export PATH="/usr/local/go/bin:$CARGO_HOME/bin:$PATH"',
    'make setup:build runtime',
  ]
  for (const script of ['', 'cargo build --release -p boxlite-c', 'cd sdks/node\nnpm run artifacts']) {
    const generated = generatedScript(script)
    assert.ok(generated.startsWith('set -ex\n'), 'the generated script does not start with set -ex')
    for (const line of required) {
      // Compared trimmed: some of these sit inside an `if`, and the indentation is not the point.
      assert.equal(
        generated.split('\n').filter((candidate) => candidate.trim() === line).length,
        1,
        `expected exactly one ${JSON.stringify(line)} for caller script ${JSON.stringify(script)}`,
      )
    }
    assert.ok(
      generated.trimEnd().endsWith('command -v sccache &>/dev/null && sccache --show-stats || true'),
      'the stats epilogue is not last',
    )
  }
})

test('the caller script lands once, however its block scalar was written', () => {
  // `script: |` keeps one trailing newline and `script: |-` keeps none. Both must produce the
  // same file, or the emitted script depends on a caller's YAML style rather than its content.
  const body = 'cargo build -p boxlite-cli --release'
  const withNewline = generatedScript(`${body}\n`)
  const withoutNewline = generatedScript(body)
  assert.equal(withNewline, withoutNewline, '`|` and `|-` produce different container scripts')

  // Exactly one blank line on each side, so the payload is never welded onto the prologue or
  // the epilogue and never drifts further from them as callers are edited.
  assert.ok(
    withNewline.includes(`make setup:build runtime\n\n${body}\n\ncommand -v sccache`),
    `payload not separated by a single blank line on each side:\n${withNewline}`,
  )
})

test('a caller that supplies no script still gets the prologue and the epilogue', () => {
  // warm-caches.yml relies on this: for it the prologue *is* the payload, since running
  // `make setup:build runtime` under sccache is the whole point of the job.
  const generated = generatedScript('')
  assert.ok(
    generated.includes('make setup:build runtime\n\ncommand -v sccache'),
    `empty caller script did not collapse to a single blank line:\n${generated}`,
  )
})

/* ------------------------------------------------------------------------- sccache */

type SccacheRun = {
  /** false takes the binary off PATH entirely. */
  onPath?: boolean
  /** true leaves the binary in place but makes `--start-server` exit non-zero. */
  startFails?: boolean
  tolerateFailure?: 'true' | 'false'
  expectStatus?: number
}

/** The action's env-export step, run against a stub sccache in the requested state. */
const sccacheEnvironment = ({
  onPath = true,
  startFails = false,
  tolerateFailure = 'true',
  expectStatus = 0,
}: SccacheRun = {}) => {
  const action = readAction('sccache')
  const step = action.runs.steps.find((candidate: any) => typeof candidate.run === 'string')
  assert.ok(step, 'the sccache action no longer has a run step')
  // The harness supplies TOLERATE_FAILURE below, so on its own it would keep passing if the action
  // stopped mapping the input into the environment — at which point every tolerant caller would
  // hard-fail on a cache problem. Pin the mapping itself.
  assert.equal(
    step.env?.TOLERATE_FAILURE,
    '${{ inputs.tolerate-failure }}',
    'the step must map tolerate-failure into the environment its script reads',
  )

  const dir = mkdtempSync(join(tmpdir(), 'boxlite-sccache-'))
  try {
    const binDir = join(dir, 'bin')
    mkdirSync(binDir)
    if (onPath) {
      const stub = join(binDir, 'sccache')
      // A binary that is present but cannot serve is the case that separates "export the wrapper
      // after startup" from "export it before": only here do the two orderings differ.
      writeFileSync(stub, startFails ? '#!/bin/sh\n[ "$1" = --start-server ] && exit 1\nexit 0\n' : '#!/bin/sh\nexit 0\n')
      chmodSync(stub, 0o755)
    }
    const envFile = join(dir, 'github_env')
    writeFileSync(envFile, '')

    const result = runShell(
      String(step.run),
      {
        PATH: `${binDir}:/usr/bin:/bin`,
        GITHUB_ENV: envFile,
        GITHUB_WORKSPACE: dir,
        RUNNER_TEMP: dir,
        ACTIONS_RESULTS_URL: 'https://results.example/',
        ACTIONS_RUNTIME_TOKEN: 'token-value',
        ACTIONS_CACHE_SERVICE_V2: 'on',
        TOLERATE_FAILURE: tolerateFailure,
      },
      dir,
    )
    assert.equal(result.status, expectStatus, `unexpected exit: ${result.stdout}${result.stderr}`)

    // GITHUB_ENV's heredoc form: `NAME<<DELIM`, the value's lines, then DELIM alone.
    const exported = new Map<string, string>()
    const lines = readFileSync(envFile, 'utf8').split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const opener = /^([A-Za-z_][A-Za-z0-9_]*)<<(\S+)$/.exec(lines[index])
      if (!opener) continue
      const [, name, delimiter] = opener
      const value: string[] = []
      for (index += 1; index < lines.length && lines[index] !== delimiter; index += 1) {
        value.push(lines[index])
      }
      exported.set(name, value.join('\n'))
    }
    return { exported, stdout: result.stdout, stderr: result.stderr, workspace: dir }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('sccache is switched on for the job, not merely installed', () => {
  // The upstream action installs the binary and exports the cache credentials but sets neither
  // RUSTC_WRAPPER nor SCCACHE_GHA_ENABLED, so a job that only installed it compiled uncached
  // while still looking healthy. These two are the difference.
  const { exported, workspace } = sccacheEnvironment()
  assert.equal(exported.get('RUSTC_WRAPPER'), 'sccache')
  assert.equal(exported.get('SCCACHE_GHA_ENABLED'), 'true')
  // sccache cannot cache incremental compilation, so the wrapper above is worth nothing without it.
  assert.equal(exported.get('CARGO_INCREMENTAL'), '0')
  assert.equal(exported.get('SCCACHE_BASEDIRS'), workspace)
  // Re-exported for the later host steps and for the docker invocation in run-in-manylinux,
  // which reads them from the job environment rather than from the installing step's process.
  assert.equal(exported.get('ACTIONS_RESULTS_URL'), 'https://results.example/')
  assert.equal(exported.get('ACTIONS_RUNTIME_TOKEN'), 'token-value')
  assert.equal(exported.get('ACTIONS_CACHE_SERVICE_V2'), 'on')
})

test('a missing sccache degrades the build rather than breaking it', () => {
  // tolerate-failure lets a failed install continue uncached. Exporting RUSTC_WRAPPER anyway
  // would point cargo at a binary that is not there, turning every later compile into a hard
  // failure — the exact outcome tolerating the failure exists to avoid.
  const { exported, stdout } = sccacheEnvironment({ onPath: false })
  assert.equal(exported.get('RUSTC_WRAPPER'), undefined)
  assert.match(stdout, /::warning::/, 'a job compiling uncached says so')
  // The configuration published before the failure is left alone rather than retracted. That is
  // all this pins: with no host binary nothing caches anywhere, because run-in-manylinux gates its
  // entire -e list on host PATH too, and cibuildwheel's container — the only one that installs its
  // own sccache — wraps cargo through the RUSTC_WRAPPER that is unset here.
  assert.equal(exported.get('SCCACHE_GHA_ENABLED'), 'true')
})

test('a caller that refuses to tolerate a cache failure gets one', () => {
  // warm-caches.yml passes tolerate-failure: 'false' because populating the cache is the whole
  // job. A warning it then ignores would let that workflow "succeed" having cached nothing —
  // and every workflow reading the cache afterwards would silently miss.
  const { exported, stdout } = sccacheEnvironment({ onPath: false, tolerateFailure: 'false', expectStatus: 1 })
  assert.match(stdout, /::error::/, 'an intolerant caller is told with an error, not a warning')
  assert.equal(exported.get('RUSTC_WRAPPER'), undefined)
})

test('a server that will not start is a cache failure like any other', () => {
  // The case that separates this ordering from the obvious one. A present binary passes the PATH
  // check, so exporting RUSTC_WRAPPER before startup would hand cargo a wrapper that cannot
  // answer — every later compile dies, tolerant caller or not. Exporting after startup means a
  // tolerant job compiles uncached and an intolerant one fails here, where the cause is legible.
  const tolerant = sccacheEnvironment({ startFails: true })
  assert.equal(tolerant.exported.get('RUSTC_WRAPPER'), undefined, 'a dead server must not be wrapped')
  assert.match(tolerant.stdout, /::warning::/)

  const strict = sccacheEnvironment({ startFails: true, tolerateFailure: 'false', expectStatus: 1 })
  assert.equal(strict.exported.get('RUSTC_WRAPPER'), undefined)
  assert.match(strict.stdout, /::error::/)
})

test('a tolerant job also survives a cache failure after startup', () => {
  // Startup succeeding is not the end of the risk: a read or write can fail mid-build. Without
  // this the job would die at that point, which is the same failure tolerate-failure exists to
  // absorb, just later. sccache reads it as `== "1"` (src/commands.rs).
  assert.equal(sccacheEnvironment().exported.get('SCCACHE_IGNORE_SERVER_IO_ERROR'), '1')
  assert.equal(
    sccacheEnvironment({ tolerateFailure: 'false' }).exported.get('SCCACHE_IGNORE_SERVER_IO_ERROR'),
    undefined,
  )
})

test('a change under .github reaches this suite locally, not only in CI', () => {
  // Without all three of these a workflow or action edit runs no local check at all: the
  // pre-push hook declines the change, and even if it fired, no component tag would map to a
  // test. CI catches it via lint.yml's paths filter, but only after a push.
  // Compared as literal text: these files escape for shell and for make, so both carry
  // backslashes that a regex written from the visible characters would silently miss.
  const changes = readFileSync(join(REPO_ROOT, 'make/changes.mk'), 'utf8')
  for (const prefix of ['workflows', 'actions']) {
    assert.ok(
      changes.includes(`grep -q '^\\.github/${prefix}/' && printf 'ci '`),
      `make/changes.mk maps no component to .github/${prefix}/`,
    )
  }
  // quality.mk expands fmt:<comp>/lint:<comp> per tag and there is no formatter for workflow
  // YAML, so `ci` must not survive into FMT_COMPONENTS or `make lint:fix` breaks outright.
  assert.ok(
    changes.includes('FMT_COMPONENTS := $(sort $(filter-out ci,'),
    'the ci tag is not filtered out of FMT_COMPONENTS',
  )

  const testMk = readFileSync(join(REPO_ROOT, 'make/test.mk'), 'utf8')
  assert.ok(
    testMk.includes('test\\:changed\\:ci:\n\t@$(MAKE) test:apps:infra'),
    'the ci component tag dispatches to no test target',
  )

  // Dispatching here is only worth anything if what it reaches also type-checks. `tsx --test`
  // strips types without checking them, so the suite alone stays green on a signature that no
  // longer compiles — which is how a TS2559 in this very file reached CI as the only red.
  // Order, not exact text: the echo lines around these two commands are cosmetic, and pinning
  // them verbatim would turn a reworded message into a failure that reads like a missing gate.
  const recipe = testMk.split('test\\:apps\\:infra: _ensure-infra-deps\n')[1]?.split('\n\n')[0]
  assert.ok(recipe, 'make/test.mk declares no test:apps:infra recipe')
  const typecheckAt = recipe.indexOf('npm run --silent typecheck:tooling')
  assert.ok(typecheckAt >= 0, 'test:apps:infra never type-checks the suite it runs')
  assert.ok(
    typecheckAt < recipe.indexOf('npm test'),
    'test:apps:infra runs the suite before type-checking it',
  )

  const hooks: any = loadYaml(readFileSync(join(REPO_ROOT, '.pre-commit-config.yaml'), 'utf8'))
  const prePush = hooks.repos
    .flatMap((repo: any) => repo.hooks ?? [])
    .find((hook: any) => (hook.stages ?? []).includes('pre-push'))
  assert.ok(prePush, 'no pre-push hook to gate on')
  // pre-commit compiles these with Python's `re`; `(?x)` (verbose) has no JS equivalent, and
  // dropping it is exact here because stripping the whitespace it permits is the whole effect.
  const pattern = new RegExp(String(prePush.files).replace(/\s+/g, '').replace(/^\(\?x\)/, ''))
  for (const path of ['.github/workflows/lint.yml', '.github/actions/sccache/action.yml']) {
    assert.match(path, pattern, `the pre-push hook skips ${path}`)
  }
})

test('the host and the container strip the same prefix from cache keys', () => {
  // Absolute paths are part of an sccache key. The host workspace and the container's /work are
  // different prefixes for the same sources, so without both basedirs the two sides can never
  // share an entry.
  const { exported, workspace } = sccacheEnvironment()
  assert.equal(exported.get('SCCACHE_BASEDIRS'), workspace)

  const manylinux = readAction('run-in-manylinux')
  const run = String(manylinux.runs.steps[0].run)
  assert.match(run, /-e SCCACHE_BASEDIRS=\/work/, 'the container is not given a matching basedir')
})
