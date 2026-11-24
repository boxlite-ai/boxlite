import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { load } from 'js-yaml'

const readWorkflow = (name) =>
  load(readFileSync(new URL('../../../.github/workflows/' + name + '.yml', import.meta.url), 'utf8'))
const release = readWorkflow('mbuild-release')
const rollout = readWorkflow('mdeploy-all')

test('release deployment is a native dependency in the publisher run', () => {
  const calls = Object.values(release.jobs).filter((job) => job.uses === './.github/workflows/mdeploy-all.yml')
  assert.deepEqual(
    calls.map((job) => job.with.stage).sort(),
    ['dev', 'prod'],
    'release dispatches deployment outside its workflow run',
  )
  assert.ok(release.jobs.dev.needs.includes('check'))
  assert.ok(release.jobs.prod.needs.includes('dev'))
  assert.equal(rollout.jobs.e2e.uses, './.github/workflows/e2e-cloud.yml')
  assert.ok(rollout.jobs.e2e.needs.includes('plan'))
  assert.equal(rollout.jobs.report, undefined, 'successful acceptance must not allocate a report runner')
})

test('release dev approval uses only the release webhook', () => {
  const inputs = { stage: 'dev', apply: true, release_sha: 'a'.repeat(40) }
  const notices = rollout.jobs.resolve.steps.filter((s) => s.run?.endsWith('release-pipeline.mjs approval'))
  const selected = notices.filter((s) => new Function('inputs', 'return ' + s.if)(inputs))
  assert.deepEqual(
    selected.map((s) => s.env.SLACK_WEBHOOK_URL),
    ['$' + '{{ secrets.SLACK_WEBHOOK_URL }}'],
  )
})

const expression = (value) => value.replace(/^\$\{\{\s*|\s*\}\}$/g, '')

test('standalone and release applies choose exactly one channel, including an unset release webhook', () => {
  const job = rollout.jobs.result
  const steps = job.steps.filter((step) => step.run?.endsWith('release-pipeline.mjs result'))
  for (const step of steps) {
    assert.match(
      expression(step.env.SLACK_WEBHOOK_URL),
      /^secrets\.(SLACK_WEBHOOK_URL|SLACK_DEV_DEPLOYMENT_WEBHOOK_URL)$/,
      'each result step must read one named secret',
    )
  }
  const channel = (inputs, secrets) => {
    const selected = steps.filter((step) => new Function('inputs', 'return ' + expression(step.if))(inputs))
    assert.equal(selected.length, 1)
    return new Function('secrets', 'return ' + expression(selected[0].env.SLACK_WEBHOOK_URL))(secrets)
  }
  const secrets = { SLACK_WEBHOOK_URL: 'release', SLACK_DEV_DEPLOYMENT_WEBHOOK_URL: 'dev' }
  for (const [stage, sha, expected] of [
    ['dev', '', 'dev'],
    ['stage', '', 'dev'],
    ['prod', '', 'release'],
    ['dev', 'sha', 'release'],
    ['prod', 'sha', 'release'],
  ]) {
    assert.equal(channel({ stage, release_sha: sha }, secrets), expected)
  }
  assert.equal(channel({ stage: 'dev', release_sha: 'sha' }, { ...secrets, SLACK_WEBHOOK_URL: '' }), '')
  assert.match(rollout.jobs.result.if, /inputs\.apply/)
  assert.equal(release.jobs.dev.secrets.SLACK_DEV_DEPLOYMENT_WEBHOOK_URL, undefined)
  const outcome = new Function('needs', 'return ' + expression(job.env.DEPLOY_RESULT))
  for (const [version, plan, deploy, expected] of [
    ['v1.2.3', 'success', 'skipped', 'success'],
    ['', 'success', 'failure', 'failure'],
    ['', 'success', 'success', 'success'],
    ['v1.2.3', 'failure', 'skipped', 'failure'],
  ]) {
    assert.equal(
      outcome({
        resolve: { result: 'success', outputs: { version } },
        plan: { result: plan },
        deploy: { result: deploy },
      }),
      expected,
    )
  }
})

test('release admission checks caller, tag, reviewers and deployment attempt before production', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'release-call-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\nprintf "%s\\n" "$REVIEWERS"\nexit "${GH_EXIT:-0}"\n', { mode: 0o755 })
  const guard = rollout.jobs.resolve.steps.find((step) => step.name === 'Validate release caller and published commit')
  const repo = 'boxlite-ai/boxlite'
  const base = {
    PATH: dir + ':' + process.env.PATH,
    GITHUB_REPOSITORY: repo,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: repo + '/.github/workflows/mbuild-release.yml@refs/heads/main',
    RESOLVED: 'a'.repeat(40),
    RELEASE_SHA: 'a'.repeat(40),
    VERSION: 'v1.2.3',
    STAGE: 'prod',
    ACCEPTED_ATTEMPT: '2',
    GITHUB_RUN_ATTEMPT: '2',
    REVIEWERS: JSON.stringify({ protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User' }] }] }),
  }
  const run = (script, extra) => spawnSync('bash', ['-c', script], { env: { ...base, ...extra } }).status
  assert.equal(run(guard.run, {}), 0)
  for (const overrides of [
    { GITHUB_WORKFLOW_REF: 'unexpected' },
    { RESOLVED: 'b'.repeat(40) },
    { VERSION: '' },
    { STAGE: 'stage' },
    { ACCEPTED_ATTEMPT: '1' },
    { REVIEWERS: '{"protection_rules":[]}' },
    { GH_EXIT: '1' },
  ])
    assert.notEqual(run(guard.run, overrides), 0)
  assert.equal(run(guard.run, { STAGE: 'dev', ACCEPTED_ATTEMPT: '', GH_EXIT: '1' }), 0)
  const applyGuard = rollout.jobs.plan.steps.find((step) => step.name === 'Require acceptance from this attempt')
  assert.notEqual(run(applyGuard.run, { ACCEPTED_ATTEMPT: '1' }), 0)
  const cloud = readWorkflow('e2e-cloud')
  const e2eGuard = cloud.jobs.e2e.steps.find((step) => step.env?.DEPLOYMENT_ATTEMPT)
  for (const [attempt, sha, expected] of [
    ['2', base.RELEASE_SHA, 0],
    ['1', base.RELEASE_SHA, 1],
    ['2', 'b'.repeat(40), 1],
  ]) {
    assert.equal(
      run(e2eGuard.run, {
        DEPLOYMENT_ATTEMPT: attempt,
        REVIEWERS: sha,
        RELEASE_TAG: base.VERSION,
        GITHUB_OUTPUT: join(dir, 'outputs'),
      }),
      expected,
    )
  }
  const checkout = cloud.jobs.e2e.steps.find((step) => step.with?.path === 'target/e2e-release')
  assert.equal(
    checkout.with.ref,
    '${{ steps.release_commit.outputs.sha }}',
    'release SDK checkout must use the verified commit',
  )
  const outputs = join(dir, 'standalone-outputs')
  const standalone = { DEPLOYMENT_ATTEMPT: '', RELEASE_SHA: '', RELEASE_TAG: base.VERSION, GITHUB_OUTPUT: outputs }
  assert.notEqual(run(e2eGuard.run, { ...standalone, REVIEWERS: base.VERSION }), 0)
  assert.equal(run(e2eGuard.run, { ...standalone, REVIEWERS: base.RELEASE_SHA }), 0)
  assert.equal(readFileSync(outputs, 'utf8'), 'sha=' + base.RELEASE_SHA + '\n')
})

test('build-only never enters deployment, checks, or reporting; failed E2E cannot stamp acceptance', () => {
  for (const id of ['check', 'dev', 'prod', 'report']) assert.match(release.jobs[id].if, /!inputs\['build-only'\]/)
  assert.equal(rollout.concurrency.group, 'mdeploy-all-${{ inputs.stage }}')
  assert.notEqual(release.concurrency.group, rollout.concurrency.group)
  const outputs = rollout.on.workflow_call.outputs
  const stamp = new Function('jobs', 'return ' + expression(outputs.accepted_attempt.value))
  for (const result of ['failure', 'cancelled', 'skipped', 'success']) {
    assert.equal(
      stamp({
        plan: { result: 'success', outputs: { deployment_attempt: '2' } },
        e2e: { outputs: { release_result: result } },
      }),
      result === 'success' ? '2' : '',
    )
  }
  assert.equal(outputs.e2e_result.value, '${{ jobs.e2e.outputs.release_result }}')
  const cloud = readWorkflow('e2e-cloud')
  assert.equal(cloud.on.workflow_call.outputs.release_result.value, '${{ jobs.e2e.outputs.release_result }}')
  assert.equal(cloud.jobs.e2e.outputs.release_result, '${{ steps.acceptance.outputs.result }}')
  const summary = cloud.jobs.e2e.steps.at(-1)
  assert.equal(summary.id, 'acceptance')
  assert.equal(summary.if, 'always() && inputs.deployment_attempt')
  assert.equal(summary.env.E2E_RESULT, '${{ job.status }}')
  const fallback = new Function('github', 'inputs', 'needs', 'always', 'return ' + expression(release.jobs.report.if))
  for (const result of ['failure', 'cancelled', 'skipped', 'success'])
    assert.equal(
      fallback({ ref: 'refs/heads/main' }, { 'build-only': false }, { dev: { result } }, () => true),
      result !== 'success',
    )
  assert.match(release.jobs.prod.if, /needs\.dev\.outputs\.accepted_attempt != ''/)
})

test('only a prod approval after dev acceptance carries the E2E success', () => {
  const notice = rollout.jobs.resolve.steps.find((step) => step.name === 'Notify release reviewers')
  assert.ok(notice.env.ACCEPTED_TAG, 'prod approval must include the accepted tag')
  const accepted = new Function('inputs', 'return ' + expression(notice.env.ACCEPTED_TAG))
  for (const [stage, attempt, expected] of [
    ['dev', '', ''],
    ['prod', '', ''],
    ['prod', '2', 'v1.2.3'],
  ]) {
    assert.equal(accepted({ stage, accepted_attempt: attempt, ref: 'v1.2.3' }), expected)
  }
})

test('the cloud suite cannot write the default branch cache', () => {
  const cloud = readWorkflow('e2e-cloud')
  assert.ok(
    ['read', 'none'].includes(cloud.jobs.e2e['cache-mode'] || cloud['cache-mode']),
    'E2E needs a read-only cache',
  )
})
