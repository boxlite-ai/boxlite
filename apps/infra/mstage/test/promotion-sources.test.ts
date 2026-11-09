import assert from 'node:assert/strict'
import test from 'node:test'
import { parseStages } from '../src/config/load.ts'

const parse = (promoteFrom: unknown) =>
  parseStages(
    'stages.json',
    JSON.stringify({
      stages: {
        dev: { home: 'gcp', project: 'shared' },
        stage: { home: 'gcp', project: 'shared' },
        prod: { home: 'gcp', project: 'prod', promoteFrom },
      },
    }),
  )

test('production may declare both independent sources, preserving legacy strings', () => {
  assert.deepEqual(parse(['dev', 'stage']).prod!.promoteFrom, ['dev', 'stage'])
  assert.equal(parse('dev').prod!.promoteFrom, 'dev')
})

test('promotion declarations reject empty, duplicate, self and non-string sources', () => {
  for (const value of [[], ['dev', 'dev'], ['prod'], ['dev', ''], ['dev', 4], ['dev', 'bad name']]) {
    assert.throws(() => parse(value), /promote|non-empty/)
  }
})

test('promotion source lists validate each cloud while allowing partial CI declarations', () => {
  assert.deepEqual(
    parseStages(
      'partial.json',
      JSON.stringify({ stages: { prod: { home: 'gcp', project: 'p', promoteFrom: ['dev', 'stage'] } } }),
    ).prod!.promoteFrom,
    ['dev', 'stage'],
  )
  assert.throws(
    () =>
      parseStages(
        'mixed.json',
        JSON.stringify({
          stages: {
            dev: { home: 'gcp', project: 'p' },
            stage: { home: 'aws' },
            prod: { home: 'gcp', project: 'prod', promoteFrom: ['dev', 'stage'] },
          },
        }),
      ),
    /lives in aws/,
  )
})
