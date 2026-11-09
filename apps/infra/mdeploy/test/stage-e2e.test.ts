import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Lexer, Parser, Evaluator, data } from '@actions/expressions'
import { load } from 'js-yaml'

const workflow = load(
  readFileSync(new URL('../../../../.github/workflows/e2e-cloud.yml', import.meta.url), 'utf8'),
) as any
const steps = workflow.jobs.e2e.steps
const configure = steps.find((step: any) => step.name === 'Configure pytest profiles')
const identity = steps.find((step: any) => step.name === 'Run identity E2E (dev and stage)')
const sweep = steps.find((step: any) => step.name === 'Sweep stranded boxes')
const names = Object.keys(configure.env)

const evaluate = (expression: string, stage: string, sweepRequested = true): data.ExpressionData => {
  const contexts = new data.Dictionary(
    {
      key: 'inputs',
      value: new data.Dictionary(
        { key: 'stage', value: new data.StringData(stage) },
        { key: 'sweep', value: new data.BooleanData(sweepRequested) },
      ),
    },
    {
      key: 'secrets',
      value: new data.Dictionary(...names.map((name) => ({ key: name, value: new data.StringData(`secret-${name}`) }))),
    },
    { key: 'vars', value: new data.Dictionary() },
  )
  const tokens = new Lexer(expression.slice(3, -2)).lex().tokens
  return new Evaluator(new Parser(tokens, ['inputs', 'secrets', 'vars'], []).parse(), contexts).evaluate()
}

test('cloud E2E selects only the requested stage credentials and keeps prod narrow', () => {
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.stage.options, ['dev', 'stage', 'prod'])
  const healthIndex = steps.findIndex((step: any) => step.name === 'Probe API health')
  const targetIndex = steps.findIndex((step: any) => step.name === 'Validate cloud target')
  assert.ok(targetIndex < healthIndex && healthIndex < steps.indexOf(configure))
  assert.match(steps[targetIndex].run, /configure_cloud_profiles.py --target-only/)
  for (const stage of ['dev', 'stage', 'prod', 'typo']) {
    const selected = names.filter((name) => evaluate(configure.env[name], stage).coerceString() !== '')
    assert.deepEqual(
      selected,
      names.filter((name) => name.startsWith(`BOXLITE_${stage.toUpperCase()}_`)),
    )
    for (const name of selected) assert.equal(workflow.on.workflow_call.secrets[name].required, false)
    assert.equal(evaluate(identity.if, stage).coerceString(), String(['dev', 'stage'].includes(stage)))
    assert.equal(evaluate(sweep.if, stage).coerceString(), String(stage === 'dev'))
    assert.equal(evaluate(sweep.if, stage, false).coerceString(), 'false')
  }
  assert.equal(evaluate(workflow.jobs.e2e.env.BOXLITE_STAGE_API_URL, 'stage').coerceString(), '')
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  const suite = steps.find((step: any) => step.name === 'Run E2E suite')
  assert.match(suite.run, /if \[ "\$STAGE" = prod \]; then[\s\S]*-m smoke/)
})
