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

test('every apps/infra step runs a script apps/infra declares', () => {
  // `setup-infra` called `npm run build:mstage`, which this package had never
  // declared: every job using the action failed on `Missing script`, and nothing
  // typechecks a script name. A `run:` is the one place a name can be wrong and
  // still look right.
  const scripts = new Set(
    Object.keys(JSON.parse(readFileSync(join(REPO_ROOT, 'apps/infra/package.json'), 'utf8')).scripts ?? {}),
  )
  assert.ok(scripts.size > 0, 'apps/infra declares no scripts; this test is reading the wrong package')

  let checked = 0
  const sources = [
    ...readdirSync(WORKFLOWS_DIR)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => [name, join(WORKFLOWS_DIR, name)] as const),
    ...readdirSync(ACTIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => [entry.name, join(ACTIONS_DIR, entry.name, 'action.yml')] as const),
  ]
  for (const [name, file] of sources) {
    const document: any = loadYaml(readFileSync(file, 'utf8'))
    const containers = document.jobs ? Object.values<any>(document.jobs) : [document.runs ?? {}]
    for (const container of containers) {
      const shared = container.defaults?.run?.['working-directory'] ?? document.defaults?.run?.['working-directory']
      for (const step of container.steps ?? []) {
        if (step.run === undefined) continue
        if ((step['working-directory'] ?? shared) !== 'apps/infra') continue
        for (const [, script] of String(step.run).matchAll(/npm run (?:--silent )?([A-Za-z0-9:_-]+)/g)) {
          assert.ok(scripts.has(script), `${name} runs 'npm run ${script}', which apps/infra does not declare`)
          checked += 1
        }
      }
    }
  }
  // The count today. A drop means a call site stopped going through npm, which is
  // worth noticing rather than silently tolerating; raise it when one is added.
  assert.ok(checked >= 12, `expected every apps/infra script call swept, saw ${checked}`)
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
  // Empty payloads still need the runtime setup and cache reporting around them.
  const generated = generatedScript('')
  assert.ok(
    generated.includes('make setup:build runtime\n\ncommand -v sccache'),
    `empty caller script did not collapse to a single blank line:\n${generated}`,
  )
})

for (const cached of [true, false]) {
  test(`manylinux hands the disk cache to the container and returns ownership: cached=${cached}`, () => {
    // Exercise the real Docker command with a path containing spaces. The stubs record
    // process boundaries, including cleanup after a failed container build.
    const dir = mkdtempSync(join(tmpdir(), 'boxlite manylinux '))
    try {
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      mkdirSync(join(dir, 'sccache'), { recursive: true })
      for (const [name, body] of Object.entries({
        docker: 'printf "docker\\n" >> "$TRACE"; printf "%s\\n" "$@" > "$ARGS"; exit 17',
        sudo: 'printf "ownership\\n" >> "$TRACE"; printf "%s\\n" "$@" > "$OWNER_ARGS"',
        ...(cached ? { sccache: 'printf "sccache %s\\n" "$*" >> "$TRACE"' } : {}),
      })) {
        writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
      }
      const result = runShell(String(readAction('run-in-manylinux').runs.steps[0].run), {
        PATH: `${bin}:/usr/bin:/bin`, RUNNER_TEMP: dir, GITHUB_WORKSPACE: dir,
        BUILD_SCRIPT: '', TARGET: 'linux-arm64-gnu', TRACE: join(dir, 'trace'),
        SCCACHE_DIR: join(dir, 'sccache'),
        ARGS: join(dir, 'args'), OWNER_ARGS: join(dir, 'owner-args'),
        ACTIONS_RUNTIME_TOKEN: 'must-not-be-forwarded',
      }, dir)
      assert.equal(result.status, 17, 'cleanup must preserve the container failure')
      const args = readFileSync(join(dir, 'args'), 'utf8').trim().split('\n')
      assert.ok(args.includes(`${dir}:/work`), 'workspace mount must remain a single argument')
      assert.ok(args.includes('quay.io/pypa/manylinux_2_28_aarch64'))
      assert.equal(args.includes('SCCACHE_DIR=/cache/sccache'), cached)
      assert.equal(args.includes('SCCACHE_GHA_ENABLED=false'), cached)
      assert.equal(args.includes('RUSTC_WRAPPER=sccache'), cached)
      assert.ok(!args.some((argument) => argument.includes('ACTIONS_RUNTIME_TOKEN')))
      assert.deepEqual(readFileSync(join(dir, 'trace'), 'utf8').trim().split('\n'),
        [...(cached ? ['sccache --stop-server'] : []), 'docker', 'ownership'])
      const ownerArgs = readFileSync(join(dir, 'owner-args'), 'utf8').trim().split('\n')
      assert.equal(ownerArgs[0], 'chown')
      assert.equal(ownerArgs.at(-1), join(dir, 'sccache'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

for (const status of [0, 17]) {
  test(`the container flushes its disk cache when the build exits ${status}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'boxlite-container-'))
    try {
      mkdirSync(join(dir, 'scripts'))
      writeFileSync(join(dir, 'scripts/util.sh'), '#!/bin/sh\necho x86_64-unknown-linux-musl\n', { mode: 0o755 })
      for (const name of ['git', 'make', 'sccache']) {
        writeFileSync(join(dir, name), `#!/bin/sh\nprintf '${name} %s\\n' "$*" >> "$TRACE"\n`, { mode: 0o755 })
      }
      const result = runShell(generatedScript(`exit ${status}`), {
        PATH: `${dir}:/usr/bin:/bin`, CARGO_HOME: dir, TRACE: join(dir, 'trace'),
      }, dir)
      assert.equal(result.status, status)
      assert.match(readFileSync(join(dir, 'trace'), 'utf8'), /sccache --stop-server\n$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

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
  const { exported, workspace } = sccacheEnvironment()
  assert.equal(exported.get('RUSTC_WRAPPER'), 'sccache')
  assert.equal(exported.get('SCCACHE_GHA_ENABLED'), 'false')
  // sccache cannot cache incremental compilation, so the wrapper above is worth nothing without it.
  assert.equal(exported.get('CARGO_INCREMENTAL'), '0')
  assert.equal(exported.get('SCCACHE_BASEDIRS'), workspace)
  assert.equal(exported.get('SCCACHE_DIR'), join(workspace, 'sccache'))
  assert.equal(exported.get('SCCACHE_DIRECT'), 'false')
  assert.equal(exported.get('ACTIONS_RUNTIME_TOKEN'), undefined)
})

test('compiler results use a bounded disk cache instead of per-object GHA writes', () => {
  const { exported, workspace } = sccacheEnvironment()
  assert.equal(exported.get('SCCACHE_GHA_ENABLED'), 'false', 'compiler results must not use the failing remote write path')
  assert.equal(exported.get('SCCACHE_DIR'), join(workspace, 'sccache'))
  assert.equal(exported.get('SCCACHE_CACHE_SIZE'), '1G')
  const steps = readAction('sccache').runs.steps
  const archive = steps.findIndex((step: any) => step.uses?.startsWith('actions/cache@'))
  const install = steps.findIndex((step: any) => step.uses?.startsWith('mozilla-actions/sccache-action'))
  assert.ok(archive >= 0 && archive < install, 'the stats post-step must run before the archive post-step saves its files')
  assert.equal(steps[archive].with.path, '${{ runner.temp }}/sccache')
})

test('a missing sccache degrades the build rather than breaking it', () => {
  // tolerate-failure lets a failed install continue uncached. Exporting RUSTC_WRAPPER anyway
  // would point cargo at a binary that is not there, turning every later compile into a hard
  // failure — the exact outcome tolerating the failure exists to avoid.
  const { exported, stdout } = sccacheEnvironment({ onPath: false })
  assert.equal(exported.get('RUSTC_WRAPPER'), undefined)
  assert.match(stdout, /::warning::/, 'a job compiling uncached says so')
  assert.equal(exported.get('SCCACHE_GHA_ENABLED'), 'false')
})

test('a caller that refuses to tolerate a cache failure gets one', () => {
  // Scheduled runtime builds require a working cache. Silently continuing would report a
  // successful refresh even though subsequent builds could not reuse it.
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

test('a change under .github reaches this suite locally', () => {
  // Without all three of these a workflow or action edit runs no local check at all: the
  // pre-push hook declines the change, and even if it fired, no component tag would map to a
  // test.
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
  // Matched as a pattern, not a literal: more than one tag has no formatter (openapi is
  // the Box API contract), and every one of them has to be filtered out here. Anchoring on
  // the exact one-tag spelling broke the moment a second was added, while the thing worth
  // holding — `ci` never reaching a fmt:/lint: expansion — was still true.
  assert.match(
    changes,
    /FMT_COMPONENTS := \$\(sort \$\(filter-out (?:[a-z]+ )*ci(?: [a-z]+)*,/,
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

/* ------------------------------------------------------------------ setup-infra */

/** The restore step's own shell, run against a stubbed `mstage config get`. */
const restoreDeclaration = ({
  stages,
  config,
  from = '',
}: {
  stages: string
  /** What this job's own environment carries, as the variable holds it. */
  config: string
  /** What another environment's job carried here, for a promotion. */
  from?: string
}) => {
  const step = (readAction('setup-infra').runs.steps as any[]).find(
    (candidate) => candidate.name === 'Restore the stage declaration',
  )
  assert.ok(step, 'setup-infra no longer restores the declaration; this test covers nothing')

  const dir = mkdtempSync(join(tmpdir(), 'boxlite-setup-infra-'))
  try {
    const binDir = join(dir, 'bin')
    mkdirSync(binDir)
    /*
     * `npm run --silent mstage config get -- --stage=<name>`, to its contract:
     * the variable is the only copy on a runner, and the answer is that one
     * stage's block wrapped in its own name. Reading the variable rather than
     * answering from a fixture is what makes the merge below observable —
     * a stub that knew the stages would pass whether or not one was carried in.
     */
    const npm = join(binDir, 'npm')
    writeFileSync(
      npm,
      [
        '#!/bin/sh',
        'for argument in "$@"; do stage="${argument#--stage=}"; done',
        'held="$BOXLITE_MSTAGE_BOXLITE_APP_CONFIG"',
        'if printf \'%s\' "$held" | jq -e --arg s "$stage" \'has($s)\' >/dev/null 2>&1; then',
        '  printf \'%s\' "$held" | jq -c --arg s "$stage" \'{($s): .[$s]}\'',
        'else',
        '  echo "the environment holds no stage $stage" >&2',
        '  exit 1',
        'fi',
        '',
      ].join('\n'),
    )
    chmodSync(npm, 0o755)
    const runnerTemp = join(dir, 'runner-temp')
    mkdirSync(runnerTemp)

    const result = runShell(
      String(step.run),
      {
        PATH: `${binDir}:/usr/bin:/bin`,
        RUNNER_TEMP: runnerTemp,
        STAGES: stages,
        BOXLITE_MSTAGE_BOXLITE_APP_CONFIG: config,
        FROM_CONFIG: from,
      },
      dir,
    )
    const declaration = join(dir, '.mstage.config.json')
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      restored: existsSync(declaration) ? JSON.parse(readFileSync(declaration, 'utf8')) : undefined,
      blocksLeft: existsSync(join(runnerTemp, 'mstage-blocks')),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const block = (stage: string) => ({ home: 'aws', region: `${stage}-region` })
const carries = (...stages: string[]) => JSON.stringify(Object.fromEntries(stages.map((s) => [s, block(s)])))

test('the stage declaration is restored in the shape the loaders read', () => {
  // `.mstage.config.json` is not committed, so the only copy a runner can have is
  // the one this step writes. mstage and mbuild both read a document whose stages
  // sit under `stages`, while `config get` answers with the block alone — the
  // wrapping happens in this shell and nowhere else.
  const { status, restored, blocksLeft } = restoreDeclaration({ stages: 'dev', config: carries('dev') })
  assert.equal(status, 0)
  assert.deepEqual(restored, { stages: { dev: block('dev') } })
  // The blocks are one account's coordinates each, and the merge is the only
  // reader they have.
  assert.ok(!blocksLeft, 'the per-stage blocks outlived the merge')
})

test('a promotion restores both declarations into one document', () => {
  // `mbuild promote` composes the source address as well as the destination's, and
  // a document holding one of them resolves the other against nothing.
  const { status, restored } = restoreDeclaration({ stages: 'dev prod', config: carries('dev', 'prod') })
  assert.equal(status, 0)
  assert.deepEqual(Object.keys((restored as any).stages), ['dev', 'prod'])
})

test('a promotion reads the source stage out of the environment that owns it', () => {
  /*
   * `vars` is scoped to the environment a job binds to, and each stage's
   * variable carries only its own block — so a job in the destination's
   * environment cannot see the source's. A job that did bind to the source
   * carries it here, and the two documents become one.
   *
   * The stub answers only from the variable, so this passes only if the carried
   * block actually reached it: the destination's own copy names one stage.
   */
  const { status, restored } = restoreDeclaration({
    stages: 'dev prod',
    config: carries('prod'),
    from: carries('dev'),
  })
  assert.equal(status, 0)
  assert.deepEqual(restored, { stages: { dev: block('dev'), prod: block('prod') } })
})

test('a declaration the environment does not carry stops setup, not the tool that needed it', () => {
  // Swallowed here it becomes `declares no stage "dev"` from mbuild, minutes later
  // and about a file whose absence is not the reader's fault.
  const { status, stdout, stderr, restored } = restoreDeclaration({ stages: 'dev prod', config: carries('prod') })
  assert.notEqual(status, 0)
  assert.match(stderr, /holds no stage dev/)
  assert.match(stdout, /Could not read the declaration for dev/)
  assert.equal(restored, undefined, 'a half-read declaration must not be left where a tool will read it')
})

test('a job that names no stage is told so rather than left with a declaration nobody wrote', () => {
  // The suites run without one. Silence here becomes `Could not find
  // .mstage.config.json` several steps later, which reads as a broken checkout.
  const { status, stdout, restored } = restoreDeclaration({ stages: '', config: '' })
  assert.equal(status, 0)
  assert.match(stdout, /No stages given/)
  assert.equal(restored, undefined)
})
