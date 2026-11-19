import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { load } from 'js-yaml'
import { data, Evaluator, Lexer, Parser } from '@actions/expressions'

const action = (name: string): any =>
  load(readFileSync(new URL('../../../.github/actions/' + name + '/action.yml', import.meta.url), 'utf8'))

const enabled = (expression: string, name: string, outputs: Record<string, string>, files = '') => {
  const context = new data.Dictionary({
    key: 'steps',
    value: new data.Dictionary({
      key: name,
      value: new data.Dictionary({
        key: 'outputs',
        value: new data.Dictionary(
          ...Object.entries(outputs).map(([key, value]) => ({ key, value: new data.StringData(value) })),
        ),
      }),
    }),
  })
  const hashFiles = { name: 'hashFiles', minArgs: 1, maxArgs: 1, call: () => new data.StringData(files) }
  const ast = new Parser(new Lexer(expression).lex().tokens, ['steps'], [hashFiles]).parse()
  return new Evaluator(ast, context, new Map([['hashfiles', hashFiles]])).evaluate().coerceString() === 'true'
}

test('infra dependency caches finish saving before the caller can change its checkout', () => {
  const setup = action('setup-infra')
  const steps = setup.runs.steps
  const restore = steps.find((step: any) => step.id === 'modules')
  assert.equal(restore.uses, 'actions/cache/restore@v4', 'dependency restore must not register a job-end save')
  const install = steps.findIndex((step: any) => step.name === 'Install')
  const save = steps.findIndex(
    (step: any) => step.uses === 'actions/cache/save@v4' && step.with.path === restore.with.path,
  )
  assert.equal(steps[install].run, 'npm ci')
  assert.equal(save, install + 1, 'snapshot this installation before any later workspace changes')
  assert.equal(steps[save].with.key, '$' + '{{ steps.modules.outputs.cache-primary-key }}')
  assert.equal(steps[install].if, "steps.modules.outputs.cache-hit != 'true'")
  assert.equal(restore.with['restore-keys'], undefined)
  assert.match(restore.with.key, /^infra-modules-v2-/)
  for (const [hit, key, expected] of [
    ['true', 'recorded-key', false],
    ['false', 'recorded-key', true],
    ['', 'recorded-key', true],
    ['false', '', false],
  ]) {
    assert.equal(
      enabled(steps[save].if, 'modules', { 'cache-hit': String(hit), 'cache-primary-key': String(key) }),
      expected,
    )
  }
})
