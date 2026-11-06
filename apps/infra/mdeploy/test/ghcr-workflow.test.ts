import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { load } from 'js-yaml'

const workflow = load(readFileSync(new URL('../../../../.github/workflows/mdeploy-all.yml', import.meta.url), 'utf8')) as any

for (const stage of ['dev', 'prod']) {
  for (const cloudPresent of [false, true]) {
    test(`${stage} refuses a missing GHCR release even when cloud images are ${cloudPresent ? 'present' : 'absent'}`, (t) => {
      const directory = mkdtempSync(join(tmpdir(), 'ghcr-plan-'))
      t.after(() => rmSync(directory, { recursive: true, force: true }))
      writeFileSync(join(directory, 'calls'), '')
      writeFileSync(join(directory, 'output'), '')
      writeFileSync(join(directory, 'summary'), '')
      writeFileSync(join(directory, 'npm'), `#!/bin/bash
echo "$*" >> "$PLAN_CALLS"
if [[ "$*" == *"--ghcr"* ]]; then exit 66; fi
exit ${cloudPresent ? 0 : 66}
`, { mode: 0o755 })
      const step = workflow.jobs.plan.steps.find((candidate: any) => candidate.id === 'plan')
      const result = spawnSync('bash', ['-c', step.run], {
        encoding: 'utf8', timeout: 10_000,
        env: {
          ...process.env, PATH: `${directory}:${process.env.PATH}`,
          PLAN_CALLS: join(directory, 'calls'), GITHUB_OUTPUT: join(directory, 'output'),
          RUNNER_TEMP: directory,
          GITHUB_STEP_SUMMARY: join(directory, 'summary'), GITHUB_REPOSITORY: 'boxlite-ai/boxlite',
          GHCR_REPOSITORY: 'boxlite-ai/boxlite', VERSION: 'v1.2.3', SHA: 'a'.repeat(40),
          IMAGE_TAG: `v1.2.3-${'a'.repeat(40)}`, LINE: 'release v1.2.3', STAGE: stage, COMPONENTS: 'api',
        },
      })
      assert.equal(result.status, 1, `missing GHCR images must stop planning:\n${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout + result.stderr, /mbuild-release\.yml/)
      const calls = readFileSync(join(directory, 'calls'), 'utf8')
      assert.match(calls, /mbuild verify .*--ghcr/)
      assert.doesNotMatch(calls, /publish|promote|workflow run/)
      assert.doesNotMatch(readFileSync(join(directory, 'output'), 'utf8'), /release-publish|release-promote|api=build/)
    })
  }
}

test('tag deployment imports before image verification and never calls the release builder', () => {
  assert.equal(Object.values<any>(workflow.jobs).some((job) => job.uses?.includes('mbuild-release.yml')), false)
  const steps = workflow.jobs.deploy.steps as any[]
  const imported = steps.findIndex((step) => /mbuild import-release/.test(step.run ?? ''))
  const verified = steps.findIndex((step) => step.name === 'Verify the images')
  const applied = steps.findIndex((step) => step.name === 'Apply')
  assert.ok(imported >= 0 && imported < verified && verified < applied)
  assert.doesNotMatch(steps[imported].run + steps[verified].run, /MSTAGE_ENV_CONFIG/,
    'import and verification must cover the artifacts the current deployment graph requires')
})

test('GCP imports and scans use the publisher, then restore the deployer before deployment checks', () => {
  const steps = workflow.jobs.deploy.steps as any[]
  const imported = steps.findIndex((step) => /mbuild import-release/.test(step.run ?? ''))
  const verified = steps.findIndex((step) => step.name === 'Verify the images')
  const isGcpAuth = (step: any) => /^google-github-actions\/auth@/.test(step.uses ?? '')
  const publisher = steps.slice(0, imported).filter(isGcpAuth).at(-1)
  assert.equal(publisher?.with.service_account, '${{ vars.GCP_IMAGE_PUBLISHER }}',
    'the deployer has registry reader access; import and scans need the existing publisher permissions')
  assert.match(publisher.if, /needs\.plan\.outputs\.api == 'release-import'/)
  assert.match(publisher.if, /steps\.config\.outputs\.kind == 'artifact-registry'/)
  const restored = steps.slice(imported + 1, verified).find(isGcpAuth)
  assert.equal(restored?.with.service_account, '${{ vars.GCP_DEPLOYER }}',
    'deployment checks and apply must recover the deployment identity')
  assert.equal(restored.if, publisher.if)
})
