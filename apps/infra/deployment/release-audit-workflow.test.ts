import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { resolveRegistry } from '../mbuild/src/address.ts'
import { parseBuildConfig } from '../mbuild/src/config.ts'
import { AuditFailedError, publish, type RunOptions } from '../mbuild/src/publish.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const path = join(root, '.github/workflows/release-dependency-audit.yml')
const workflow = (): any => existsSync(path) ? load(readFileSync(path, 'utf8')) : { on: {}, jobs: {} }
const auditJob = () => {
  const job = workflow().jobs.audit
  assert.ok(job, 'release version PRs need a dependency audit job before publication')
  return job
}
const releaseTitle = 'chore(release): bump version to 0.11.2'

function selected(title: string, event = 'pull_request', draft = false): boolean {
  return runInNewContext(auditJob().if.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), {
    github: { event_name: event, event: event === 'pull_request' ? { pull_request: { title, draft } } : {} },
    startsWith: (value: string, prefix: string) => value.toLowerCase().startsWith(prefix.toLowerCase()),
  }, { timeout: 1000 })
}

test('release audit covers PR updates and title edits without changing Test triggers', () => {
  const spec = workflow()
  assert.ok(spec.on.pull_request, 'release preflight must subscribe to PR events')
  assert.deepEqual(spec.on.pull_request.branches, ['main'])
  for (const event of ['opened', 'synchronize', 'reopened', 'edited']) {
    assert.ok(spec.on.pull_request.types.includes(event), event)
  }
  assert.equal(spec.on.pull_request.paths, undefined, 'version-only releases must run the audit')
  assert.deepEqual(spec.on.merge_group.types, ['checks_requested'])
  const tests = load(readFileSync(join(root, '.github/workflows/test.yml'), 'utf8')) as any
  assert.ok(!tests.on.pull_request.types.includes('edited'), 'metadata edits must not rerun the test matrices')
})

test('release audit selection follows title changes and includes drafts', () => {
  assert.equal(selected('feat(api): add an endpoint'), false)
  assert.equal(selected(releaseTitle), true, 'renaming an ordinary PR to a release enables the audit')
  assert.equal(selected('chore: update release notes'), false, 'renaming away from release disables the audit')
  assert.equal(selected(releaseTitle, 'pull_request', true), true)
  assert.equal(selected('Chore(Release): bump version to 0.11.2'), true)
  assert.equal(selected('fix: ' + releaseTitle), false)
  assert.equal(selected('chore(release): bump version to'), false)
  assert.equal(selected(releaseTitle, 'merge_group'), false, 'merge queues allocate no audit runner')
})

test('release audit uses one bounded job with read-only checkout and no dependency install', () => {
  const spec = workflow()
  const job = auditJob()
  assert.equal(Object.keys(spec.jobs).length, 1)
  assert.equal(job.name, 'Release dependency audit')
  assert.deepEqual(spec.permissions, { contents: 'read' })
  assert.equal(job['runs-on'], 'ubuntu-latest')
  assert.ok(job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 5)
  assert.equal(job['continue-on-error'], undefined)
  assert.equal(job.steps.find((step: any) => step.uses?.startsWith('actions/checkout@')).with['persist-credentials'], false)
  assert.equal(String(job.steps.find((step: any) => step.uses?.startsWith('actions/setup-node@')).with['node-version']), '22')
  assert.deepEqual(job.steps.filter((step: any) => step.run).map((step: any) => step.run), ['make audit:apps'])
  assert.equal(job.steps.find((step: any) => step.run)['continue-on-error'], undefined)
  assert.equal(spec.concurrency['cancel-in-progress'], true)
  assert.match(spec.concurrency.group, /github\.ref/)
})

async function publicationAudit(): Promise<{ cwd: string | undefined; args: string[] }> {
  const basePath = join(root, 'apps/infra/mstage.env.json')
  const config = parseBuildConfig({
    basePath,
    base: readFileSync(basePath, 'utf8'),
    stagePath: join(root, 'apps/infra/.mstage.config.json'),
    stages: JSON.stringify({ stages: { dev: {
      home: 'gcp',
      registry: { kind: 'artifact-registry', repository: 'images', immutableTags: true, scanOnPush: true },
      scan: { blockOn: 'DISABLED' },
    } } }),
  })
  let observed: { cwd: string | undefined; args: string[] } | undefined
  await assert.rejects(publish({
    config,
    stage: 'dev',
    registry: resolveRegistry({ config, stage: 'dev', region: 'us-east1', project: 'audit-test' }),
    tag: 'a'.repeat(40),
    log: () => {},
    run: async (file: string, args: string[], options?: RunOptions) => {
      if (file === 'corepack') {
        observed = { args, cwd: options?.cwd }
        return { code: 1, stdout: 'audit probe', stderr: '' }
      }
      assert.equal(file, 'gcloud', 'a failed audit must precede image commands')
      return { code: 0, stdout: args.includes('repositories') ? 'True' : '', stderr: '' }
    },
  }), AuditFailedError)
  assert.ok(observed, 'capture the audit invocation from real publication code')
  return observed
}

for (const code of [0, 1]) {
  test(`release preflight preserves publication audit arguments, output, and exit ${code}`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'boxlite-release-audit-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const calls = join(directory, 'calls')
    writeFileSync(join(directory, 'corepack'), `#!/bin/sh
printf '%s\\n' "$PWD" "$@" >> "$AUDIT_PROBE_CALLS"
echo 'audit stdout'
echo 'audit stderr' >&2
exit "$AUDIT_PROBE_EXIT"
`, { mode: 0o755 })
    const step = auditJob().steps.find((candidate: any) => candidate.run)
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', step.run], {
      cwd: root,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, AUDIT_PROBE_CALLS: calls, AUDIT_PROBE_EXIT: String(code) },
      encoding: 'utf8',
      timeout: 30_000,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status === 0, code === 0, result.stderr)
    assert.match(result.stdout, /audit stdout/)
    assert.match(result.stderr, /audit stderr/)
    const audit = await publicationAudit()
    assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), [audit.cwd, ...audit.args])
  })
}
