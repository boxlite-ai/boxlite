import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { load } from 'js-yaml'
import { actionSource, actionSteps } from './workflow-source.js'

const workflow = load(
  readFileSync(new URL('../../../../.github/workflows/mdeploy-all.yml', import.meta.url), 'utf8'),
) as any

const approvedJobs = (stage: string, version: string) => {
  const inputs = { stage, apply: true, confirm: true }
  const github = { ref: 'refs/heads/main' }
  const needs = {
    resolve: { result: 'success', outputs: { version } },
    plan: {
      result: 'success',
    },
  }
  return Object.entries<any>(workflow.jobs)
    .filter(([, job]) => {
      if (!job.environment) return false
      const condition = job.if.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
      return new Function('inputs', 'github', 'needs', 'cancelled', 'failure', 'return (' + condition + ')')(
        inputs,
        github,
        needs,
        () => false,
        () => false,
      )
    })
    .map(([name]) => name)
}

test('commit deployments plan and build under one approval, then separately approve deployment', () => {
  for (const stage of ['dev', 'stage']) assert.deepEqual(approvedJobs(stage, ''), ['plan', 'deploy'])
})

test('published releases require one target Environment approval for verification, import and apply', () => {
  for (const stage of ['dev', 'prod']) assert.deepEqual(approvedJobs(stage, 'v0.13.1'), ['plan'])
})

test('apply notices precede each protected batch and never fall back to another stage secret', () => {
  const { resolve, plan, deploy, 'notify-deploy': second } = workflow.jobs
  const notices = resolve.steps.filter((step: any) => step.run?.endsWith('release-pipeline.mjs approval'))
  const devSecret = '${{ secrets.SLACK_DEV_DEPLOYMENT_WEBHOOK_URL }}'
  const prodSecret = '${{ secrets.SLACK_WEBHOOK_URL }}'
  assert.deepEqual(notices.map((step: any) => step.env.SLACK_WEBHOOK_URL), [devSecret, prodSecret])
  assert.deepEqual(resolve.steps.slice(-2), notices)
  for (const step of notices) assert.equal(step['continue-on-error'], true)
  assert.deepEqual(plan.needs, ['resolve'])
  assert.deepEqual(second.needs, ['resolve', 'plan'])
  assert.ok(deploy.needs.includes('notify-deploy'))
  assert.equal(second.environment, undefined)
  assert.equal(second.strategy, undefined)
  assert.equal(resolve.permissions.actions, 'read')
  assert.deepEqual(second.permissions, { contents: 'read', actions: 'read' })
  const send = second.steps.at(-1)
  for (const step of notices) assert.equal(send.run, step.run)
  assert.equal(send.env.SLACK_WEBHOOK_URL, devSecret)
  assert.equal(send.env.APPROVAL_PHASE, 'Commit deployment approval')
  const expr = (value: string) => value.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
  const batch = new Function('steps', 'return ' + expr(notices[0].env.APPROVAL_PHASE))
  assert.equal(notices[1].env.APPROVAL_PHASE, 'Release deployment approval')
  const next = new Function('inputs', 'needs', 'return ' + second.if)
  for (const stage of ['dev', 'prod', 'stage']) {
    for (const apply of [false, true]) {
      const selected = notices.filter((step: any) => new Function('inputs', 'return ' + step.if)({ stage, apply }))
      const expected = apply && stage !== 'stage' ? [stage === 'dev' ? devSecret : prodSecret] : []
      assert.deepEqual(selected.map((step: any) => step.env.SLACK_WEBHOOK_URL), expected)
      for (const version of ['', 'v1.2.3']) {
        const needs = { resolve: { outputs: { version } }, plan: { result: 'success' } }
        assert.equal(next({ stage, apply }, needs), stage === 'dev' && apply && !version)
      }
    }
  }
  for (const version of ['', 'v1.2.3']) {
    const phase = batch({ classify: { outputs: { version } } })
    assert.equal(phase, version ? 'Release deployment approval' : 'Commit preparation approval')
  }
  for (const result of ['failure', 'cancelled', 'skipped']) {
    const needs = { resolve: { outputs: { version: '' } }, plan: { result } }
    assert.equal(next({ stage: 'dev', apply: true }, needs), false)
  }
  assert.equal(second['continue-on-error'], true)
  const applyJob = new Function('inputs', 'github', 'needs', 'cancelled', 'return (' + expr(deploy.if) + ')')
  for (const result of ['failure', 'skipped', 'success']) {
    const needs = {
      resolve: { result: 'success', outputs: { version: '' } },
      plan: { result: 'success' },
      'notify-deploy': { result },
    }
    assert.equal(applyJob({ stage: 'dev' }, { ref: 'refs/heads/main' }, needs, () => false), true)
  }
})

test('shared operations declare every input they read and preserve the original requested ref', () => {
  for (const name of ['mbuild', 'mdeploy', 'build-staged-runner']) {
    const source = actionSource(name)
    const action = load(source) as any
    for (const match of source.matchAll(/\binputs\.([A-Za-z0-9_-]+)/g)) {
      assert.ok(Object.hasOwn(action.inputs, match[1]!), name + ': undeclared input ' + match[1])
    }
  }
  for (const name of ['plan', 'deploy']) {
    const action = workflow.jobs[name].steps.find((step: any) => step.uses === './.github/actions/mdeploy')
    assert.equal(action.with.ref, '$' + '{{ inputs.ref }}')
  }
})

test('failure and cancellation prevent the separate commit apply job', () => {
  const expression = workflow.jobs.deploy.if.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
  const evaluate = new Function('inputs', 'github', 'needs', 'cancelled', 'failure', 'return (' + expression + ')')
  for (const [cancelled, failed] of [
    [true, false],
    [false, true],
  ]) {
    assert.equal(
      evaluate(
        { stage: 'dev' },
        { ref: 'refs/heads/main' },
        { resolve: { outputs: { version: '' } } },
        () => cancelled,
        () => failed,
      ),
      false,
    )
  }
  const release = workflow.jobs.plan.steps.find((step: any) => step.uses === './.github/actions/mdeploy')
  assert.equal(release.if, "needs.resolve.outputs.version != ''")
  assert.equal(release['continue-on-error'], undefined)
  for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
    assert.equal(evaluate(
      { stage: 'dev' },
      { ref: 'refs/heads/main' },
      { resolve: { result: 'success', outputs: { version: '' } }, plan: { result } },
      () => result === 'cancelled',
      () => result === 'failure',
    ), result === 'success', `preparation ${result}`)
  }
})

test('composite boolean strings preserve preview and protected confirmation arguments', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mdeploy-apply-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const calls = join(directory, 'calls')
  writeFileSync(join(directory, 'npm'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$APPLY_CALLS"\n', { mode: 0o755 })
  const script = actionSteps('mdeploy').find((step) => step.name === 'Apply').run
  const stage = workflow.on.workflow_dispatch.inputs.stage.options[0]
  const components = workflow.on.workflow_dispatch.inputs.components.default
  for (const apply of ['true', 'false']) {
    for (const confirm of ['true', 'false']) {
      writeFileSync(calls, '')
      const inputs = { stage, apply, confirm }
      const rendered = script.replace(/\$\{\{([^}]+)\}\}/g, (_: string, expression: string) =>
        new Function('inputs', 'return (' + expression + ')')(inputs),
      )
      const result = spawnSync('bash', ['-c', rendered], {
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, PATH: directory + ':' + process.env.PATH, APPLY_CALLS: calls, COMPONENTS: components },
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(
        readFileSync(calls, 'utf8').trim(),
        'run mdeploy -- --stage ' + stage + ' --components ' + components +
          (apply === 'false' ? ' --diff' : confirm === 'true' ? ' --confirm' : ''),
      )
    }
  }
})

test('image input validation rejects environment-file injection before writing identity', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mbuild-input-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const output = join(directory, 'environment')
  const script = actionSteps('mbuild').find((step) => step.name === 'Address the commit the caller resolved').run
  const stage = workflow.on.workflow_dispatch.inputs.stage.options[0]
  for (const target of [stage, stage + '\nINJECTED=true']) {
    writeFileSync(output, '')
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, TAG: 'a'.repeat(40), TARGET_STAGE: target, GITHUB_ENV: output },
    })
    assert.equal(result.status, target === stage ? 0 : 1, result.stderr)
    assert.equal(
      readFileSync(output, 'utf8'),
      target === stage ? 'IMAGE_TAG=' + 'a'.repeat(40) + '\nTARGET_STAGE=' + stage + '\n' : '',
    )
  }
})
