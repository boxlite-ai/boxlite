import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

const workflowsDirectory = fileURLToPath(
  new URL('../../../../.github/workflows/', import.meta.url),
)

const withoutComments = (source: string): string =>
  source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')

test('a published GitHub Release dispatches mbuild-release from main', () => {
  const trigger = readdirSync(workflowsDirectory)
    .filter((name) => name.endsWith('.yml'))
    .map((name) => {
      const source = readFileSync(join(workflowsDirectory, name), 'utf8')
      return { name, source, commands: withoutComments(source) }
    })
    .find(({ commands }) => /gh workflow run mbuild-release\.yml/.test(commands))

  assert.ok(trigger, 'a published GitHub Release does not dispatch mbuild-release')

  const workflow = load(trigger.source) as any
  assert.deepEqual(workflow.on?.release?.types, ['published'])
  assert.deepEqual(workflow.permissions, {}, `${trigger.name} grants workflow-wide permissions`)

  const jobs = Object.entries<any>(workflow.jobs ?? {})
  assert.equal(jobs.length, 1, `${trigger.name} does more than bridge the release event`)
  const [jobName, job] = jobs[0]!
  assert.match(String(job.if ?? ''), /!github\.event\.release\.prerelease/)
  assert.deepEqual(job.permissions, { actions: 'write' })
  assert.equal(job.environment, undefined, `${jobName} binds an Environment before mbuild-release`)

  const step = job.steps?.find((candidate: any) =>
    /gh workflow run mbuild-release\.yml/.test(String(candidate.run ?? '')),
  )
  assert.ok(step, `${jobName} has no mbuild-release dispatch step`)
  assert.equal(step.env?.GH_TOKEN, '${{ github.token }}')
  assert.equal(step.env?.TAG, '${{ github.event.release.tag_name }}')
  assert.match(step.run, /--repo "\$GITHUB_REPOSITORY"/)
  assert.match(step.run, /--ref main/)
  assert.match(step.run, /-f command=publish/)
  assert.match(step.run, /-f tag="\$TAG"/)
  assert.doesNotMatch(trigger.commands, /actions\/checkout|id-token:/)
})
