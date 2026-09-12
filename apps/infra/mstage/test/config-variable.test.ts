/*
 * A stage's declaration, carried outside the repository.
 *
 * `.mstage.config.json` is not committed, so a runner has no copy of it. What
 * it has is the GitHub environment it runs in, and `config put`/`config get`
 * are the two ends of getting the same block through it.
 *
 * The pair has to agree about two things — what the variable is called, and
 * what shape its value is — and disagreeing about either fails only on a
 * runner, which is the one place neither is easy to look at.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ConfigVariableError, resolveConfig, variableNameFor } from '../src/config/variable.ts'
import { get, put } from '../src/cli/handlers/config.ts'

/**
 * One stage as all three tools declare it: mstage's coordinates, mbuild's
 * registry, and mdeploy's `deploy`. The block travels whole, so a key no tool
 * here reads has to arrive on the runner as written — that is what the
 * variable is for.
 */
const DEV = {
  home: 'gcp',
  region: 'asia-southeast1',
  project: 'p',
  login: { gcp: { required: true } },
  registry: { kind: 'artifact-registry', repository: 'r', immutableTags: true, scanOnPush: true },
  scan: { blockOn: ['CRITICAL'], timeoutSeconds: 300 },
  deploy: { service: 'console' },
}
const PROD = { ...DEV, protect: true }

/** A checkout with a stage file in it, which is what a workstation has. */
const checkout = (stages: Record<string, unknown> = { dev: DEV, prod: PROD }) => {
  const cwd = mkdtempSync(join(tmpdir(), 'mstage-config-'))
  writeFileSync(join(cwd, '.mstage.config.json'), JSON.stringify({ stages }))
  return cwd
}

const record = () => {
  const lines: string[] = []
  return { lines, log: (line: string) => lines.push(line) }
}

test('the variable is named after the app, so two apps do not overwrite each other', () => {
  assert.equal(variableNameFor('backoffice'), 'BOXLITE_MSTAGE_BACKOFFICE_CONFIG')
  // `-` is not legal in an environment variable name.
  assert.equal(variableNameFor('boxlite-commerce'), 'BOXLITE_MSTAGE_BOXLITE_COMMERCE_CONFIG')
  assert.throws(() => variableNameFor('has space'), ConfigVariableError)
})

test('the variable wins over the file, which is what makes one command work in both places', () => {
  // On a runner the variable is the only copy; on a workstation the file is.
  const cwd = checkout()
  const carried = { dev: { home: 'aws', region: 'ap-southeast-1' } }
  const fromVariable = resolveConfig({
    app: 'backoffice',
    stage: 'dev',
    environment: { BOXLITE_MSTAGE_BACKOFFICE_CONFIG: JSON.stringify(carried) },
    cwd,
  })
  assert.deepEqual(fromVariable.block, carried)
  assert.equal(fromVariable.from, 'BOXLITE_MSTAGE_BACKOFFICE_CONFIG')

  const fromFile = resolveConfig({ app: 'backoffice', stage: 'dev', environment: {}, cwd })
  assert.deepEqual(fromFile.block, { dev: DEV })
  assert.match(fromFile.from, /\.mstage\.config\.json$/)
})

test('an empty variable is absent rather than an empty config', () => {
  // That is what an unset GitHub variable expands to in a shell, so reading it
  // as a config would hand a script `{}` instead of sending it to the file.
  const cwd = checkout()
  const resolved = resolveConfig({
    app: 'backoffice',
    stage: 'dev',
    environment: { BOXLITE_MSTAGE_BACKOFFICE_CONFIG: '   ' },
    cwd,
  })
  assert.deepEqual(resolved.block, { dev: DEV })
})

test('the block carries its own stage name, so a variable from the wrong environment says so', () => {
  const cwd = checkout()
  assert.deepEqual(Object.keys(resolveConfig({ app: 'backoffice', stage: 'prod', environment: {}, cwd }).block), [
    'prod',
  ])
  // Read out of the wrong environment it is a named refusal, not a stage that
  // silently has the wrong region in it.
  assert.throws(
    () =>
      resolveConfig({
        app: 'backoffice',
        stage: 'prod',
        environment: { BOXLITE_MSTAGE_BACKOFFICE_CONFIG: JSON.stringify({ dev: DEV }) },
        cwd,
      }),
    /holds no stage "prod"\. It holds: dev/,
  )
})

test('neither a variable nor a file is a refusal naming both', () => {
  const empty = mkdtempSync(join(tmpdir(), 'mstage-bare-'))
  assert.throws(
    () => resolveConfig({ app: 'backoffice', stage: 'dev', environment: {}, cwd: empty }),
    /BOXLITE_MSTAGE_BACKOFFICE_CONFIG is not set and .*\.mstage\.config\.json is not there/,
  )
})

test('a stage the file does not declare is refused with the ones it does', () => {
  assert.throws(
    () => resolveConfig({ app: 'backoffice', stage: 'dve', environment: {}, cwd: checkout() }),
    /declares no stage "dve"\. Declared: dev, prod/,
  )
})

test('a variable that is not JSON says so rather than reaching a script', () => {
  assert.throws(
    () =>
      resolveConfig({
        app: 'backoffice',
        stage: 'dev',
        environment: { BOXLITE_MSTAGE_BACKOFFICE_CONFIG: 'not json' },
        cwd: checkout(),
      }),
    /BOXLITE_MSTAGE_BACKOFFICE_CONFIG is not valid JSON/,
  )
})

test('put sends the block to gh through stdin, into the environment named for the stage', async () => {
  // Through stdin rather than argv: argv is visible in the process table, and
  // the block runs to a few hundred bytes.
  const calls: { argv: string[]; input: string }[] = []
  const code = await put({
    app: 'backoffice',
    stage: 'dev',
    environment: {},
    cwd: checkout(),
    log: record().log,
    readInput: async () => '',
    runCommand: (command: string, args: string[], options: any) => {
      calls.push({ argv: [command, ...args], input: options.input })
      return { status: 0 }
    },
  })

  assert.equal(code, 0)
  // No flag for the value: `gh variable set` reads stdin exactly when `--body`
  // is absent. Naming one that does not exist is how this ran green against a
  // fake and failed against gh with `unknown flag`, so the list is held whole.
  assert.deepEqual(calls[0]!.argv, ['gh', 'variable', 'set', 'BOXLITE_MSTAGE_BACKOFFICE_CONFIG', '--env', 'dev'])
  assert.deepEqual(JSON.parse(calls[0]!.input), { dev: DEV })
  // The invariant the comment above claims, checked rather than described: no
  // argument carries the block, whatever the flags around it come to be.
  for (const argument of calls[0]!.argv) {
    assert.ok(!argument.includes('asia-southeast1'), `the block reached argv as ${argument}`)
  }
})

test('put reads a piped document when one arrives, and the file when none does', async () => {
  const piped = { stages: { dev: { home: 'aws', region: 'ap-southeast-1' } } }
  const sent: string[] = []
  const runCommand = (_command: string, _args: string[], options: any) => {
    sent.push(options.input)
    return { status: 0 }
  }
  const cwd = checkout()
  const fromPipe = record()
  await put({
    app: 'backoffice',
    stage: 'dev',
    environment: {},
    cwd,
    log: fromPipe.log,
    readInput: async () => JSON.stringify(piped),
    runCommand,
  })
  assert.deepEqual(JSON.parse(sent[0]!), { dev: piped.stages.dev }, 'the pipe outranks the file')
  /*
   * And the log says so. One line describes a write to a GitHub environment,
   * and naming the file when the document came from stdin sends the reader to
   * a file whose contents were not what was written — the one place the
   * difference is visible at all.
   */
  assert.match(fromPipe.lines.join('\n'), /← stdin/)
  assert.doesNotMatch(fromPipe.lines.join('\n'), /\.mstage\.config\.json/)

  const fromFile = record()
  await put({
    app: 'backoffice',
    stage: 'dev',
    environment: {},
    cwd,
    log: fromFile.log,
    readInput: async () => '',
    runCommand,
  })
  assert.deepEqual(JSON.parse(sent[1]!), { dev: DEV }, 'and nothing piped falls back to it')
  assert.match(fromFile.lines.join('\n'), /\.mstage\.config\.json/, 'the fallback names the file it read')
})

test('put reports what gh said rather than only that it failed', async () => {
  // gh is the thing that knows whether this is a missing environment, a
  // missing repository or a token without the scope.
  await assert.rejects(
    () =>
      put({
        app: 'backoffice',
        stage: 'dev',
        environment: {},
        cwd: checkout(),
        log: record().log,
        readInput: async () => '',
        runCommand: () => ({ status: 1, stderr: 'HTTP 404: Not Found (environment dev)' }),
      }),
    /Could not set BOXLITE_MSTAGE_BACKOFFICE_CONFIG on environment dev: HTTP 404/,
  )
})

test('an absent gh says how to install it', async () => {
  await assert.rejects(
    () =>
      put({
        app: 'backoffice',
        stage: 'dev',
        environment: {},
        cwd: checkout(),
        log: record().log,
        readInput: async () => '',
        runCommand: () => ({ error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) }),
      }),
    /gh is not installed/,
  )
})

test('get prints one line of JSON, which is the whole value a script reads', async () => {
  const printed = record()
  const code = await get({ app: 'backoffice', stage: 'dev', environment: {}, cwd: checkout(), log: printed.log })
  assert.equal(code, 0)
  assert.equal(printed.lines.length, 1, 'anything else on stdout would end up inside $(…)')
  assert.deepEqual(JSON.parse(printed.lines[0]!), { dev: DEV })
})

test('what put writes is what get reads back', async () => {
  // The pair only has to agree on a runner, where neither end is easy to look
  // at, so the round trip is held here instead.
  let written = ''
  await put({
    app: 'backoffice',
    stage: 'prod',
    environment: {},
    cwd: checkout(),
    log: record().log,
    readInput: async () => '',
    runCommand: (_command: string, _args: string[], options: any) => {
      written = options.input
      return { status: 0 }
    },
  })

  const printed = record()
  await get({
    app: 'backoffice',
    stage: 'prod',
    environment: { BOXLITE_MSTAGE_BACKOFFICE_CONFIG: written },
    cwd: mkdtempSync(join(tmpdir(), 'mstage-runner-')),
    log: printed.log,
  })
  assert.deepEqual(JSON.parse(printed.lines[0]!), { prod: PROD })
})
