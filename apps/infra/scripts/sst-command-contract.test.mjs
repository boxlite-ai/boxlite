// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const INFRA_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

async function commandModule() {
  return import('./sst-command-contract.mjs')
}

function waitForExit(child) {
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('timed out waiting for the SST wrapper to exit'))
    }, 10_000)
    timeout.unref()
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      resolveExit({ code, signal })
    })
  })
}

test('classifies the complete reviewed SST command matrix', async () => {
  const { classifySstCommand } = await commandModule()
  const cases = [
    ['diff', true, true, true, true],
    ['deploy', true, true, true, true],
    ['remove', true, true, false, true],
    ['refresh', true, true, false, true],
    ['shell', true, true, false, true],
    ['install', false, false, false, false],
    ['secret', false, false, false, false],
    ['unlock', false, false, false, false],
    ['version', false, false, false, false],
  ]

  for (const [
    subcommand,
    needsDeploymentConfig,
    needsProviderCredentials,
    needsStackPreflight,
    needsRunnerStateBaseline,
  ] of cases) {
    const args = subcommand === 'secret' ? ['secret', 'set', 'NAME', '--stage', 'dev'] : [subcommand, '--stage', 'dev']
    assert.deepEqual(classifySstCommand(args), {
      subcommand,
      needsDeploymentConfig,
      needsProviderCredentials,
      needsStackPreflight,
      needsRunnerStateBaseline,
    })
  }
})

test('denies dev, flag-first syntax, and every unknown SST command', async () => {
  const { classifySstCommand } = await commandModule()

  assert.throws(() => classifySstCommand(['dev', '--stage', 'dev']), /sst dev is disabled/i)
  assert.throws(() => classifySstCommand(['--stage', 'dev', 'deploy']), /subcommand must be the first/i)
  assert.throws(() => classifySstCommand(['synthetic-test', '--stage', 'dev']), /unknown|unsupported|reviewed/i)
  assert.throws(() => classifySstCommand(['secret', 'list', '--stage', 'dev']), /prints values|names-and-set-state/i)
  assert.throws(() => classifySstCommand(['secret', 'load', '.env', '--stage', 'dev']), /bulk|metadata/i)
  assert.throws(() => classifySstCommand(['secret', 'get', 'NAME', '--stage', 'dev']), /unknown|unsupported/i)
  assert.throws(() => classifySstCommand([]), /subcommand/i)
})

test('validates one stdin-only explicitly staged SST secret mutation grammar', async () => {
  const { validateSstSecretMutationArgs } = await commandModule()

  assert.deepEqual(validateSstSecretMutationArgs(['secret', 'set', 'OIDC_CLIENT_ID', '--stage=dev'], {}), {
    operation: 'set',
    name: 'OIDC_CLIENT_ID',
    stage: 'dev',
    confirmation: undefined,
    sstArgs: ['secret', 'set', 'OIDC_CLIENT_ID', '--stage', 'dev'],
  })
  assert.deepEqual(
    validateSstSecretMutationArgs(
      ['secret', 'remove', 'SSH_PRIVATE_KEY_B64', '--confirm', 'SSH_PRIVATE_KEY_B64', '--stage', 'dev'],
      { SST_STAGE: 'dev' },
    ),
    {
      operation: 'remove',
      name: 'SSH_PRIVATE_KEY_B64',
      stage: 'dev',
      confirmation: 'SSH_PRIVATE_KEY_B64',
      sstArgs: ['secret', 'remove', 'SSH_PRIVATE_KEY_B64', '--stage', 'dev'],
    },
  )

  const sentinel = 'synthetic-positional-secret-value-that-must-not-print'
  const rejected = [
    { args: ['secret', 'set', 'OIDC_CLIENT_ID'], environment: { SST_STAGE: 'dev' } },
    { args: ['secret', 'remove', 'OIDC_CLIENT_ID'], environment: {} },
    { args: ['secret', 'set', 'OIDC_CLIENT_ID', sentinel, '--stage', 'dev'], environment: {} },
    { args: ['secret', 'remove', 'OIDC_CLIENT_ID', sentinel, '--stage', 'dev'], environment: {} },
    { args: ['secret', 'set', 'OIDC_CLIENT_ID', '--fallback', '--stage', 'dev'], environment: {} },
    { args: ['secret', 'set', 'OIDC_CLIENT_ID', '--fallback=true', '--stage', 'dev'], environment: {} },
    { args: ['secret', 'remove', 'OIDC_CLIENT_ID', '--future-option', '--stage', 'dev'], environment: {} },
    { args: ['secret', 'set', 'OIDC_CLIENT_ID', '--stage', 'dev', '--stage=dev'], environment: {} },
    { args: ['secret', 'set', 'OIDC_CLIENT_ID', '--stage', 'dev'], environment: { SST_STAGE: 'prod' } },
  ]
  for (const { args, environment } of rejected) {
    assert.throws(
      () => validateSstSecretMutationArgs(args, environment),
      (error) => {
        assert.doesNotMatch(error.message, new RegExp(sentinel))
        return true
      },
    )
  }
})

test('sst install starts SST without reading deployment config or invoking AWS', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'boxlite-config-free-install-'))
  const fakeAws = join(fixture, 'aws')
  const fakeSst = join(fixture, 'sst')
  const awsMarker = join(fixture, 'aws-called')
  const sstCapture = join(fixture, 'sst.json')

  await writeFile(fakeAws, '#!/bin/sh\nprintf called >> "$SYNTHETIC_AWS_MARKER"\nexit 99\n', 'utf8')
  await writeFile(
    fakeSst,
    `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')
writeFileSync(process.env.SYNTHETIC_SST_CAPTURE, JSON.stringify({
  args: process.argv.slice(2),
  configRelease: process.env.BOXLITE_DEPLOY_CONFIG_RELEASE,
  installProviders: process.env.BOXLITE_SST_INSTALL_PROVIDERS,
  stackDomain: process.env.STACK_DOMAIN,
}))
`,
    'utf8',
  )
  await Promise.all([chmod(fakeAws, 0o755), chmod(fakeSst, 0o755)])

  const wrapper = spawn(process.execPath, ['scripts/sst-with-cloudflare.mjs', 'install', '--stage', 'ci'], {
    cwd: INFRA_ROOT,
    env: {
      PATH: process.env.PATH,
      AWS_CLI_PATH: fakeAws,
      AWS_REGION: 'ap-southeast-1',
      SST_BIN_PATH: fakeSst,
      BOXLITE_TEST_UNAUDITED_SST_BIN: '1',
      SYNTHETIC_AWS_MARKER: awsMarker,
      SYNTHETIC_SST_CAPTURE: sstCapture,
    },
    stdio: 'ignore',
  })

  try {
    assert.deepEqual(await waitForExit(wrapper), { code: 0, signal: null })
    assert.equal(existsSync(awsMarker), false, 'install must not resolve identity, config, or provider credentials')
    assert.deepEqual(JSON.parse(await readFile(sstCapture, 'utf8')), {
      args: ['install', '--stage', 'ci'],
      configRelease: '',
      installProviders: '1',
      stackDomain: '',
    })
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL')
    await rm(fixture, { recursive: true, force: true })
  }
})
