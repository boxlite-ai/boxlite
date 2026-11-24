import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { data, Evaluator, Lexer, Parser } from '@actions/expressions'
import { load } from 'js-yaml'

const workflow = load(readFileSync(new URL('../../../../.github/workflows/mdeploy-all.yml', import.meta.url), 'utf8')) as any
const publisher = load(readFileSync(new URL('../../../../.github/workflows/mbuild.yml', import.meta.url), 'utf8')) as any
const dictionary = (values: Record<string, any>): data.Dictionary => new data.Dictionary(
  ...Object.entries(values).map(([key, value]) => ({
    key, value: typeof value === 'object' ? dictionary(value) : new data.StringData(String(value)),
  })),
)
const evaluate = (expression: string, context: Record<string, any>) => new Evaluator(
  new Parser(new Lexer(expression).lex().tokens, Object.keys(context), []).parse(), dictionary(context),
).evaluate().coerceString()
const render = (template: string, context: Record<string, any>) => template.replace(
  /\$\{\{([^}]+)\}\}/g, (_match, expression) => evaluate(expression, context),
)

test('requested commit artifacts occupy independent preparation jobs and locks; releases use one non-building leg', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'parallel-preparation-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(join(directory, 'npm'), `#!/bin/bash
case "$*" in
  *"mbuild verify"*) [ -n "$VERSION" ] && exit 0; exit 66 ;;
  *"runner:build"*) echo staged=absent ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 })
  const output = join(directory, 'output')
  const run = (script: string, env: Record<string, string>) => {
    writeFileSync(output, '')
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8', timeout: 10_000,
      env: { PATH: `${directory}:${process.env.PATH}`, GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: join(directory, 'summary'), GITHUB_REPOSITORY: 'example/fixture',
        GHCR_REPOSITORY: 'example/fixture', STAGE: 'dev', LINE: 'fixture', ...env },
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map((line) => {
      const separator = line.indexOf('=')
      return [line.slice(0, separator), line.slice(separator + 1)]
    }))
  }
  const address = workflow.jobs.resolve.steps.find((step: any) => step.id === 'tag')
  const plan = workflow.jobs.plan
  const decide = plan.steps.find((step: any) => step.id === 'plan')
  const publisherLock = render(publisher.concurrency.group, { inputs: { command: 'publish', stage: 'dev', to: '' } })
  for (const version of ['', 'v1.2.3']) {
    for (const components of workflow.on.workflow_dispatch.inputs.components.options) {
      const resolved = run(address.run, { VERSION: version, RESOLVED: 'a'.repeat(40), MERGED: '', COMPONENTS: components })
      // A job without a strategy has exactly one execution.
      const legs = plan.strategy ? JSON.parse(resolved.prepare_components) : ['single']
      const builds: { component: string; job: number; lock: string }[] = []
      for (const [job, component] of legs.entries()) {
        const context = { inputs: { components, stage: 'dev' }, matrix: { component } }
        if (component !== 'runner') assert.equal(render(plan.concurrency.group, context), publisherLock)
        const outputs = run(decide.run, { VERSION: version, SHA: resolved.sha, IMAGE_TAG: resolved.image,
          COMPONENTS: render(decide.env.COMPONENTS, context) })
        for (const [artifact, action] of [['api', 'mbuild'], ['runner', 'build-staged-runner']]) {
          const step = plan.steps.find((candidate: any) => candidate.uses === './.github/actions/' + action)
          if (evaluate(step.if, { steps: { plan: { outputs } } }) === 'true') {
            builds.push({ component: artifact!, job, lock: render(plan.concurrency.group, context) })
          }
        }
      }
      assert.deepEqual(builds.map((build) => build.component).sort(), version ? [] : components.split('+').sort())
      if (!version && components === 'api+runner') {
        assert.notEqual(builds[0]!.job, builds[1]!.job, 'images and Runner share one job and must execute serially')
        assert.notEqual(builds[0]!.lock, builds[1]!.lock, 'a shared concurrency key serializes the matrix')
        assert.ok(plan.strategy['max-parallel'] >= legs.length, 'all preparation legs must be eligible together')
        assert.equal(plan.strategy['fail-fast'], false, 'one failed artifact must not cancel its sibling')
      }
      assert.deepEqual(legs, version ? ['release'] : components.split('+'))
    }
  }
  assert.equal(plan.strategy.matrix.component, '${{ fromJSON(needs.resolve.outputs.prepare_components) }}')
  assert.equal(workflow.jobs.resolve.outputs.prepare_components, '${{ steps.tag.outputs.prepare_components }}')
  assert.deepEqual(plan.outputs, { deployment_attempt: '${{ steps.applied.outputs.attempt }}' })
  assert.equal(plan.steps.find((s: any) => s.id === 'applied').if, "inputs.release_sha && inputs.stage == 'dev'")
  assert.equal(workflow.jobs.deploy.steps.find((step: any) => step.uses === './.github/actions/mdeploy').with['api-route'], 'skip')
  assert.deepEqual(workflow.jobs.deploy.needs, ['resolve', 'plan', 'notify-deploy'])
})
