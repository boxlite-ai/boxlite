import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

const sha = 'a'.repeat(40)
const cli = fileURLToPath(new URL('../bin/mbuild.ts', import.meta.url))
const loader = fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url))

// Run the real CLI and workflow shell; replace only the external services.
const fixture = (t: TestContext, manager: 'npm' | 'yarn') => {
  const directory = mkdtempSync(join(tmpdir(), 'mbuild-audit-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const script = (name: string, body: string) =>
    writeFileSync(join(directory, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 })
  writeFileSync(join(directory, 'calls'), '')
  writeFileSync(
    join(directory, 'mstage.env.json'),
    JSON.stringify({
      app: 'audit-test',
      root: '.',
      artifacts: { api: { dockerfile: 'Dockerfile', context: '.' } },
      audit: { manager, directory: '.' },
    }),
  )
  writeFileSync(
    join(directory, '.mstage.config.json'),
    JSON.stringify({
      stages: {
        dev: {
          home: 'gcp',
          region: 'us-east1',
          project: 'audit-test',
          registry: { kind: 'artifact-registry', repository: 'images', immutableTags: true, scanOnPush: true },
          scan: { blockOn: 'DISABLED', timeoutSeconds: 300 },
        },
      },
    }),
  )
  script('gcloud', 'if [[ "$*" == *"repositories describe"* ]]; then echo True; fi')
  script('docker', 'echo docker >> "$AUDIT_TEST_CALLS"; exit 99')
  script('sleep', 'echo sleep >> "$AUDIT_TEST_CALLS"')
  const audit = 'echo audit >> "$AUDIT_TEST_CALLS"; echo "$AUDIT_TEST_STDOUT"; echo "$AUDIT_TEST_STDERR" >&2; exit 1'
  script('corepack', audit)
  script(
    'npm',
    `if [[ "$1" == --prefix ]]; then ${audit}; fi
shift 3
command=$1
shift 2
exec "$AUDIT_TEST_NODE" --import "$AUDIT_TEST_LOADER" --conditions=development "$AUDIT_TEST_CLI" "$command" "$@"`,
  )
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    MSTAGE_ENV_CONFIG: join(directory, 'mstage.env.json'),
    MSTAGE_CONFIG: join(directory, '.mstage.config.json'),
    AUDIT_TEST_NODE: process.execPath,
    AUDIT_TEST_LOADER: loader,
    AUDIT_TEST_CLI: cli,
    AUDIT_TEST_CALLS: join(directory, 'calls'),
    AUDIT_TEST_STDOUT: 'high severity advisory',
    AUDIT_TEST_STDERR: 'audit diagnostic',
    IMAGE_TAG: sha,
    SHA: sha,
    TARGET_STAGE: 'dev',
    ARTIFACT: 'api',
    TAG: 'v1.2.3',
  }
  return {
    env,
    script,
    calls: () => readFileSync(join(directory, 'calls'), 'utf8').trim().split('\n').filter(Boolean),
    run: (command: string, args: string[]) =>
      spawnSync(command, args, {
        cwd: directory,
        env,
        encoding: 'utf8',
        timeout: 30_000,
      }),
  }
}

for (const manager of ['npm', 'yarn'] as const) {
  for (const unavailable of [false, true]) {
    test(`${manager} audit ${unavailable ? 'service failure' : 'finding'} exits 65 before building`, (t) => {
      const probe = fixture(t, manager)
      if (unavailable) {
        probe.env.AUDIT_TEST_STDOUT = ''
        probe.env.AUDIT_TEST_STDERR = 'registry unavailable'
      }
      const result = probe.run(process.execPath, [
        '--import',
        loader,
        '--conditions=development',
        cli,
        'publish',
        '--tag',
        sha,
        '--stage',
        'dev',
      ])
      assert.match(result.stderr, new RegExp(`${manager} audit did not pass`))
      assert.match(result.stderr, new RegExp(probe.env.AUDIT_TEST_STDERR))
      if (!unavailable) assert.match(result.stderr, /high severity advisory/)
      assert.deepEqual(probe.calls(), ['audit'], 'no image command may follow a failed audit')
      assert.equal(result.status, 65, result.stderr)
    })
  }
}

for (const [filename, job] of [
  ['mbuild.yml', 'mbuild'],
  ['mbuild-release.yml', 'publish'],
]) {
  const workflow = load(
    readFileSync(new URL(`../../../../.github/workflows/${filename}`, import.meta.url), 'utf8'),
  ) as {
    jobs: Record<string, { steps: { name?: string; run?: string }[] }>
  }
  const shell = workflow.jobs[job!]!.steps.find((step) => step.name === 'Build and upload')!.run!

  for (const manager of ['npm', 'yarn'] as const) {
    test(`${filename} stops after one failed ${manager} audit without backoff`, (t) => {
      const probe = fixture(t, manager)
      const result = probe.run('bash', ['-c', shell])
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, new RegExp(`${manager} audit did not pass`))
      assert.deepEqual(probe.calls(), ['audit'])
      assert.match(result.stdout, /dependency audit/)
      assert.doesNotMatch(result.stdout, /retrying/)
    })
  }

  for (const scanRefused of [true, false]) {
    test(`${filename} ${scanRefused ? 'stops on scan refusal' : 'retries a transient publication failure'}`, (t) => {
      const probe = fixture(t, 'yarn')
      probe.script(
        'npm',
        `echo publish >> "$AUDIT_TEST_CALLS"
${scanRefused ? 'exit 78' : '[[ $(wc -l < "$AUDIT_TEST_CALLS") -gt 1 ]]'}`,
      )
      const result = probe.run('bash', ['-c', shell])
      assert.equal(result.status, scanRefused ? 1 : 0, result.stderr)
      assert.deepEqual(probe.calls(), scanRefused ? ['publish'] : ['publish', 'sleep', 'publish'])
    })
  }
}
