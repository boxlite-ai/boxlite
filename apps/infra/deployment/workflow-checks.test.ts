// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { load as loadYaml } from 'js-yaml'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const coverageWorkflow: any = loadYaml(readFileSync(join(REPO_ROOT, '.github/workflows/test.yml'), 'utf8'))
const coverageSuites = ['rust', 'python', 'node', 'go', 'api']

function selectsEmptyCoverage(outputs: Record<string, string>, result = 'success', event = 'pull_request') {
  const job = coverageWorkflow.jobs['coverage-empty']
  assert.ok(job, 'intentionally skipped coverage must still publish a Codecov result')
  // This guard uses the common boolean/equality subset of Actions expressions.
  return runInNewContext(job.if.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), {
    github: { event_name: event },
    needs: { changes: { result, outputs } },
  }, { timeout: 1000 })
}

test('documentation-only PRs and merge groups request a validated empty upload', () => {
  const outputs = Object.fromEntries(coverageSuites.map((suite) => [suite, 'false']))
  for (const event of ['pull_request', 'merge_group']) {
    assert.equal(selectsEmptyCoverage(outputs, 'success', event), true)
    assert.ok(Object.hasOwn(coverageWorkflow.on, event))
    assert.equal(coverageWorkflow.on[event]?.paths, undefined)
    assert.equal(coverageWorkflow.on[event]?.['paths-ignore'], undefined)
  }
  const job = coverageWorkflow.jobs['coverage-empty']
  assert.equal(job.needs, 'changes')
  assert.equal(job.permissions['id-token'], 'write')
  const upload = job.steps.find((step: any) => step.uses?.startsWith('codecov/codecov-action@'))
  assert.equal(upload?.with?.run_command, 'empty-upload')
  assert.equal(upload.with.force, undefined, 'Codecov must validate the changed files')
  assert.equal(upload.with.use_oidc, true)
  assert.equal(upload.with.fail_ci_if_error, true)
})

test('empty upload cannot replace a selected suite or failed change detection', () => {
  const outputs = Object.fromEntries(coverageSuites.map((suite) => [suite, 'false']))
  for (const suite of coverageSuites) {
    for (const value of ['true', '', 'unknown']) {
      assert.equal(selectsEmptyCoverage({ ...outputs, [suite]: value }), false, `${suite}=${value}`)
    }
    const missing = { ...outputs }
    delete missing[suite]
    assert.equal(selectsEmptyCoverage(missing), false, `missing ${suite}`)
  }
  for (const result of ['failure', 'cancelled', 'skipped']) {
    assert.equal(selectsEmptyCoverage(outputs, result), false, result)
  }
  for (const event of ['push', 'schedule', 'workflow_dispatch']) {
    assert.equal(selectsEmptyCoverage(outputs, 'success', event), false, event)
  }
})

test('the required conclusion fails when the empty upload fails', () => {
  const job = coverageWorkflow.jobs['test-conclusion']
  assert.ok(job.needs.includes('coverage-empty'), 'the required check must wait for the empty upload')
  for (const [result, succeeds] of [['success', true], ['skipped', true], ['failure', false], ['cancelled', false]] as const) {
    const needs = Object.fromEntries(job.needs.map((name: string) => [name, { result: name === 'coverage-empty' ? result : 'success' }]))
    const script = job.steps[0].run.replaceAll('${{ toJSON(needs) }}', JSON.stringify(needs))
    const run = spawnSync('bash', ['-eo', 'pipefail', '-c', script], { encoding: 'utf8', timeout: 10_000 })
    assert.equal(run.error, undefined)
    assert.equal(run.status === 0, succeeds, `${result}: ${run.stderr}`)
  }
})

test('patch coverage requires 90 percent and a report while total stays informational', () => {
  const config: any = loadYaml(readFileSync(join(REPO_ROOT, 'codecov.yml'), 'utf8'))
  assert.equal(config.coverage.status.patch.default.target, '90%')
  assert.equal(config.coverage.status.patch.default.threshold, '0%')
  assert.equal(config.coverage.status.patch.default.if_not_found, 'failure')
  assert.equal(config.coverage.status.project.default.informational, true)
})

function cliUnitTests(runner: 'cargo' | 'nextest', exitCode = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'boxlite-cli-unit-'))
  try {
    const log = join(directory, 'cargo.log')
    writeFileSync(join(directory, 'cargo'), `#!/bin/sh
if [ "$1" = nextest ] && ! command -v cargo-nextest >/dev/null 2>&1; then
  echo 'error: no such command: nextest' >&2
  exit 101
fi
printf '%s\\n' "$@" > "$CARGO_LOG"
exit "$CARGO_STATUS"
`, { mode: 0o755 })
    if (runner === 'nextest') {
      writeFileSync(join(directory, 'cargo-nextest'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    }
    // Isolate tool discovery so an installed nextest cannot hide the fallback.
    const result = spawnSync('/usr/bin/make', ['-f', join(REPO_ROOT, 'make/test.mk'), 'test:unit:cli', 'NEXTEST_PROFILE=ci'], {
      cwd: REPO_ROOT,
      env: { ...process.env, PATH: directory, MAKEFLAGS: '', CARGO_LOG: log, CARGO_STATUS: String(exitCode) },
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.equal(result.error, undefined)
    const args = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
    return { result, args }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('CLI unit tests fall back to Cargo without running VM integration binaries', () => {
  const { result, args } = cliUnitTests('cargo')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(args, ['test', '-p', 'boxlite-cli', '--bins', '--', '--test-threads=1', '::tests::'])
})

test('CLI unit tests use the requested nextest profile when installed', () => {
  const { result, args } = cliUnitTests('nextest')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(args, ['nextest', 'run', '-p', 'boxlite-cli', '--profile', 'ci', '-E', 'test(::tests::)'])
})

for (const runner of ['cargo', 'nextest'] as const) {
  test(`CLI unit tests propagate ${runner} failures`, () => {
    const { result, args } = cliUnitTests(runner, 17)
    assert.notEqual(result.status, 0)
    assert.ok(args.length > 0, 'the selected test runner must execute')
    assert.match(result.stderr, /Error 17/)
  })
}

function workflowConfig(fullMatrix: string) {
  const actionPath = join(REPO_ROOT, '.github/actions/ci-config')
  const action: any = loadYaml(readFileSync(join(actionPath, 'action.yml'), 'utf8'))
  const directory = mkdtempSync(join(tmpdir(), 'boxlite-ci-config-'))
  try {
    const output = join(directory, 'outputs')
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', action.runs.steps[0].run], {
      env: { ...process.env, GITHUB_ACTION_PATH: actionPath, GITHUB_OUTPUT: output, FULL_MATRIX: fullMatrix },
      encoding: 'utf8',
      timeout: 10_000,
    })
    const values = new Map(
      (existsSync(output) ? readFileSync(output, 'utf8').trim().split('\n') : []).map((line) => {
        const separator = line.indexOf('=')
        return [line.slice(0, separator), line.slice(separator + 1)]
      }),
    )
    return { result, values }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

for (const [sdk, compactCount, fullCount] of [['python', 6, 12], ['node', 5, 9]] as const) {
  test(`${sdk} PR matrix covers every version and platform without the full cross product`, () => {
    const { result, values } = workflowConfig('false')
    assert.equal(result.status, 0, result.stderr)
    const matrix = JSON.parse(values.get(`${sdk}-test-matrix`)!)
    const platforms = JSON.parse(values.get('platforms')!)
    const versions: string[] = JSON.parse(values.get(`${sdk}-versions`)!)
    assert.equal(matrix.length, compactCount)
    assert.deepEqual(new Set(matrix.map((entry: any) => entry.platform.target)), new Set(platforms.map((entry: any) => entry.target)))
    assert.deepEqual(matrix.filter((entry: any) => entry.platform.target === 'linux-x64-gnu').map((entry: any) => entry[`${sdk}-version`]), versions)
    assert.ok(matrix.filter((entry: any) => entry.platform.target !== 'linux-x64-gnu').every((entry: any) => entry[`${sdk}-version`] === versions.at(-1)))
  })

  test(`${sdk} full matrix retains every platform/version combination`, () => {
    const { result, values } = workflowConfig('true')
    assert.equal(result.status, 0, result.stderr)
    const matrix = JSON.parse(values.get(`${sdk}-test-matrix`)!)
    const platforms: Array<{ target: string }> = JSON.parse(values.get('platforms')!)
    const versions: string[] = JSON.parse(values.get(`${sdk}-versions`)!)
    assert.equal(matrix.length, fullCount)
    assert.deepEqual(
      new Set(matrix.map((entry: any) => `${entry.platform.target}/${entry[`${sdk}-version`]}`)),
      new Set(platforms.flatMap((platform) => versions.map((version) => `${platform.target}/${version}`))),
    )
  })
}

test('invalid matrix mode fails before exporting configuration', () => {
  const { result, values } = workflowConfig('typo')
  assert.equal(result.status, 1)
  assert.equal(values.size, 0)
  assert.match(result.stdout, /full-matrix must be true or false/)
})

function buildImages(selection?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'boxlite-image-selection-'))
  try {
    const log = join(directory, 'docker.log')
    writeFileSync(join(directory, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_LOG"\n', { mode: 0o755 })
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, DOCKER_LOG: log, PUSH: '0', PLATFORMS: 'linux/amd64,linux/arm64', TAG: 'v0.0.0', IMAGES: selection }
    const result = spawnSync('bash', [join(REPO_ROOT, 'apps/box-images/build.sh')], { env, encoding: 'utf8', timeout: 10_000 })
    const builds = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
    return { result, builds }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('image builds select a single changed flavor while preserving both architectures', () => {
  const { result, builds } = buildImages('python')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(builds.length, 1)
  assert.match(builds[0], /python\.Dockerfile/)
  assert.match(builds[0], /--platform linux\/amd64,linux\/arm64/)
})

test('image builds default to every release flavor', () => {
  const { result, builds } = buildImages()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(builds.length, 3)
  for (const image of ['base', 'python', 'node']) {
    assert.ok(builds.some((build) => build.includes(`/${image}.Dockerfile`)))
  }
})

test('invalid image selections fail before any Docker invocation', () => {
  for (const selection of ['', 'python,', ',python', 'python,,node', 'python,../../unexpected']) {
    const { result, builds } = buildImages(selection)
    assert.equal(result.status, 1, selection)
    assert.deepEqual(builds, [], selection)
  }
})

test('the wheel smoke check rejects a package with a missing native extension', () => {
  const project = readFileSync(join(REPO_ROOT, 'sdks/python/pyproject.toml'), 'utf8')
  const command = project.match(/^test-command = "(.*)"$/m)?.[1]
  assert.ok(command, 'cibuildwheel must verify the installed wheel')
  const directory = mkdtempSync(join(tmpdir(), 'boxlite-wheel-check-'))
  try {
    mkdirSync(join(directory, 'boxlite'))
    // Exercise the real package initializer, but omit the compiled extension.
    copyFileSync(join(REPO_ROOT, 'sdks/python/boxlite/__init__.py'), join(directory, 'boxlite/__init__.py'))
    const result = spawnSync('bash', ['-c', command.replace(/^python /, 'python3 ')], {
      cwd: directory,
      env: { ...process.env, PYTHONPATH: directory },
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.equal(result.error, undefined)
    assert.notEqual(result.status, 0, 'wheel smoke check accepted a missing native extension')
    assert.match(result.stderr, /No module named 'boxlite\.boxlite'/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
