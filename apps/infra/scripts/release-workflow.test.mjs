import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
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
  const checkout = cloud.jobs.e2e.steps.find(
    (step) => step.name === 'Checkout release SDK sources for subdomain clients',
  )
  assert.equal(
    checkout.env?.RELEASE_SDK_SHA,
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
  assert.match(release.jobs.report.if, /contains\(needs\.\*\.result, 'failure'\)/)
  assert.match(release.jobs.report.if, /contains\(needs\.\*\.result, 'cancelled'\)/)
  for (const job of ['dev','attach','finalize','pypi','npm','publish_crates']) assert.ok(release.jobs.report.needs.includes(job))
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

test('release SDK worktree uses the verified commit even when the remote has advanced', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-sdk-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q', 'source')
  const commit = (text) =>
    git(
      '-C',
      'source',
      '-c',
      'user.name=Test',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      text,
    )
  commit('published')
  const sha = git('-C', 'source', 'rev-parse', 'HEAD')
  commit('later change')
  git('init', '-q', 'suite')
  const step = readWorkflow('e2e-cloud').jobs.e2e.steps.find(
    (s) => s.name === 'Checkout release SDK sources for subdomain clients',
  )
  assert.ok(step.run, 'the suite should share its Git object store with the release SDK worktree')
  const run = (ref) =>
    spawnSync('bash', ['-c', step.run], {
      cwd: join(dir, 'suite'),
      encoding: 'utf8',
      env: {
        ...process.env,
        RELEASE_SDK_SHA: ref,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'url.file://' + join(dir, 'source') + '.insteadOf',
        GIT_CONFIG_VALUE_0: 'https://github.com/boxlite-ai/boxlite.git',
      },
    })
  const missing = run('0'.repeat(40))
  assert.notEqual(missing.status, 0)
  const result = run(sha)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(git('-C', 'suite/target/e2e-release', 'rev-parse', 'HEAD'), sha)
  const common = (path) => git('-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  assert.equal(common('suite/target/e2e-release'), common('suite'))
})

test('component repairs use the accepted candidate and package publishers stay in the entry workflow', () => {
  const commands = release.on.workflow_dispatch.inputs.command.options
  assert.deepEqual(commands, ['publish', 'repair-runtime', 'repair-wheels', 'repair-node', 'repair-c'])
  const locate = release.jobs['accepted-candidate']
  const receipt = locate.steps.find((step) => step.id === 'receipt').run
  assert.match(receipt, /head_branch == "main"/)
  assert.match(receipt, /dev-accepted-\$ID/)
  assert.match(receipt, /\.candidate == \$id and \.run == \$run/)
  const attach = release.jobs.attach
  assert.ok(attach.needs.includes('accepted-candidate'))
  for (const [job, command] of [['npm','repair-node'],['pypi','repair-wheels']]) {
    const publisher=release.jobs[job]
    assert.ok(publisher.needs.includes('attach'))
    assert.equal(publisher.permissions['id-token'],'write')
    assert.ok(publisher.if.includes(command))
    const input=publisher.steps.find((step)=>step.uses==='./.github/actions/release-candidate').with
    assert.equal(input.run,'${{ needs.attach.outputs.run }}')
    assert.equal(input.id,'${{ needs.attach.outputs.candidate }}')
    assert.equal(input.digest,'${{ needs.attach.outputs.digest }}')
  }
  assert.ok(release.jobs.publish_crates.needs.includes('finalize'))
  assert.ok(release.jobs.finalize.if.includes("inputs.command == 'publish'"))
})
