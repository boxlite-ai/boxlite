import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { load } from 'js-yaml'

const source = readFileSync(new URL('../../../../.github/workflows/mbuild-release.yml', import.meta.url), 'utf8')
const workflow = load(source) as any
const commands = source.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')

test('release publication runs from main with package write access and no cloud environment', () => {
  for (const [name, job] of Object.entries<any>(workflow.jobs)) {
    assert.match(job.if, /github\.ref == 'refs\/heads\/main'/, name)
    assert.equal(job.environment, undefined)
  }
  assert.equal(workflow.jobs.publish.permissions.packages, 'write')
  assert.equal(workflow.permissions['id-token'], undefined)
  assert.doesNotMatch(commands, /configure-aws-credentials|google-github-actions|mstage login|--stage dev|--to prod/)
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.command.options, ['publish'])
  assert.equal(workflow.on.workflow_call, undefined)
})

test('the tag must exist and resolve to a commit on main before any package is published', () => {
  const resolve = workflow.jobs.resolve
  const validation = resolve.steps.find((step: any) => step.id === 'version')
  assert.match(validation.run, /looks like a commit/)
  assert.match(validation.run, /refs\/tags\/\$\{TAG\}/)
  assert.match(validation.run, /git rev-parse --verify --quiet/)
  const ref = resolve.steps.find((step: any) => step.id === 'ref')
  assert.equal(ref.with.ref, '${{ steps.version.outputs.ref }}')
  assert.equal(ref.with.branch, '${{ github.ref_name }}')
  assert.ok(workflow.jobs.publish.needs.includes('resolve'))
})

test('release validation accepts stable tags and rejects leading zeros and prereleases', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'release-tag-validation-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  // Every queried ref exists, so only the production version check can reject a tag.
  writeFileSync(join(directory, 'git'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
  const validation = workflow.jobs.resolve.steps.find((step: any) => step.id === 'version')
  for (const [tag, status] of [['v1.2.3', 0], ['v0.0.0', 0], ['v01.2.3', 1], ['v1.02.3', 1], ['v1.2.03', 1], ['v1.2.3-rc.1', 1]] as const) {
    const output = join(directory, 'output')
    writeFileSync(output, '')
    const result = spawnSync('bash', ['-c', validation.run], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, TAG: tag, GITHUB_OUTPUT: output },
    })
    assert.equal(result.status, status, `${tag}: ${result.stdout}\n${result.stderr}`)
    if (status === 0) assert.equal(readFileSync(output, 'utf8'), `ref=refs/tags/${tag}\n`)
    else assert.match(result.stdout + result.stderr, /must be a release tag/)
  }
})

test('release artifacts come from the tagged declaration and fan out without cancelling siblings', () => {
  const declaration = workflow.jobs.resolve.steps.find((step: any) => step.id === 'artifacts')
  assert.match(declaration.run, /git show "\$\{SHA\}:apps\/infra\/mstage\.env\.json"/)
  assert.equal(workflow.jobs.publish.strategy['fail-fast'], false)
  assert.equal(workflow.jobs.publish.strategy.matrix.artifact, '${{ fromJSON(needs.resolve.outputs.artifacts) }}')
})

test('current tooling builds the release source using its declaration without loading a cloud stage', () => {
  const steps = workflow.jobs.publish.steps as any[]
  const checkouts = steps.filter((step) => /actions\/checkout/.test(step.uses ?? ''))
  assert.equal(checkouts.length, 2)
  assert.equal(checkouts[0].with.ref, undefined)
  assert.equal(checkouts[1].with.ref, '${{ needs.resolve.outputs.sha }}')
  assert.equal(checkouts[1].with.path, 'release-source')
  const build = steps.find((step) => step.name === 'Build and upload')
  assert.equal(build.env.MSTAGE_ENV_CONFIG, '${{ github.workspace }}/release-source/apps/infra/mstage.env.json')
  assert.match(build.run, /mbuild publish .*--ghcr "\$GHCR_REPOSITORY".*--artifact "\$ARTIFACT".*--version "\$TAG"/)
  assert.equal(steps.find((step) => step.uses === './.github/actions/setup-infra').with, undefined)
  assert.ok(commands.indexOf('DOCKER_CONFIG=$RUNNER_TEMP/docker') < commands.indexOf('mbuild publish'))
})

test('all publication attempts for one release queue together', () => {
  assert.equal(workflow.concurrency.group, 'mbuild-release-${{ inputs.tag }}')
  assert.equal(workflow.concurrency['cancel-in-progress'], false)
  assert.match(workflow['run-name'], /GHCR/)
})
