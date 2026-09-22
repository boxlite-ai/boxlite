// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { load as loadYaml } from 'js-yaml'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const workflow = (name = 'test.yml'): any => loadYaml(readFileSync(join(root, '.github/workflows', name), 'utf8'))
const picomatch = createRequire(import.meta.url)('picomatch') as (patterns: string[]) => (path: string) => boolean
const sdkSuites = ['rust', 'python', 'node', 'go']

function evaluate(expression: string, context: any): any {
  return runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replace(/\.([a-zA-Z_][\w]*-[\w-]+)/g, '["$1"]'), context, { timeout: 1000 })
}

function context(event: string, draft = false, selected = true) {
  const github = { event_name: event, event: { pull_request: { draft } }, ref: 'refs/pull/42/merge' }
  const filter = Object.fromEntries([...sdkSuites, 'api', 'setup', 'infra'].map((suite) => [suite, String(selected)]))
  const spec = workflow().jobs.changes.outputs
  const outputs = Object.fromEntries([...sdkSuites, 'api', 'setup'].map((suite) => [suite,
    String(evaluate(spec[suite], { github, steps: { filter: { outputs: filter } } }))]))
  outputs['sdk-tests-enabled'] = String(evaluate(spec['sdk-tests-enabled'] ?? 'true', { github }))
  outputs.infra = String(selected)
  return { github, needs: { changes: { result: 'success', outputs } } }
}

test('PR lifecycle triggers include becoming ready and returning to draft', () => {
  const types = workflow().on.pull_request.types ?? ['opened', 'synchronize', 'reopened']
  for (const action of ['opened', 'synchronize', 'reopened', 'ready_for_review', 'converted_to_draft']) {
    assert.ok(types.includes(action), `${action} must recalculate draft eligibility without another push`)
  }
})

for (const [event, draft, expected] of [
  ['pull_request', true, false], ['pull_request', false, true],
  ['push', false, true], ['merge_group', false, true],
  ['schedule', false, true], ['workflow_dispatch', false, true],
] as const) {
  test(`SDK jobs retain selection on ${event}, draft=${draft}`, () => {
    const jobs = workflow().jobs
    for (const suite of sdkSuites) {
      assert.equal(evaluate(jobs[suite].if, context(event, draft)), expected, suite)
      if (event !== 'schedule' && event !== 'workflow_dispatch') {
        assert.equal(evaluate(jobs[suite].if, context(event, draft, false)), false, `${suite}: unchanged files`)
      }
    }
  })
}

test('returning to draft cancels the same PR run instead of leaving the SDK matrix active', () => {
  const concurrency = workflow().concurrency
  const draft = context('pull_request', true)
  const ready = context('pull_request', false)
  const group = (ctx: any) => concurrency.group.replace(/\$\{\{\s*(.*?)\s*\}\}/g,
    (_match: string, expression: string) => String(evaluate(expression, ctx)))
  assert.equal(group(draft), group(ready))
  assert.equal(evaluate(concurrency['cancel-in-progress'], draft), true)
})

test('drafts retain formatting, lint and API checks', () => {
  const ctx = context('pull_request', true)
  Object.assign(ctx.needs.changes.outputs, { c: 'true', quality: 'true' })
  for (const job of ['rustfmt', 'clippy', 'python', 'node', 'c', 'go']) {
    assert.equal(evaluate(workflow('lint.yml').jobs[job].if, ctx), true, job)
  }
  assert.equal(evaluate(workflow().jobs.api.if, ctx), true)
})

test('workflow and infrastructure changes run hosted regressions even on drafts', () => {
  const spec = workflow()
  const infra = spec.jobs.infra
  assert.ok(infra, 'lightweight CI needs the infrastructure regression suite')
  assert.equal(evaluate(infra.if, context('pull_request', true)), true)
  assert.equal(evaluate(infra.if, context('pull_request', true, false)), false)
  assert.ok(infra.steps.some((step: any) => step.run === 'make test:apps:infra'))
  assert.ok(!infra.steps.some((step: any) => step.uses === './.github/actions/setup-infra'),
    'regressions need no Pulumi CLI, stage configuration, or deployment setup')
  const filter = spec.jobs.changes.steps.find((step: any) => step.uses?.startsWith('dorny/paths-filter'))
  const matches = picomatch((loadYaml(filter.with.filters) as any).infra)
  for (const path of ['apps/infra/deployment/draft-ci.test.ts', '.github/workflows/test.yml', '.github/actions/setup-go/action.yml', '.github/ci-config.json', 'Makefile', 'make/test.mk', 'make/changes.mk']) {
    assert.equal(matches(path), true, path)
  }
  for (const path of ['docs/README.md', '.github/workflows/README.md', 'sdks/go/options.go']) {
    assert.equal(matches(path), false, path)
  }
})

test('deferring SDK coverage never substitutes a no-coverage-changes upload', () => {
  const ctx = context('pull_request', true)
  ctx.needs.changes.outputs.api = 'false'
  for (const suite of sdkSuites) assert.equal(ctx.needs.changes.outputs[suite], 'true', suite)
  assert.equal(evaluate(workflow().jobs['coverage-empty'].if, ctx), false)
})

test('the required conclusion propagates infrastructure regression failures', () => {
  const conclusion = workflow().jobs['test-conclusion']
  assert.ok(conclusion.needs.includes('infra'), 'hosted regression failures must block the required conclusion')
  for (const result of ['success', 'skipped', 'failure', 'cancelled']) {
    const needs = Object.fromEntries(conclusion.needs.map((name: string) => [name, { result: name === 'infra' ? result : 'skipped' }]))
    const script = conclusion.steps[0].run.replaceAll('${{ toJSON(needs) }}', JSON.stringify(needs))
    const run = spawnSync('bash', ['-eo', 'pipefail', '-c', script], { encoding: 'utf8', timeout: 10_000 })
    assert.equal(run.error, undefined)
    assert.equal(run.status === 0, result === 'success' || result === 'skipped', run.stderr)
  }
})
