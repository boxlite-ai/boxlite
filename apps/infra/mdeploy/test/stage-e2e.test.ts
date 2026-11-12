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

const evaluate = (
  expression: string,
  stage: string,
  sweepRequested = true,
  variables: Record<string, string> = {},
  apiUrl = '',
): data.ExpressionData => {
  const contexts = new data.Dictionary(
    {
      key: 'inputs',
      value: new data.Dictionary(
        { key: 'stage', value: new data.StringData(stage) },
        { key: 'sweep', value: new data.BooleanData(sweepRequested) },
        { key: 'api_url', value: new data.StringData(apiUrl) },
      ),
    },
    {
      key: 'secrets',
      value: new data.Dictionary(...names.map((name) => ({ key: name, value: new data.StringData(`secret-${name}`) }))),
    },
    {
      key: 'vars',
      value: new data.Dictionary(
        ...Object.entries(variables).map(([key, value]) => ({ key, value: new data.StringData(value) })),
      ),
    },
  )
  const tokens = new Lexer(expression.slice(3, -2)).lex().tokens
  return new Evaluator(new Parser(tokens, ['inputs', 'secrets', 'vars'], []).parse(), contexts).evaluate()
}

test('cloud E2E selects only the requested stage credentials and keeps prod narrow', () => {
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.stage.options, ['dev', 'stage', 'prod'])
  const healthIndex = steps.findIndex((step: any) => step.name === 'Probe API health')
  assert.ok(healthIndex >= 0 && healthIndex < steps.indexOf(configure))
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
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  const suite = steps.find((step: any) => step.name === 'Run E2E suite')
  assert.match(suite.run, /if \[ "\$STAGE" = prod \]; then[\s\S]*-m smoke/)
})

test('stage uses the same URL override, variable and default precedence as dev', () => {
  for (const [stage, fallback] of [
    ['dev', 'https://api.dev.boxlite.ai'],
    ['stage', 'https://api.stage.boxlite.ai'],
    ['prod', 'https://api.boxlite.ai'],
  ]) {
    const expression = workflow.jobs.e2e.env.API_URL
    const variables = { [`BOXLITE_${stage.toUpperCase()}_API_URL`]: 'https://configured.example.test' }
    assert.equal(evaluate(expression, stage).coerceString(), fallback)
    assert.equal(
      evaluate(expression, stage, true, variables).coerceString(),
      variables[`BOXLITE_${stage.toUpperCase()}_API_URL`],
    )
    assert.equal(
      evaluate(expression, stage, true, variables, 'https://override.example.test').coerceString(),
      'https://override.example.test',
    )
  }
})
