import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

const sha = 'a'.repeat(40)
const tag = `v1.2.3-${sha}`
const mediaType = 'application/vnd.docker.distribution.manifest.v2+json'
const manifest = JSON.stringify({ schemaVersion: 2, mediaType, config: {}, layers: [] })
const digest = `sha256:${createHash('sha256').update(manifest).digest('hex')}`
const cli = fileURLToPath(new URL('../bin/mbuild.ts', import.meta.url))
const loader = fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url))

const fixture = (t: TestContext, cloud = false) => {
  const directory = mkdtempSync(join(tmpdir(), 'mbuild-ghcr-cli-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const script = (name: string, body: string) => writeFileSync(join(directory, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 })
  writeFileSync(join(directory, 'mstage.env.json'), JSON.stringify({ app: 'cli-test', root: '.', artifacts: { api: { dockerfile: 'Dockerfile', context: '.' } } }))
  writeFileSync(join(directory, '.mstage.config.json'), JSON.stringify({ stages: {
    dev: { home: 'gcp', region: 'us-east1', project: 'project', registry: { kind: 'artifact-registry', repository: 'images', immutableTags: true, scanOnPush: true }, scan: { blockOn: 'DISABLED' } },
  } }))
  script('curl', `if [[ "$*" == *'/token?'* ]]; then body='{"token":"bearer-token"}'; type='application/json'; else body='${manifest}'; type='${mediaType}'; fi
printf '%s\\n200' "$body"
if [[ "$*" == *'%{content_type}'* ]]; then printf '\\n%s' "$type"; fi`)
  script('gcloud', `if [[ "$*" == *'repositories describe'* ]]; then printf True;
elif [[ "$*" == *'--format=json'* ]]; then printf '%s' '${JSON.stringify([{ version: digest, tags: [tag] }])}';
elif [[ "$*" == *'images list'* ]]; then printf '%s' '${digest}'; fi`)
  script('docker', 'exit 0')
  const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, MSTAGE_ENV_CONFIG: join(directory, 'mstage.env.json'), MSTAGE_CONFIG: join(directory, cloud ? '.mstage.config.json' : 'missing-stage-config.json'),
    GHCR_USERNAME: 'actor', GHCR_TOKEN: 'test-token', GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'boxlite-ai/boxlite',
    GITHUB_WORKFLOW_REF: 'boxlite-ai/boxlite/.github/workflows/mbuild-release.yml@refs/heads/main', GITHUB_JOB: 'publish', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', RUNNER_TEMP: directory }
  return (args: string[]) => spawnSync(process.execPath, ['--import', loader, '--conditions=development', cli, ...args], { cwd: directory, env, encoding: 'utf8', timeout: 10_000 })
}

for (const command of ['publish', 'verify', 'import-release']) test(`GHCR CLI ${command} executes its production operation`, (t) => {
  const run = fixture(t, command === 'import-release')
  const result = run([command, '--ghcr', 'boxlite-ai/boxlite', '--tag', sha, '--version', 'v1.2.3', ...(command === 'import-release' ? ['--stage', 'dev'] : [])])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, command === 'import-release' ? /api=us-east1-docker.pkg.dev\/project\/images\/api:/ : /api=ghcr.io\/boxlite-ai\/boxlite\/api:/)
})

test('GHCR CLI rejects unsupported operations, incomplete releases and unknown artifacts', (t) => {
  const run = fixture(t, true)
  for (const [args, expected] of [
    [['import-release', '--tag', sha], /requires --ghcr/],
    [['inspect', '--ghcr', 'boxlite-ai/boxlite'], /requires.*verify/],
    [['verify', '--ghcr', 'boxlite-ai/boxlite', '--tag', sha], /requires --version/],
    [['verify', '--ghcr', 'boxlite-ai/boxlite', '--tag', 'short', '--version', 'v1.2.3'], /full commit SHA/],
    [['verify', '--ghcr', 'boxlite-ai/boxlite', '--tag', sha, '--version', 'v1.2.3', '--artifact', 'unknown'], /unknown|declares no artifact/],
  ] as const) {
    const result = run([...args])
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, expected)
  }
})
