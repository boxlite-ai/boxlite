import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { load } from 'js-yaml'
import { Lexer, Parser, Evaluator, data } from '@actions/expressions'

const readWorkflow = (name: string): any =>
  load(readFileSync(new URL(`../../../../.github/workflows/${name}`, import.meta.url), 'utf8'))
const deployment = readWorkflow('mdeploy-all.yml')
const release = readWorkflow('mbuild-release.yml')
const step = (job: any, name: string): any => {
  const found = job.steps.find((candidate: any) => candidate.name === name || candidate.id === name)
  assert.ok(found, `missing workflow boundary: ${name}`)
  return found
}
const run = (script: string, env: Record<string, string>, cwd?: string) =>
  spawnSync('bash', ['-c', script], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })

test('stage admits SHA, PR and stable release while RC and prod commit refusals remain', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stage-ref-policy-'))
  try {
    const classify = step(deployment.jobs.resolve, 'classify').run
    for (const [stage, ref, allowed] of [
      ['stage', 'a'.repeat(40), true],
      ['stage', 'v1.2.3', true],
      ['stage', '#123', true],
      ['stage', 'v1.2.3-rc.1', false],
      ['dev', '#123', true],
      ['dev', 'b'.repeat(40), true],
      ['prod', 'v1.2.3', true],
      ['prod', 'c'.repeat(40), false],
      ['prod', '#123', false],
      ['prod', 'v1.2.3-rc.1', false],
      ['typo', 'v1.2.3', false],
    ] as const) {
      const result = run(classify, {
        REF: ref,
        FALLBACK: 'd'.repeat(40),
        STAGE: stage,
        GITHUB_REF: 'refs/heads/main',
        GITHUB_OUTPUT: join(directory, 'output'),
        GITHUB_STEP_SUMMARY: join(directory, 'summary'),
      })
      assert.equal(result.status === 0, allowed, `${stage}/${ref}: ${result.stdout}${result.stderr}`)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('stage shares dev branch access and keeps the existing branch containment action', () => {
  assert.deepEqual(deployment.on.workflow_dispatch.inputs.stage.options, ['dev', 'stage', 'prod'])
  for (const name of ['resolve', 'plan', 'build-runner', 'deploy']) {
    assert.match(
      deployment.jobs[name].if,
      /github.ref == 'refs\/heads\/main' \|\| inputs.stage == 'dev' \|\| inputs.stage == 'stage'/,
      name,
    )
  }
  const resolve = step(deployment.jobs.resolve, 'ref')
  assert.equal(resolve.uses, './.github/actions/resolve-ref')
  assert.equal(resolve.with.branch, '${{ github.ref_name }}')
  assert.equal(deployment.jobs['build-images'].with.stage, '${{ inputs.stage }}')
  assert.equal(deployment.jobs['release-publish'].with.stage, '${{ inputs.stage }}')
})

test('caller and reusable image jobs admit stage candidate branches without admitting prod', () => {
  const build = readWorkflow('mbuild.yml')
  const jobs = [deployment.jobs.resolve, build.jobs.declaration, build.jobs.mbuild]
  for (const job of jobs) {
    const expression = job.if.trim().slice(3, -2).replaceAll('cancelled()', 'false').replaceAll('failure()', 'false')
    for (const stage of ['dev', 'stage', 'prod', 'unknown']) {
      for (const ref of ['refs/heads/main', 'refs/heads/feature']) {
        const contexts = new data.Dictionary(
          { key: 'github', value: new data.Dictionary({ key: 'ref', value: new data.StringData(ref) }) },
          {
            key: 'inputs',
            value: new data.Dictionary(
              { key: 'stage', value: new data.StringData(stage) },
              { key: 'to', value: new data.StringData(stage) },
              { key: 'command', value: new data.StringData('promote') },
            ),
          },
        )
        const ast = new Parser(new Lexer(expression).lex().tokens, ['inputs', 'github'], []).parse()
        assert.equal(
          new Evaluator(ast, contexts).evaluate().coerceString(),
          String(ref === 'refs/heads/main' || ['dev', 'stage'].includes(stage)),
        )
      }
    }
  }
})

test('missing stage stable images publish locally while prod still plans promotion', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stage-image-plan-'))
  try {
    writeFileSync(join(directory, 'npm'), '#!/bin/sh\nexit 66\n', { mode: 0o755 })
    const script = step(deployment.jobs.plan, 'Decide').run
    for (const [stage, version, expected] of [
      ['stage', 'v1.2.3', 'release-publish'],
      ['dev', 'v1.2.3', 'release-publish'],
      ['prod', 'v1.2.3', 'release-promote'],
      ['stage', '', 'build'],
    ]) {
      const output = join(directory, 'output')
      writeFileSync(output, '')
      const result = run(script, {
        PATH: `${directory}:${process.env.PATH}`,
        STAGE: stage,
        VERSION: version,
        SHA: 'a'.repeat(40),
        IMAGE_TAG: 'a'.repeat(40),
        LINE: 'candidate',
        COMPONENTS: 'api',
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: join(directory, 'summary'),
      })
      assert.equal(result.status, 0, `${stage}: ${result.stdout}${result.stderr}`)
      assert.match(readFileSync(output, 'utf8'), new RegExp(`^api=${expected}$`, 'm'), stage)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('release publish target is allowlisted before an Environment and defaults to dev', () => {
  assert.ok(release.on.workflow_dispatch.inputs.stage, 'release publication stage input is missing')
  assert.deepEqual(release.on.workflow_dispatch.inputs.stage.options, ['dev', 'stage'])
  assert.equal(release.on.workflow_call.inputs.stage.default, 'dev')
  assert.equal(release.jobs.resolve.environment, undefined)
  const guard = step(release.jobs.resolve, 'Validate publication stage')
  for (const [target, allowed] of [
    ['dev', true],
    ['stage', true],
    ['prod', false],
    ['typo', false],
  ]) {
    const result = run(guard.run, { PUBLISH_STAGE: target as string })
    assert.equal(result.status === 0, allowed, `${target}: ${result.stdout}${result.stderr}`)
  }
  assert.equal(release.jobs.publish.environment, "${{ inputs.stage || 'dev' }}")
  assert.equal(release.jobs.publish.env.PUBLISH_STAGE, "${{ inputs.stage || 'dev' }}")
  assert.equal(release.jobs.source.environment, "${{ inputs.source || 'dev' }}")
  assert.equal(release.jobs.promote.environment, 'prod')
})

test('stage PR resolution requires an open, mergeable request and uses its merge SHA', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stage-pr-resolve-'))
  try {
    writeFileSync(join(directory, 'gh'), '#!/bin/sh\nprintf "%s\\n" "$PR_RESPONSE"\n', { mode: 0o755 })
    writeFileSync(join(directory, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const merge = 'e'.repeat(40)
    for (const [state, mergeable, allowed] of [
      ['OPEN', 'MERGEABLE', true],
      ['CLOSED', 'MERGEABLE', false],
      ['MERGED', 'MERGEABLE', false],
      ['OPEN', 'CONFLICTING', false],
      ['OPEN', 'UNKNOWN', false],
    ] as const) {
      const output = join(directory, 'output')
      writeFileSync(output, '')
      const result = run(step(deployment.jobs.resolve, 'pr').run, {
        PATH: `${directory}:${process.env.PATH}`,
        PR: '123',
        GITHUB_REPOSITORY: 'boxlite-ai/boxlite',
        GITHUB_OUTPUT: output,
        PR_RESPONSE: JSON.stringify({
          state,
          mergeable,
          potentialMergeCommit: { oid: merge },
          headRefOid: 'a'.repeat(40),
          isCrossRepository: true,
        }),
      })
      assert.equal(result.status === 0, allowed, `${state}/${mergeable}: ${result.stdout}${result.stderr}`)
      assert.equal(readFileSync(output, 'utf8'), allowed ? `sha=${merge}\n` : '')
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('release promotion explicitly selects dev or stage before binding its Environment', () => {
  assert.ok(deployment.on.workflow_dispatch.inputs.source, 'deployment source selector is missing')
  assert.deepEqual(deployment.on.workflow_dispatch.inputs.source.options, ['dev', 'stage'])
  assert.equal(deployment.on.workflow_dispatch.inputs.source.default, 'dev')
  assert.equal(deployment.jobs['release-promote'].with.source, '${{ inputs.source }}')
  assert.ok(release.on.workflow_call.inputs.source, 'release source selector is missing')
  assert.equal(release.on.workflow_call.inputs.source.default, 'dev')
  assert.deepEqual(release.on.workflow_dispatch.inputs.source.options, ['dev', 'stage'])
  const guard = step(release.jobs.resolve, 'Validate promotion source')
  assert.equal(release.jobs.resolve.environment, undefined)
  assert.deepEqual(release.jobs.source.needs, ['resolve'])
  for (const [source, allowed] of [
    ['dev', true],
    ['stage', true],
    ['prod', false],
    ['typo', false],
  ] as const) {
    const result = run(guard.run, { SOURCE_STAGE: source })
    assert.equal(result.status === 0, allowed, `${source}: ${result.stdout}${result.stderr}`)
  }
  assert.equal(release.jobs.promote.env.SOURCE_STAGE, "${{ inputs.source || 'dev' }}")
  const setup = release.jobs.promote.steps.find((candidate: any) => candidate.uses === './.github/actions/setup-infra')
  assert.equal(setup.with.stages, "${{ format('{0} prod', inputs.source || 'dev') }}")
})

test('promotion verifies and copies only the selected source, with no fallback', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stage-promotion-workflow-'))
  try {
    writeFileSync(
      join(directory, 'npm'),
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.NPM_CALLS,JSON.stringify(process.argv.slice(2))+'\\n');process.exit(Number(process.env.NPM_STATUS || 0));\n`,
      { mode: 0o755 },
    )
    writeFileSync(join(directory, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const job = release.jobs.promote
    const verify = job.steps.find((candidate: any) => candidate.run?.includes('::error title=not published::'))
    assert.ok(verify, 'missing promotion source verification boundary')
    for (const source of ['dev', 'stage']) {
      const calls = join(directory, 'calls')
      writeFileSync(calls, '')
      const env = {
        PATH: `${directory}:${process.env.PATH}`,
        NPM_CALLS: calls,
        SOURCE_STAGE: source,
        SHA: 'a'.repeat(40),
        TAG: 'v1.2.3',
        ARTIFACT: 'api',
      }
      for (const boundary of [verify, step(job, 'Download and upload')]) {
        const result = run(boundary.run, env)
        assert.equal(result.status, 0, result.stdout + result.stderr)
      }
      const recorded = readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[])
      assert.equal(recorded.length, 2)
      assert.equal(recorded[0]![recorded[0]!.indexOf('--stage') + 1], source)
      assert.equal(recorded[1]![recorded[1]!.indexOf('--from') + 1], source)
      assert.equal(recorded[1]![recorded[1]!.indexOf('--to') + 1], 'prod')
      for (const status of ['66', '1']) {
        writeFileSync(calls, '')
        const refused = run(verify.run, { ...env, NPM_STATUS: status })
        assert.notEqual(refused.status, 0)
        assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 1, 'source read must not fall back')
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the actual release inspect, registry gate and publish all use the chosen stage', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stage-publisher-'))
  try {
    writeFileSync(
      join(directory, 'npm'),
      `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(process.env.NPM_CALLS,JSON.stringify(args)+'\\n');if(args.includes('verify'))process.exit(66);if(args.includes('inspect'))console.log('kind=artifact-registry\\nregion=us-east5');\n`,
      { mode: 0o755 },
    )
    for (const target of ['dev', 'stage']) {
      const calls = join(directory, 'calls')
      writeFileSync(calls, '')
      const env = {
        PATH: `${directory}:${process.env.PATH}`,
        NPM_CALLS: calls,
        PUBLISH_STAGE: target,
        SHA: 'a'.repeat(40),
        TAG: 'v1.2.3',
        ARTIFACT: 'api',
        GITHUB_OUTPUT: join(directory, 'output'),
      }
      const job = release.jobs.publish
      const gate = job.steps.find((candidate: any) => candidate.name?.startsWith('Refuse an artifact'))
      assert.ok(gate, 'missing immutable-release gate')
      for (const boundary of [step(job, 'Resolve the stage'), gate, step(job, 'Build and upload')]) {
        const result = run(boundary.run, env)
        assert.equal(result.status, 0, `${target}/${boundary.name}: ${result.stdout}${result.stderr}`)
      }
      const recorded = readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[])
      assert.equal(recorded.length, 3)
      for (const invocation of recorded)
        assert.equal(invocation[invocation.indexOf('--stage') + 1], target, invocation.join(' '))
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
