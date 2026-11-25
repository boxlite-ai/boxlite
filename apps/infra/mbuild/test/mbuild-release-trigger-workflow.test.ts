import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

const directory = fileURLToPath(new URL('../../../../.github/workflows/', import.meta.url))

test('publishing a product release cannot dispatch a second build workflow', () => {
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.yml'))) {
    const workflow = load(readFileSync(join(directory, name), 'utf8')) as any
    assert.equal(workflow.on?.release, undefined, name + ' listens for product Release events')
    const producers = workflow.on?.workflow_run?.workflows ?? []
    assert.equal(producers.includes('Build C SDK'), false, name + ' starts a separate C consumer run')
  }
})
