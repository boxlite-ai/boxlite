// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { load as loadYaml } from 'js-yaml'
import { parse as parseToml } from 'smol-toml'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
// Use the glob engine used by paths-filter, including its extglob behavior.
const picomatch = createRequire(import.meta.url)('picomatch') as (pattern: string, options: { dot: boolean }) => (path: string) => boolean
const workflow = (name: string): any => loadYaml(readFileSync(join(REPO_ROOT, '.github/workflows', name), 'utf8'))
const matches = (pattern: string, path: string) => picomatch(pattern, { dot: true })(path)

function testSuites(paths: string[]) {
  const filter = workflow('test.yml').jobs.changes.steps.find((step: any) => step.uses?.startsWith('dorny/paths-filter'))
  const rules = loadYaml(filter.with.filters) as Record<string, string[]>
  return Object.keys(rules).filter((suite) => paths.some((path) => rules[suite].some((pattern) => matches(pattern, path))))
}

function acceptsFiles(name: string, event: string, files: string[]) {
  const trigger = workflow(name).on[event]
  if (trigger?.['paths-ignore'] && files.every((file) => trigger['paths-ignore'].some((pattern: string) => matches(pattern, file)))) return false
  if (!trigger?.paths) return true
  return files.some((file) => trigger.paths.reduce((included: boolean, pattern: string) => {
    const exclude = pattern.startsWith('!')
    return matches(exclude ? pattern.slice(1) : pattern, file) ? !exclude : included
  }, false))
}

for (const path of ['sdks/go/README.md', 'sdks/python/README.md', 'sdks/node/README.md', 'src/cli/README.md', 'apps/api/README.md', 'make/help.mk', 'make/clean.mk']) {
  test(`unrelated prose or Make utilities do not rebuild SDKs: ${path}`, () => {
    assert.deepEqual(testSuites([path]), [])
  })
}

for (const [path, expected] of [
  ['sdks/go/options.go', ['go']],
  ['sdks/python/boxlite/options.py', ['python']],
  ['sdks/node/lib/options.ts', ['node']],
  ['src/cli/src/main.rs', ['rust']],
  ['make/coverage.mk', ['rust', 'python', 'node', 'go']],
  ['make/quality.mk', ['go']],
  ['.github/workflows/lint.yml', ['go']],
] as const) {
  test(`source and shared recipes retain their tests: ${path}`, () => {
    assert.deepEqual(testSuites(['docs/README.md', path]), [...expected])
  })
}

for (const [name, events] of [
  ['codeql.yml', ['pull_request', 'push']],
  ['e2e-local.yml', ['pull_request_target', 'push']],
  ['api-client-drift.yml', ['pull_request']],
] as const) {
  for (const event of events) {
    test(`${name} skips documentation-only ${event} changes but keeps code changes`, () => {
      assert.equal(acceptsFiles(name, event, ['sdks/go/README.md', 'apps/api/README.md']), false)
      assert.equal(acceptsFiles(name, event, ['docs/README.md', 'apps/api/src/main.ts', 'sdks/go/options.go']), true)
    })
  }
}

test('Go vet and golangci-lint reuse the Linux coverage build', () => {
  const steps = workflow('test.yml').jobs.go.steps
  const buildAt = steps.findIndex((step: any) => step.run === 'make coverage:go')
  const vetAt = steps.findIndex((step: any) => step.run === 'make lint:go')
  const lintAt = steps.findIndex((step: any) => step.uses?.startsWith('golangci/golangci-lint-action'))
  assert.ok(buildAt >= 0 && vetAt > buildAt && lintAt > buildAt, 'Go analysis must reuse the native library produced by coverage')
  for (const index of [vetAt, lintAt]) assert.equal(steps[index].if, "matrix.platform.target == 'linux-x64-gnu'")
  assert.match(steps[lintAt].uses, /@[0-9a-f]{40}$/, 'Go analysis with OIDC access must use an immutable action revision')
  const formatting = workflow('lint.yml').jobs.go.steps
  assert.ok(formatting.some((step: any) => step.run === 'make fmt:check:go'))
  assert.ok(!formatting.some((step: any) => /dev:go|setup:build/.test(step.run ?? '')), 'formatting must not build the native runtime')
})

test('distribution runtime builds retain release, weekly and manual triggers without push rebuilds', () => {
  const triggers = workflow('build-runtime.yml').on
  assert.equal('push' in triggers, false)
  assert.ok('release' in triggers && 'schedule' in triggers && 'workflow_dispatch' in triggers)
})

for (const event of ['pull_request', 'push', 'merge_group', 'schedule', 'workflow_dispatch']) {
  test(`guest artifact qualification is scheduled or manual only: ${event}`, () => {
    const workflow: any = loadYaml(readFileSync(join(REPO_ROOT, '.github/workflows/test.yml'), 'utf8'))
    const expression = workflow.jobs.guest_artifacts.if.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    // This gate uses property access, string equality and boolean operators,
    // which have the same semantics here in Actions expressions and JavaScript.
    const shouldRun = runInNewContext(expression, {
      github: { event_name: event },
      needs: { changes: { outputs: { guest_artifacts: 'true' } } },
    }, { timeout: 1000 })
    assert.equal(shouldRun, event === 'schedule' || event === 'workflow_dispatch',
      `${event} must not start guest artifact builds unless explicitly scheduled or dispatched`)
    assert.ok(event in workflow.on, `the workflow must still accept ${event}`)
  })
}

for (const result of ['skipped', 'success', 'failure', 'cancelled']) {
  test(`Test conclusion handles guest artifact result: ${result}`, () => {
    const workflow: any = loadYaml(readFileSync(join(REPO_ROOT, '.github/workflows/test.yml'), 'utf8'))
    const conclusion = workflow.jobs['test-conclusion']
    assert.ok(conclusion.needs.includes('guest_artifacts'))
    const needs = Object.fromEntries(conclusion.needs.map((name: string) => [name, {
      result: name === 'guest_artifacts' ? result : 'success',
    }]))
    const script = conclusion.steps[0].run.replaceAll('${{ toJSON(needs) }}', JSON.stringify(needs))
    const execution = spawnSync('bash', ['-eo', 'pipefail', '-c', script], {
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.equal(execution.error, undefined)
    assert.equal(execution.status === 0, result === 'success' || result === 'skipped', execution.stderr)
  })
}

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

function buildImages(selection?: string, cached = false) {
  const directory = mkdtempSync(join(tmpdir(), 'boxlite-image-selection-'))
  try {
    const log = join(directory, 'docker.log')
    writeFileSync(join(directory, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_LOG"\n', { mode: 0o755 })
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, DOCKER_LOG: log, PUSH: '0', PLATFORMS: 'linux/amd64,linux/arm64', TAG: 'v0.0.0', IMAGES: selection,
      ACTIONS_RUNTIME_TOKEN: cached ? 'test-token' : '', ACTIONS_RESULTS_URL: cached ? 'https://cache.example/' : '' }
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

test('CI image builds persist separate layer caches for each flavor', () => {
  const { result, builds } = buildImages('base,python,node', true)
  assert.equal(result.status, 0, result.stderr)
  for (const [index, flavor] of ['base', 'python', 'node'].entries()) {
    assert.match(builds[index], new RegExp(`--cache-from type=gha,version=2,scope=box-images-${flavor}`))
    assert.match(builds[index], new RegExp(`--cache-to type=gha,version=2,scope=box-images-${flavor},mode=max,ignore-error=true,timeout=3m`))
    assert.ok(!builds[index].includes('test-token'), 'cache credentials must stay out of command arguments')
  }
})

test('local image builds do not require GitHub cache credentials', () => {
  const { result, builds } = buildImages('base')
  assert.equal(result.status, 0, result.stderr)
  assert.ok(!builds[0].includes('--cache-'))
})

test('invalid image selections fail before any Docker invocation', () => {
  for (const selection of ['', 'python,', ',python', 'python,,node', 'python,../../unexpected']) {
    const { result, builds } = buildImages(selection)
    assert.equal(result.status, 1, selection)
    assert.deepEqual(builds, [], selection)
  }
})

for (const sharedCache of [true, false]) {
  for (const source of ['host', 'pip', 'unavailable'] as const) {
    test(`wheel cache setup: shared=${sharedCache}, source=${source}`, () => {
      const installSucceeds = source !== 'unavailable'
      const project = parseToml(readFileSync(join(REPO_ROOT, 'sdks/python/pyproject.toml'), 'utf8')) as any
      const config = project.tool.cibuildwheel
      const directory = mkdtempSync(join(tmpdir(), 'boxlite-wheel-cache-'))
      try {
        const bin = join(directory, 'bin')
        const pythonBin = join(directory, 'python-bin')
        const wrapper = join(directory, 'stable-bin/sccache')
        const cache = join(directory, 'container-cache')
        const host = join(directory, 'host')
        const hostCache = join(host, 'runner cache/sccache')
        const hostBinary = join(host, 'runner tools/sccache')
        const trace = join(directory, 'trace')
        for (const path of [bin, pythonBin, dirname(wrapper), hostCache, dirname(hostBinary), join(directory, 'scripts'), join(directory, 'home')]) {
          mkdirSync(path, { recursive: true })
        }
        writeFileSync(join(bin, 'pip'), `#!/bin/sh
printf 'pip %s\\n' "$*" >> "$TRACE"
[ "$INSTALL_SUCCEEDS" = true ] || exit 1
# PyPI publishes 0.16.0, but does not publish the host action's 0.17.0 release.
[ "$*" = 'install sccache==0.16.0' ] || exit 1
cat > "$PYTHON_BIN/sccache" <<'WRAPPER'
#!/bin/sh
printf 'installed-wrapper %s\\n' "$*" >> "$TRACE"
[ "$1" = --stop-server ] && exit 0
exec "$@"
WRAPPER
chmod +x "$PYTHON_BIN/sccache"
`, { mode: 0o755 })
        if (source === 'host') {
          writeFileSync(hostBinary, `#!/bin/sh
printf 'host-wrapper %s\\n' "$*" >> "$TRACE"
[ "$1" = --stop-server ] && exit 0
exec "$@"
`, { mode: 0o755 })
        }
        writeFileSync(join(bin, 'uname'), '#!/bin/sh\necho Linux\n', { mode: 0o755 })
        writeFileSync(join(directory, 'scripts/util.sh'), '#!/bin/sh\necho x86_64-unknown-linux-musl\n', { mode: 0o755 })
        writeFileSync(join(bin, 'make'), `#!/bin/sh
printf 'make %s\\nwrapper=%s\\ncache=%s\\n' "$*" "\${RUSTC_WRAPPER:-}" "\${SCCACHE_DIR:-}" >> "$TRACE"
if [ "$1" = runtime ]; then
  if [ -n "\${RUSTC_WRAPPER:-}" ]; then
    "$RUSTC_WRAPPER" /bin/echo compiler-invoked >> "$TRACE"
  else
    /bin/echo compiler-invoked >> "$TRACE"
  fi
fi
`, { mode: 0o755 })
        // Relocate fixed container paths only. Branches, commands and assertions use
        // the production TOML; no fixture may write to the host's /usr/local or /tmp cache.
        const relocate = (value: string) => value
          .replaceAll('/usr/local/bin/sccache', wrapper)
          .replaceAll('/tmp/boxlite-sccache', cache)
          .replaceAll('/host', host)
        const env = {
          ...Object.fromEntries(Object.entries<string>(config.linux.environment).map(([name, value]) => [name, relocate(value)])),
          PATH: `${bin}:${pythonBin}:${dirname(wrapper)}:/usr/bin:/bin`, HOME: join(directory, 'home'),
          TRACE: trace, PYTHON_BIN: pythonBin, INSTALL_SUCCEEDS: String(source === 'pip'),
          BOXLITE_HOST_SCCACHE_DIR: sharedCache ? '/runner cache/sccache' : '',
          BOXLITE_HOST_SCCACHE_BIN: source === 'host' ? '/runner tools/sccache' : '',
        }
        const result = spawnSync('bash', ['-e', '-c', relocate(config['before-all'].join('\n'))], {
          cwd: directory, env, encoding: 'utf8', timeout: 10_000,
        })
        assert.equal(result.status, 0, result.stderr)
        const calls = readFileSync(trace, 'utf8')
        assert.ok(calls.includes(`wrapper=${wrapper}\n`), 'runtime must use the stable wrapper from the wheel environment')
        assert.ok(calls.includes(`cache=${cache}\n`), 'runtime must use the configured disk cache')
        assert.match(calls, /compiler-invoked\n/, 'both installed and fallback wrappers must invoke the compiler')
        assert.equal(calls.includes('installed-wrapper /bin/echo'), source === 'pip', 'standalone wheels must install a published package')
        assert.equal(calls.includes('host-wrapper /bin/echo'), source === 'host', 'CI wheels must execute the verified host binary')
        assert.equal(lstatSync(wrapper).isSymbolicLink(), source === 'pip')
        if (source === 'host') {
          assert.ok(!calls.includes('pip '), 'the verified host binary needs no second installation')
          const build = workflow('build-wheels.yml').jobs.build_wheels.steps.find((step: any) => step.uses?.startsWith('pypa/cibuildwheel'))
          assert.equal(build.env.BOXLITE_HOST_SCCACHE_BIN, '${{ env.SCCACHE_PATH }}')
          assert.ok(config.linux['environment-pass'].includes('BOXLITE_HOST_SCCACHE_BIN'))
        }
        if (sharedCache) {
          assert.equal(realpathSync(cache), realpathSync(hostCache), 'the container must share the host cache, including paths with spaces')
        } else {
          assert.notEqual(lstatSync(cache, { throwIfNoEntry: false })?.isSymbolicLink(), true,
            'a local build must not create a host link, including a dangling one')
        }
        if (!installSucceeds) assert.match(result.stdout, /WARNING: sccache not available/)
        const stop = spawnSync('bash', ['-e', '-c', relocate(config.linux['before-test'] ?? '')], {
          cwd: directory, env, encoding: 'utf8', timeout: 10_000,
        })
        assert.equal(stop.status, 0, 'the pass-through fallback must tolerate server shutdown')
        if (installSucceeds) assert.match(readFileSync(trace, 'utf8'), source === 'host' ? /host-wrapper --stop-server\n$/ : /installed-wrapper --stop-server\n$/)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })
  }
}

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
