// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { load } from 'js-yaml'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const workflow: any = load(readFileSync(join(root, '.github/workflows/e2e-local.yml'), 'utf8'))
const start = workflow.jobs['start-runner']
const wait = start.steps.find((step: any) => step.name === 'Wait for runner to come online')
const clear = start.steps.find((step: any) => step.run === 'scripts/ci/gcp-e2e-vm.sh clear-token')
const stop = workflow.jobs['stop-runner'].steps.find((step: any) => step.name === 'Stop the VM')

test('selected VM identity reaches token cleanup, routing, and stop', () => {
  assert.equal(start.steps.find((step: any) => step.id === 'start').run, 'scripts/ci/gcp-e2e-vm.sh start-pool')
  for (const key of ['instance', 'zone']) {
    const selected = `\${{ steps.start.outputs.${key} }}`
    assert.equal(start.outputs[key], selected)
    assert.equal(clear.env[`GCP_${key.toUpperCase()}`], selected)
    assert.equal(stop.env[`GCP_${key.toUpperCase()}`], `\${{ needs.start-runner.outputs.${key} }}`)
  }
  assert.equal(wait.env.SELECTED_INSTANCE, '${{ steps.start.outputs.instance }}')
  assert.deepEqual(workflow.jobs['e2e-tests']['runs-on'], [
    'self-hosted', 'gcp-e2e', '${{ needs.start-runner.outputs.instance }}',
  ])
  assert.match(clear.if, /always\(\)/)
  assert.match(clear.if, /steps\.start\.outputs\.instance != ''/)
  assert.equal(workflow.concurrency['cancel-in-progress'], false)
})

for (const selectedOnline of [true, false]) {
  test(`readiness follows the selected runner: online=${selectedOnline}`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'e2e-pool-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    writeFileSync(join(directory, 'curl'), '#!/bin/bash\nprintf "%s\\n" "$RUNNERS"\n', { mode: 0o755 })
    writeFileSync(join(directory, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
    const result = spawnSync('bash', ['-e', '-c', wait.run.replace(/\$\{\{[^}]+\}\}/g, 'fixture')], {
      encoding: 'utf8', timeout: 5000,
      env: {
        ...process.env, PATH: `${directory}:${process.env.PATH}`, SELECTED_INSTANCE: 'ci-gha-e2e-2',
        RUNNERS: JSON.stringify({ runners: [
          { name: 'ci-gha-e2e-1', status: 'online', labels: [{ name: 'gcp-e2e' }] },
          { name: 'ci-gha-e2e-2', status: selectedOnline ? 'online' : 'offline', labels: [{ name: 'gcp-e2e' }] },
        ] }),
      },
    })
    assert.equal(result.status, selectedOnline ? 0 : 1, result.stdout + result.stderr)
  })
}
