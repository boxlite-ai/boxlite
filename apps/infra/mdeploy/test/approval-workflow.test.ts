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
      outputs: { api: version ? 'release-import' : 'build', runner: version ? 'skip' : 'build' },
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
  assert.equal(workflow.jobs.plan.concurrency.group, 'mbuild-publish-' + '$' + '{{ inputs.stage }}')
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
})

test('orchestration sources are restored between image checkout and the next local action', () => {
  const steps = workflow.jobs.plan.steps
  const image = steps.findIndex((step: any) => step.uses === './.github/actions/mbuild')
  const restore = steps.findIndex((step: any) => step.name === 'Restore orchestration sources')
  const runner = steps.findIndex((step: any) => step.uses === './.github/actions/build-staged-runner')
  assert.ok(image >= 0 && image < restore && restore < runner)
  assert.equal(steps[restore].if, steps[image].if)
  assert.equal(steps[restore].with.ref, '$' + '{{ github.sha }}')
  assert.equal(steps[runner].with.sha, '$' + '{{ needs.resolve.outputs.sha }}')
  assert.equal(steps[runner].with.stage, '$' + '{{ inputs.stage }}')
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
