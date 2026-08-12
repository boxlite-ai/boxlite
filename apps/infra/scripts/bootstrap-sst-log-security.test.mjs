// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { runBootstrapSstSecretMutation } from './bootstrap-environment.mjs'

const MODULE_URL = new URL('./bootstrap-environment.mjs', import.meta.url).href
const REGISTERED_SECRET_NAME = 'OIDC_CLIENT_ID'

function failingSstInvocation({ functionName, args, infraRoot, input, failureLog, label }) {
  const program = `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ${functionName} } from ${JSON.stringify(MODULE_URL)}
try {
  ${functionName}(${JSON.stringify(args)}, {
    ${input === undefined ? '' : 'input: process.env.SYNTHETIC_SECRET_INPUT,'}
    timeout: 1000,
    label: ${JSON.stringify(label)},
    infraRoot: process.env.SYNTHETIC_INFRA_ROOT,
    wrapperPath: '/synthetic/sst-wrapper',
    execute() {
      if (process.env.SYNTHETIC_FAILURE_LOG) {
        writeFileSync(join(process.env.SYNTHETIC_INFRA_ROOT, '.sst', 'log', 'sst.log'), process.env.SYNTHETIC_FAILURE_LOG)
      }
      const error = new Error('synthetic SST process failure')
      error.code = 'SYNTHETIC_FAILURE'
      throw error
    },
  })
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
`
  return spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SYNTHETIC_INFRA_ROOT: infraRoot,
      SYNTHETIC_SECRET_INPUT: 'synthetic-secret-input-that-must-not-print',
      ...(failureLog === undefined ? {} : { SYNTHETIC_FAILURE_LOG: failureLog }),
    },
  })
}

test('secret-sensitive SST failure never appends the planted SST log tail', () => {
  const infraRoot = mkdtempSync(join(tmpdir(), 'boxlite-bootstrap-secret-log-'))
  const sentinel = 'planted-sst-log-secret-sentinel'
  mkdirSync(join(infraRoot, '.sst', 'log'), { recursive: true })
  writeFileSync(join(infraRoot, '.sst', 'log', 'sst.log'), `${sentinel}\n`)

  try {
    const result = failingSstInvocation({
      functionName: 'runBootstrapSstSecretMutation',
      args: ['secret', 'set', REGISTERED_SECRET_NAME, '--stage', 'dev'],
      infraRoot,
      input: 'synthetic-secret-input-that-must-not-print',
      failureLog: sentinel,
      label: 'set synthetic SST secret',
    })
    const output = `${result.stdout}${result.stderr}`

    assert.equal(result.status, 1)
    assert.match(output, /could not set synthetic SST secret/)
    assert.doesNotMatch(output, new RegExp(sentinel))
    assert.doesNotMatch(output, /synthetic-secret-input-that-must-not-print/)
  } finally {
    rmSync(infraRoot, { recursive: true, force: true })
  }
})

test('secret remove failure never appends the planted SST log tail', () => {
  const infraRoot = mkdtempSync(join(tmpdir(), 'boxlite-bootstrap-secret-remove-log-'))
  const sentinel = 'planted-sst-remove-log-secret-sentinel'
  mkdirSync(join(infraRoot, '.sst', 'log'), { recursive: true })
  writeFileSync(join(infraRoot, '.sst', 'log', 'sst.log'), `${sentinel}\n`)

  try {
    const result = failingSstInvocation({
      functionName: 'runBootstrapSstSecretMutation',
      args: ['secret', 'remove', REGISTERED_SECRET_NAME, '--stage', 'dev'],
      infraRoot,
      failureLog: sentinel,
      label: 'remove synthetic SST secret',
    })
    const output = `${result.stdout}${result.stderr}`

    assert.equal(result.status, 1)
    assert.match(output, /could not remove synthetic SST secret/)
    assert.doesNotMatch(output, new RegExp(sentinel))
  } finally {
    rmSync(infraRoot, { recursive: true, force: true })
  }
})

for (const outcome of ['success', 'failure']) {
  test(`secret mutation removes its exact SST diagnostic log before and after ${outcome}`, () => {
    const infraRoot = mkdtempSync(join(tmpdir(), `boxlite-bootstrap-secret-log-${outcome}-`))
    const logDirectory = join(infraRoot, '.sst', 'log')
    const diagnosticLog = join(logDirectory, 'sst.log')
    mkdirSync(logDirectory, { recursive: true })
    writeFileSync(diagnosticLog, 'stale-secret-bearing-log\n')

    try {
      const invoke = () =>
        runBootstrapSstSecretMutation(['secret', 'set', REGISTERED_SECRET_NAME, '--stage', 'dev'], {
          input: 'synthetic-secret-input-that-must-not-print',
          timeout: 1000,
          label: 'set synthetic SST secret',
          infraRoot,
          wrapperPath: '/synthetic/sst-wrapper',
          execute() {
            assert.equal(existsSync(diagnosticLog), false, 'stale log must be removed before SST starts')
            writeFileSync(diagnosticLog, 'new-secret-bearing-log\n')
            if (outcome === 'failure') throw new Error('synthetic SST process failure')
            return 'synthetic success'
          },
        })

      if (outcome === 'failure') assert.throws(invoke, /could not set synthetic SST secret/)
      else assert.equal(invoke(), 'synthetic success')
      assert.equal(existsSync(diagnosticLog), false, 'new log must be removed after SST settles')
    } finally {
      rmSync(infraRoot, { recursive: true, force: true })
    }
  })
}

test('secret mutation fails closed when the exact SST diagnostic log cannot be removed', () => {
  const infraRoot = mkdtempSync(join(tmpdir(), 'boxlite-bootstrap-secret-log-cleanup-failure-'))
  const diagnosticLog = join(infraRoot, '.sst', 'log', 'sst.log')
  mkdirSync(diagnosticLog, { recursive: true })
  let executed = false

  try {
    assert.throws(
      () =>
        runBootstrapSstSecretMutation(['secret', 'set', REGISTERED_SECRET_NAME, '--stage', 'dev'], {
          input: 'synthetic-secret-input-that-must-not-print',
          timeout: 1000,
          label: 'set synthetic SST secret',
          infraRoot,
          wrapperPath: '/synthetic/sst-wrapper',
          execute() {
            executed = true
          },
        }),
      /remove.*sst.*log|diagnostic log/i,
    )
    assert.equal(executed, false, 'cleanup failure must prevent the secret mutation')
  } finally {
    rmSync(infraRoot, { recursive: true, force: true })
  }
})

test('secret mutation fails closed when its post-execution log cleanup fails', () => {
  const infraRoot = mkdtempSync(join(tmpdir(), 'boxlite-bootstrap-secret-post-cleanup-failure-'))
  const diagnosticLog = join(infraRoot, '.sst', 'log', 'sst.log')
  let executed = false

  try {
    assert.throws(
      () =>
        runBootstrapSstSecretMutation(['secret', 'set', REGISTERED_SECRET_NAME, '--stage', 'dev'], {
          input: 'synthetic-secret-input-that-must-not-print',
          timeout: 1000,
          label: 'set synthetic SST secret',
          infraRoot,
          wrapperPath: '/synthetic/sst-wrapper',
          execute() {
            executed = true
            mkdirSync(diagnosticLog, { recursive: true })
            return 'synthetic success'
          },
        }),
      /remove.*sst.*log|diagnostic log/i,
    )
    assert.equal(executed, true)
  } finally {
    rmSync(infraRoot, { recursive: true, force: true })
  }
})

test('secret mutation accepts only a name plus an explicit validated stage in argv', () => {
  const positionalSecret = 'synthetic-positional-secret-value-that-must-not-print'
  const malformedArgv = [
    ['secret', 'set', REGISTERED_SECRET_NAME],
    ['secret', 'set', REGISTERED_SECRET_NAME, '--fallback', 'value', '--stage', 'dev'],
    ['secret', 'set', REGISTERED_SECRET_NAME, positionalSecret, '--stage', 'dev'],
    ['secret', 'set', REGISTERED_SECRET_NAME, '--stage', 'dev', positionalSecret],
    ['secret', 'set', positionalSecret, '--stage', 'dev'],
    ['secret', 'set', '--stage', '--stage', 'dev'],
    ['secret', 'set', REGISTERED_SECRET_NAME, '--stage', 'Dev'],
  ]
  let executions = 0

  // Every call needs its own infraRoot, rejected ones included: the wrapper
  // deletes <infraRoot>/.sst/log/sst.log, and it survives today only because
  // argv validation happens to run first. An ordering change would otherwise
  // make this loop delete the working tree's diagnostic log.
  const infraRoot = mkdtempSync(join(tmpdir(), 'boxlite-bootstrap-secret-argv-'))
  try {
    for (const args of malformedArgv) {
      assert.throws(
        () =>
          runBootstrapSstSecretMutation(args, {
            input: 'synthetic-secret-input-that-must-not-print',
            timeout: 1000,
            label: 'set synthetic SST secret',
            infraRoot,
            execute() {
              executions += 1
            },
          }),
        (error) => {
          assert.match(error.message, /argument|explicit|fallback|positional|secret name|stage/i)
          assert.doesNotMatch(error.message, new RegExp(positionalSecret))
          return true
        },
      )
    }
    assert.equal(executions, 0, 'invalid secret argv must be rejected before starting the wrapper')

    let wrapperArgs
    const result = runBootstrapSstSecretMutation(['secret', 'set', REGISTERED_SECRET_NAME, '--stage=dev'], {
      input: 'synthetic-secret-input-that-must-not-print',
      timeout: 1000,
      label: 'set synthetic SST secret',
      infraRoot,
      execute(_executable, args) {
        wrapperArgs = args
        return 'synthetic success'
      },
    })
    assert.equal(result, 'synthetic success')
    assert.deepEqual(wrapperArgs.slice(1), ['secret', 'set', REGISTERED_SECRET_NAME, '--stage', 'dev'])
    assert.equal(wrapperArgs.includes('synthetic-secret-input-that-must-not-print'), false)
  } finally {
    rmSync(infraRoot, { recursive: true, force: true })
  }
})

for (const operation of ['set', 'remove']) {
  const variants = [
    ['secret', operation, REGISTERED_SECRET_NAME, '--stage', 'dev'],
    ['--stage', 'dev', 'secret', operation, REGISTERED_SECRET_NAME],
    ['install', '--stage', 'dev', 'secret', operation, REGISTERED_SECRET_NAME],
  ]
  for (const [variantIndex, args] of variants.entries()) {
    test(`nonsecret SST runner refuses secret ${operation} variant ${variantIndex + 1} without exposing the log tail`, () => {
      const infraRoot = mkdtempSync(join(tmpdir(), `boxlite-bootstrap-secret-${operation}-misroute-`))
      const sentinel = `planted-misrouted-secret-${operation}-${variantIndex}-sentinel`
      mkdirSync(join(infraRoot, '.sst', 'log'), { recursive: true })
      writeFileSync(join(infraRoot, '.sst', 'log', 'sst.log'), `${sentinel}\n`)

      try {
        const result = failingSstInvocation({
          functionName: 'runBootstrapSst',
          args,
          infraRoot,
          label: `${operation} synthetic SST secret`,
        })
        const output = `${result.stdout}${result.stderr}`

        assert.equal(result.status, 1)
        assert.match(output, /nonsecret.*only install|secret mutation|secret-sensitive/i)
        assert.doesNotMatch(output, new RegExp(sentinel))
      } finally {
        rmSync(infraRoot, { recursive: true, force: true })
      }
    })
  }
}

test('nonsecret SST failure retains the useful planted diagnostic tail', () => {
  const infraRoot = mkdtempSync(join(tmpdir(), 'boxlite-bootstrap-nonsecret-log-'))
  const diagnostic = 'planted nonsecret SST installation diagnostic'
  mkdirSync(join(infraRoot, '.sst', 'log'), { recursive: true })
  writeFileSync(join(infraRoot, '.sst', 'log', 'sst.log'), `${diagnostic}\n`)

  try {
    const result = failingSstInvocation({
      functionName: 'runBootstrapSst',
      args: ['install', '--stage', 'dev'],
      infraRoot,
      label: 'install the SST platform',
    })
    const output = `${result.stdout}${result.stderr}`

    assert.equal(result.status, 1)
    assert.match(output, /could not install the SST platform/)
    assert.match(output, new RegExp(diagnostic))
  } finally {
    rmSync(infraRoot, { recursive: true, force: true })
  }
})
