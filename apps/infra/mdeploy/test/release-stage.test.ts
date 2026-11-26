// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { DeployRequest } from '../src/deploy.ts'
import { updateRunners } from '../src/runner-update.ts'
import { run } from '../src/run.ts'

function stageFixture(t: TestContext, stageName = 'dev2') {
  const directory = mkdtempSync(join(tmpdir(), 'boxlite-qualified-release-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, '.mstage.config.json')
  const sample = JSON.parse(readFileSync(new URL('../../.mstage.config.example.json', import.meta.url), 'utf8'))
  const stage = { ...sample.stages.dev2, protect: true }
  stage.deploy.completeOutboundRelease = true
  writeFileSync(path, JSON.stringify({ ...sample, stages: { [stageName]: stage } }))
  return {
    argv: ['--stage', stageName, '--confirm'],
    environment: { MSTAGE_CONFIG: path },
    cwd: new URL('../..', import.meta.url).pathname,
    log: () => undefined,
  }
}

function workflowEnvironment(cwd: string, deployer: string) {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY: 'boxlite-ai/boxlite',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REF_PROTECTED: 'true',
    GITHUB_WORKFLOW_REF: 'boxlite-ai/boxlite/.github/workflows/mdeploy-all.yml@refs/heads/main',
    GITHUB_SHA: sha,
    GCP_DEPLOYER: deployer,
    BOXLITE_RELEASE_SHA: sha,
    BOXLITE_RELEASE_COMPONENTS: 'api+runner',
  }
}

test('qualified GCP stages refuse direct apply and runner writes before contacting a provider', async (t) => {
  const input = {
    ...stageFixture(t),
    checkLogin: async () => assert.fail('Reached sign-in before checking the release workflow'),
  }
  await assert.rejects(run(input), /Use the protected mdeploy-all workflow/)
  await assert.rejects(updateRunners(input), /Use the protected mdeploy-all workflow/)
})

test('dev cannot be configured as a global admission target', async (t) => {
  const input = stageFixture(t, 'dev')
  await assert.rejects(
    run({
      ...input,
      environment: {
        ...input.environment,
        ...workflowEnvironment(input.cwd, 'deploy@boxlite-test-project.iam.gserviceaccount.com'),
      },
      checkReleaseDeployer: async () => assert.fail('Reached release deployer verification for dev'),
    }),
    /Global complete outbound activation excludes dev/,
  )
})

test('the protected full-stage dispatch verifies the configured deployer before applying', async (t) => {
  const fixture = stageFixture(t)
  const deployer = 'deploy@boxlite-test-project.iam.gserviceaccount.com'
  const environment = { ...fixture.environment, ...workflowEnvironment(fixture.cwd, deployer) }
  const events: string[] = []
  const image = `us-docker.pkg.dev/boxlite-test-project/boxlite/api@sha256:${'a'.repeat(64)}`
  const input = {
    ...fixture,
    environment,
    checkLogin: async () => 0,
    checkReleaseDeployer: async (account: string | undefined) => {
      assert.equal(account, deployer)
      events.push('verify deployer')
    },
    runReleasePreDeploy: async () => {
      events.push('pre-deploy migrations')
      return image
    },
    verifyReleaseApi: async () => {
      events.push('verify serving API')
    },
    targetWith: async () => ({
      cloud: 'gcp' as const,
      engine: 'pulumi' as const,
      backend: {} as never,
      environmentGroups: () => [],
      async run(request: DeployRequest) {
        assert.equal(request.apiImage, image)
        events.push('apply')
        return 0
      },
    }),
    fetchEnv: async () => ({ source: 'test', values: { RUN_MIGRATIONS: 'false' } }),
  }
  assert.equal(await run(input), 0)
  for (const override of [
    { BOXLITE_RELEASE_COMPONENTS: 'runner' },
    { GITHUB_REF_PROTECTED: 'false' },
    { GITHUB_WORKFLOW_REF: 'boxlite-ai/boxlite/.github/workflows/other.yml@refs/heads/main' },
  ]) {
    await assert.rejects(
      run({ ...input, environment: { ...environment, ...override } }),
      /Use the protected mdeploy-all/,
    )
  }
  await assert.rejects(
    run({ ...input, environment: { ...environment, BOXLITE_RELEASE_SHA: 'b'.repeat(40) } }),
    /must be part of the protected workflow ref/,
  )
  await assert.rejects(
    run({
      ...input,
      async checkReleaseDeployer() {
        throw new Error('Unexpected release credentials')
      },
    }),
    /Unexpected release credentials/,
  )
  await assert.rejects(
    run({ ...input, fetchEnv: async () => ({ source: 'test', values: {} }) }),
    /requires RUN_MIGRATIONS=false/,
  )
  assert.deepEqual(events, [
    'verify deployer',
    'pre-deploy migrations',
    'apply',
    'verify serving API',
    'verify deployer',
  ])

  events.length = 0
  assert.equal(
    await run({
      ...input,
      async runReleasePreDeploy({ readCandidate }) {
        assert.ok(readCandidate?.().service.endsWith('-api'))
        events.push('verify first migrations')
        return image
      },
      async verifyReleaseApi() {
        events.push('verify first API')
      },
    }),
    0,
  )
  assert.deepEqual(events, ['verify deployer', 'verify first migrations', 'apply', 'verify first API'])
})
