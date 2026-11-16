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

test('stage admits SHA, PR and stable tags while prod admission remains', () => {
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

test('missing stage commit images build while dev and prod import existing releases', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stage-image-plan-'))
  try {
    writeFileSync(
      join(directory, 'npm'),
      '#!/bin/sh\ncase "$*" in *--ghcr*) exit 0 ;; *runner:build*) echo staged=missing ;; *) exit 66 ;; esac\n',
      { mode: 0o755 },
    )
    const script = step(deployment.jobs.plan, 'Decide').run
    for (const [stage, ref, expected] of [
      ['dev', 'v1.2.3', 'release-import'],
      ['prod', 'v1.2.3', 'release-import'],
      ['stage', 'v1.2.3', 'build'],
      ['stage', 'a'.repeat(40), 'build'],
    ]) {
      const output = join(directory, 'output')
      writeFileSync(output, '')
      const classified = run(step(deployment.jobs.resolve, 'classify').run, {
        REF: ref,
        STAGE: stage,
        GITHUB_REF: 'refs/heads/main',
        GITHUB_OUTPUT: output,
      })
      assert.equal(classified.status, 0, classified.stdout + classified.stderr)
      const fields = Object.fromEntries(
        readFileSync(output, 'utf8').trimEnd().split('\n').map((line) => line.split('=')),
      )
      assert.equal(fields.candidate, ref)
      assert.equal(fields.version, stage === 'stage' ? '' : ref)
      writeFileSync(output, '')
      const addressed = run(step(deployment.jobs.resolve, 'tag').run, {
        VERSION: fields.version,
        RESOLVED: 'a'.repeat(40),
        GITHUB_OUTPUT: output,
      })
      assert.equal(addressed.status, 0, addressed.stdout + addressed.stderr)
      const address = Object.fromEntries(
        readFileSync(output, 'utf8').trimEnd().split('\n').map((line) => line.split('=')),
      )
      assert.equal(address.image, stage === 'stage' ? address.sha : `${ref}-${address.sha}`)
      writeFileSync(output, '')
      const result = run(script, {
        PATH: `${directory}:${process.env.PATH}`,
        STAGE: stage,
        VERSION: fields.version,
        SHA: address.sha,
        IMAGE_TAG: address.image,
        LINE: fields.line,
        COMPONENTS: 'api+runner',
        GHCR_REPOSITORY: 'boxlite-ai/boxlite',
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: join(directory, 'summary'),
      })
      assert.equal(result.status, 0, `${stage}: ${result.stdout}${result.stderr}`)
      assert.match(readFileSync(output, 'utf8'), new RegExp(`^api=${expected}$`, 'm'), stage)
      assert.match(readFileSync(output, 'utf8'), new RegExp(`^runner=${stage === 'stage' ? 'build' : 'skip'}$`, 'm'), stage)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
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
