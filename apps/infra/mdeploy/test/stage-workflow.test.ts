import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { load } from 'js-yaml'

const workflow = load(
  readFileSync(new URL('../../../../.github/workflows/mdeploy-all.yml', import.meta.url), 'utf8'),
) as any

test('stage accepts SHA candidates while prod keeps its existing release-only admission', () => {
  const script = workflow.jobs.resolve.steps.find((step: any) => step.id === 'classify').run
  const directory = mkdtempSync(join(tmpdir(), 'stage-admission-'))
  try {
    for (const [stage, ref, allowed] of [
      ['dev', '#123', true],
      ['stage', 'a'.repeat(40), true],
      ['stage', 'v1.2.3', true],
      ['stage', '#123', true],
      ['prod', 'a'.repeat(40), false],
      ['prod', '#123', false],
      ['prod', 'v1.2.3-rc.1', false],
      ['prod', 'v1.2.3', true],
    ] as const) {
      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          REF: ref,
          FALLBACK: 'b'.repeat(40),
          STAGE: stage,
          GITHUB_REF: 'refs/heads/main',
          GITHUB_OUTPUT: join(directory, 'output'),
          GITHUB_STEP_SUMMARY: join(directory, 'summary'),
        },
      })
      assert.equal(result.status === 0, allowed, `${stage}/${ref}: ${result.stdout}${result.stderr}`)
    }
    const gate = workflow.jobs.resolve.if
    assert.match(gate, /github.ref == 'refs\/heads\/main' \|\| inputs.stage == 'dev' \|\| inputs.stage == 'stage'/)
    assert.deepEqual(workflow.on.workflow_dispatch.inputs.source.options, ['dev', 'stage'])
    assert.equal(workflow.jobs['release-publish'].with.stage, '${{ inputs.stage }}')
    assert.equal(workflow.jobs['release-promote'].with.source, '${{ inputs.source }}')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
