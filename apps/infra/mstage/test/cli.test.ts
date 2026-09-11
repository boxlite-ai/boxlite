import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadConfig, parseStages } from '../src/config/load.ts'
import { UsageError, requirementsFor, run, usage } from '../src/cli/run.ts'

// mstage is wired into apps/infra, not the repository root, so this is where
// `npm run mstage` resolves and where .mstage.config.json is found.
const infraRoot = fileURLToPath(new URL('../..', import.meta.url))

/**
 * The stage file every test here reads, committed so every checkout has one.
 *
 * `.mstage.config.json` names somebody's cloud account and is not committed, so
 * a test that read it would pass on the machine it was written on and fail on
 * a fresh clone and in CI. The example is the template a new checkout copies,
 * which makes reading it here the thing that keeps it parseable.
 */
const EXAMPLE = fileURLToPath(new URL('../../.mstage.config.example.json', import.meta.url))

const mstage = (...args: string[]) =>
  spawnSync('npm', ['run', '--silent', 'mstage', ...args], {
    cwd: infraRoot,
    encoding: 'utf8',
    env: { ...process.env, MSTAGE_CONFIG: EXAMPLE },
  })

/**
 * What the stage file declares, read from the file the run below reads.
 *
 * Not a literal: `.mstage.config.json` is not committed, so the region it
 * names is one account's and differs per checkout — a literal passes on the
 * machine it was written on and fails on every other. What crosses a boundary
 * here is still the whole invocation: npm's argv handling, the precedence
 * chain, and the handler's own output.
 */
const declaredRegion = (stage: string): string => {
  const path = EXAMPLE
  const declared = parseStages(path, readFileSync(path, 'utf8'))[stage]
  assert.ok(declared?.region, `${path} gives stage "${stage}" no region`)
  return declared.region
}

test('an option left of the separator is reported by the real npm invocation', () => {
  // The swallow is npm's, so proving the guard requires going through npm.
  const result = mstage('aws', '--stage', 'dev', 'whoami')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /--stage was consumed by npm/)
})

test('the same option right of the separator resolves the declared stage', () => {
  const result = mstage('aws', 'region', '--', '--stage', 'dev')
  assert.equal(result.status, 0, result.stderr)
  // A whole line of its own, so the note the handler prints beside it is not
  // what satisfies this. A region is letters, digits and `-`, so it carries no
  // pattern of its own into the match.
  assert.match(result.stdout, new RegExp(`^${declaredRegion('dev')}$`, 'm'))
})

test('an undeclared stage is refused with the declared ones listed', () => {
  const result = mstage('aws', 'region', '--', '--stage', 'staging')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Stage "staging" \(from --stage\) is not declared/)
  assert.match(result.stderr, /Declared stages: dev/)
})

test('usage names every module and command, and where providers are declared', () => {
  const text = usage()
  for (const fragment of ['login', 'aws', 'whoami', 'region', 'exec', 'state', 'unlock', 'edit']) {
    assert.match(text, new RegExp(fragment))
  }
  assert.match(text, /declared per stage in \.mstage\.config\.json/)
})

test('an unknown module or command lists what exists', async () => {
  await assert.rejects(() => run({ argv: ['nope'], environment: {}, log() {} }), UsageError)
  await assert.rejects(() => run({ argv: ['nope'], environment: {}, log() {} }), /Known modules: login, aws/)
  await assert.rejects(
    () => run({ argv: ['aws', 'nope'], environment: {}, log() {} }),
    /Known commands: whoami, region, exec/,
  )
  // The dispatcher is the only thing that makes a command reachable, so each
  // module is asked what it registered rather than trusted to have registered it.
  await assert.rejects(
    () => run({ argv: ['state', 'nope'], environment: {}, log() {} }),
    /Unknown command "nope" for module state\. Known commands: unlock, edit/,
  )
})

test('a provider this repository does not declare is refused', async () => {
  // The refusal lists what this checkout declares, read rather than restated:
  // the stage file is not committed, so a literal list passes on the machine
  // it was written on and fails on every other. What crosses a boundary is
  // still the whole path — the dispatcher, the merge over every stage, and
  // the refusal's own wording.
  const declared = Object.keys(
    // The example, because the real stage file is not committed — see
    // force-login.test.ts for why these tests read the template.
    requirementsFor({
      config: loadConfig({ cwd: infraRoot, environment: { MSTAGE_CONFIG: EXAMPLE } }),
      stage: undefined,
    }),
  )
  assert.ok(declared.length > 0, `${infraRoot} declares no login provider on any stage`)
  await assert.rejects(
    () => run({ argv: ['login', 'okta'], environment: { MSTAGE_CONFIG: EXAMPLE }, log() {} }),
    new RegExp(`No stage here uses "okta"\\. \\.mstage\\.config\\.json declares: ${declared.join(', ')}`),
  )
})

test('login providers come from the stage file, not from mstage itself', () => {
  const stages = parseStages(
    '/repo/.mstage.config.json',
    JSON.stringify({
      stages: {
        dev: {
          home: 'aws',
          region: 'ap-southeast-1',
          login: { aws: {}, auth0: { required: false } },
        },
      },
    }),
  )
  assert.deepEqual(stages.dev!.login, { aws: { required: true }, auth0: { required: false } })
  // A stage that names none needs none; nothing is inherited from above it.
  const silent = parseStages('/repo/.mstage.config.json', JSON.stringify({ stages: { dev: { home: 'aws' } } }))
  assert.deepEqual(silent.dev!.login, {})
})

test('a command that takes no inner command rejects one', async () => {
  await assert.rejects(
    () => run({ argv: ['aws', 'region', '--stage', 'dev', '--', 'ls'], environment: {}, log() {} }),
    /takes no inner command/,
  )
})
