// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { canonicalizeDeploymentConfig, deploymentConfigReleaseId } from './deployment-config.mjs'

const INFRA_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const CONFIG_SOURCE = canonicalizeDeploymentConfig({
  accountId: '123456789012',
  region: 'ap-southeast-1',
  schemaVersion: 1,
  stage: 'dev',
  values: {
    BOXLITE_RUNTIME_SECRET_GENERATIONS: {
      adminApiKey: 'generated-pending',
      clickHouseReaderPassword: 'generated-pending',
      clickHouseWriterPassword: 'generated-pending',
      defaultRunnerApiKey: 'generated-pending',
      encryptionKey: 'generated-pending',
      encryptionSalt: 'generated-pending',
      ghcrPullToken: 'generated-pending',
      otelCollectorApiKey: 'generated-pending',
      otelExporterOtlpHeaders: 'generated-pending',
      pgAdminDefaultPassword: 'generated-pending',
      proxyApiKey: 'generated-pending',
    },
    OIDC_AUDIENCE: 'boxlite-api',
    OIDC_ISSUER_BASE_URL: 'https://auth.example.test/',
    STACK_DOMAIN: 'dev.example.test',
  },
})
const CONFIG_RELEASE = deploymentConfigReleaseId(CONFIG_SOURCE)

test('remove, refresh, and shell load one Runner baseline and exact stage Cloudflare credentials', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'boxlite-cloudflare-provider-credentials-'))
  const fakeAws = join(fixture, 'aws')
  const fakeSst = join(fixture, 'sst')
  const awsCalls = join(fixture, 'aws-calls.jsonl')
  const sstCapture = join(fixture, 'sst-capture.json')
  const sstCalls = join(fixture, 'sst-calls.jsonl')
  const operationLock = join(fixture, 'deployment-operation-lock')
  const sstConfigDirectory = join(fixture, 'sst-config')
  const sstConfigPath = join(sstConfigDirectory, 'sst.config.ts')
  const applicationConfigDirectory = join(fixture, 'application-config')
  const applicationConfigPath = join(applicationConfigDirectory, 'application.json')
  const ambientToken = 'ambient-cloudflare-token-that-must-not-win'
  const ambientAccount = 'ambient-cloudflare-account-that-must-not-win'
  const ssmToken = 'ssm-cloudflare-token'
  const ssmAccount = 'ssm-cloudflare-account'
  const applicationEnvironmentSentinel = 'application-config-environment-sentinel'

  mkdirSync(sstConfigDirectory)
  mkdirSync(applicationConfigDirectory)
  writeFileSync(sstConfigPath, '// synthetic SST config\n')
  writeFileSync(applicationConfigPath, '{}\n')
  writeFileSync(join(applicationConfigDirectory, '.env'), `UNCLASSIFIED_APP_KEY=${applicationEnvironmentSentinel}\n`)
  writeFileSync(join(applicationConfigDirectory, '.env.dev'), `STACK_DOMAIN=${applicationEnvironmentSentinel}\n`)
  writeFileSync(join(applicationConfigDirectory, '.env.production'), `STACK_DOMAIN=${applicationEnvironmentSentinel}\n`)

  writeFileSync(
    fakeAws,
    `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
const option = (name) => args[args.indexOf(name) + 1]
appendFileSync(process.env.SYNTHETIC_AWS_CALLS, JSON.stringify(args) + '\\n')
if (args[0] === 'sts' && args[1] === 'get-caller-identity') {
  process.stdout.write(JSON.stringify({ Account: '123456789012', Arn: 'arn:aws:sts::123456789012:assumed-role/test/run' }))
} else if (args[0] === 'ssm' && args[1] === 'put-parameter' && option('--name').endsWith('/deployment-operation-lock')) {
  try {
    writeFileSync(process.env.SYNTHETIC_OPERATION_LOCK, readFileSync(0, 'utf8'), { flag: 'wx' })
    process.stdout.write(JSON.stringify({ Version: 1 }))
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    process.stderr.write('ParameterAlreadyExists')
    process.exit(254)
  }
} else if (args[0] === 'ssm' && args[1] === 'delete-parameter' && option('--name').endsWith('/deployment-operation-lock')) {
  unlinkSync(process.env.SYNTHETIC_OPERATION_LOCK)
  process.stdout.write('{}')
} else if (args[0] === 'ssm' && args[1] === 'get-parameter') {
  const name = option('--name')
  if (name.includes('/deploy-config/releases/')) {
    process.stdout.write(JSON.stringify({ Parameter: { Type: 'String', Value: process.env.SYNTHETIC_CONFIG_SOURCE } }))
  } else if (name.endsWith('/deployment-operation-lock') && existsSync(process.env.SYNTHETIC_OPERATION_LOCK)) {
    process.stdout.write(JSON.stringify({ Parameter: { Type: 'String', Value: readFileSync(process.env.SYNTHETIC_OPERATION_LOCK, 'utf8') } }))
  } else if (name === '/boxlite/dev/cloudflare-api-token') {
    process.stdout.write(process.env.SYNTHETIC_SSM_TOKEN)
  } else if (name === '/boxlite/dev/cloudflare-account-id') {
    process.stdout.write(process.env.SYNTHETIC_SSM_ACCOUNT)
  } else {
    process.exit(91)
  }
} else if (args[0] === 'secretsmanager' && args[1] === 'describe-secret') {
  process.stdout.write(JSON.stringify({
    Tags: [
      { Key: 'boxlite:initial-value', Value: 'generated' },
      { Key: 'boxlite:initialization', Value: 'pending' },
    ],
    VersionIdsToStages: {},
  }))
} else {
  process.exit(92)
}
`,
  )
  writeFileSync(
    fakeSst,
    `#!/usr/bin/env node
const { appendFileSync, existsSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.SYNTHETIC_SST_CALLS, JSON.stringify(args) + '\\n')
if (args[0] === 'state' && args[1] === 'export') {
  process.stdout.write(JSON.stringify({
    stack: 'dev',
    latest: {
      resources: [{
        urn: 'urn:pulumi:dev::boxlite::aws:ec2/instance:Instance::Runner',
        type: 'aws:ec2/instance:Instance',
        custom: true,
        id: 'i-00000000000000001',
        inputs: {
          tags: { Name: 'boxlite-runner-default' },
          tagsAll: { Name: 'boxlite-runner-default' },
        },
        provider: 'urn:pulumi:dev::boxlite::pulumi:providers:aws::AwsProvider::provider-id',
        protect: true,
        ignoreChanges: ['ami', 'userDataBase64'],
      }],
    },
  }))
  process.exit(0)
}
writeFileSync(process.env.SYNTHETIC_SST_CAPTURE, JSON.stringify({
  args,
  token: process.env.CLOUDFLARE_API_TOKEN,
  account: process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID,
  stage: process.env.SST_STAGE,
  sstLog: process.env.SST_LOG,
  sstPulumiPath: process.env.SST_PULUMI_PATH,
  sstBunPath: process.env.SST_BUN_PATH,
  deployScope: process.env.BOXLITE_DEPLOY_SCOPE,
  runnerStateBaseline: process.env.BOXLITE_RUNNER_STATE_BASELINE,
  operationLockHeld: existsSync(process.env.SYNTHETIC_OPERATION_LOCK),
}))
`,
  )
  chmodSync(fakeAws, 0o755)
  chmodSync(fakeSst, 0o755)

  try {
    for (const subcommand of ['remove', 'refresh', 'shell']) {
      const sstArgs =
        subcommand === 'shell'
          ? [
              subcommand,
              '--stage',
              'dev',
              '--config',
              sstConfigPath,
              '--',
              'node',
              'script.mjs',
              '--stage=production',
              '--config',
              applicationConfigPath,
              '--exclude',
              'Runner',
              '--target=Api',
            ]
          : [subcommand, '--stage', 'dev']
      const result = spawnSync(process.execPath, ['scripts/sst-with-cloudflare.mjs', ...sstArgs], {
        cwd: INFRA_ROOT,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          AWS_CLI_PATH: fakeAws,
          AWS_REGION: 'ap-southeast-1',
          BOXLITE_DEPLOY_CONFIG_RELEASE: CONFIG_RELEASE,
          CLOUDFLARE_API_TOKEN: ambientToken,
          CLOUDFLARE_DEFAULT_ACCOUNT_ID: ambientAccount,
          SST_PULUMI_PATH: '/synthetic/attacker-pulumi',
          SST_BUN_PATH: '/synthetic/attacker-bun',
          SST_BIN_PATH: fakeSst,
          BOXLITE_TEST_UNAUDITED_SST_BIN: '1',
          SYNTHETIC_AWS_CALLS: awsCalls,
          SYNTHETIC_CONFIG_SOURCE: CONFIG_SOURCE,
          SYNTHETIC_OPERATION_LOCK: operationLock,
          SYNTHETIC_SSM_ACCOUNT: ssmAccount,
          SYNTHETIC_SSM_TOKEN: ssmToken,
          SYNTHETIC_SST_CALLS: sstCalls,
          SYNTHETIC_SST_CAPTURE: sstCapture,
        },
      })

      assert.equal(result.status, 0, result.stderr)
      const capture = JSON.parse(readFileSync(sstCapture, 'utf8'))
      const { runnerStateBaseline, ...nativeSstCapture } = capture
      assert.deepEqual(nativeSstCapture, {
        args: sstArgs,
        token: ssmToken,
        account: ssmAccount,
        stage: 'dev',
        sstLog: '/dev/null',
        sstPulumiPath: '',
        sstBunPath: '',
        deployScope: 'api,runner',
        operationLockHeld: true,
      })
      const baseline = JSON.parse(runnerStateBaseline)
      assert.equal(baseline.version, 4)
      assert.equal(baseline.stage, 'dev')
      assert.equal(baseline.resources.Runner.instanceId, 'i-00000000000000001')
      for (const fingerprint of [
        baseline.resources.Runner.inputFingerprint,
        baseline.resources.Runner.identityFingerprint,
        baseline.resources.Runner.profileMigrationFingerprint,
      ]) {
        assert.match(fingerprint, /^sha256:[0-9a-f]{64}$/)
      }
      assert.equal(existsSync(operationLock), false, 'the wrapper must release the operation lock after native SST exits')
      assert.doesNotMatch(
        `${result.stdout}${result.stderr}${JSON.stringify(capture)}`,
        new RegExp(`${ambientToken}|${ambientAccount}|${applicationEnvironmentSentinel}`),
      )
    }
    const nativeCalls = readFileSync(sstCalls, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(nativeCalls, [
      ['state', 'export', '--stage', 'dev', '--print-logs'],
      ['remove', '--stage', 'dev'],
      ['state', 'export', '--stage', 'dev', '--print-logs'],
      ['refresh', '--stage', 'dev'],
      ['state', 'export', '--stage', 'dev', '--print-logs', '--config', sstConfigPath],
      [
        'shell',
        '--stage',
        'dev',
        '--config',
        sstConfigPath,
        '--',
        'node',
        'script.mjs',
        '--stage=production',
        '--config',
        applicationConfigPath,
        '--exclude',
        'Runner',
        '--target=Api',
      ],
    ])
    const calls = readFileSync(awsCalls, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const parameterNames = calls
      .filter((args) => args[0] === 'ssm' && args[1] === 'get-parameter')
      .map((args) => args[args.indexOf('--name') + 1])
    assert.deepEqual(
      parameterNames.filter((name) => name.includes('/cloudflare-')),
      ['remove', 'refresh', 'shell'].flatMap(() => [
        '/boxlite/dev/cloudflare-api-token',
        '/boxlite/dev/cloudflare-account-id',
      ]),
    )
    assert.equal(existsSync(operationLock), false, 'successful stack evaluation must release its operation lock')
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('stack evaluation fails closed when an authoritative Cloudflare parameter is unavailable', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'boxlite-cloudflare-provider-missing-'))
  const fakeAws = join(fixture, 'aws')
  const fakeSst = join(fixture, 'sst')
  const sstMarker = join(fixture, 'sst-called')
  const operationLock = join(fixture, 'deployment-operation-lock')
  const ambientSentinel = 'ambient-cloudflare-secret-sentinel-that-must-not-fallback'
  const outputSentinel = 'captured-aws-secret-sentinel-that-must-not-print'

  writeFileSync(
    fakeAws,
    `#!/usr/bin/env node
const { existsSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
const option = (name) => args[args.indexOf(name) + 1]
if (args[0] === 'sts') {
  process.stdout.write(JSON.stringify({ Account: '123456789012' }))
} else if (args[0] === 'ssm' && args[1] === 'put-parameter' && option('--name').endsWith('/deployment-operation-lock')) {
  try {
    writeFileSync(process.env.SYNTHETIC_OPERATION_LOCK, readFileSync(0, 'utf8'), { flag: 'wx' })
    process.stdout.write(JSON.stringify({ Version: 1 }))
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    process.stderr.write('ParameterAlreadyExists')
    process.exit(254)
  }
} else if (args[0] === 'ssm' && args[1] === 'delete-parameter' && option('--name').endsWith('/deployment-operation-lock')) {
  unlinkSync(process.env.SYNTHETIC_OPERATION_LOCK)
  process.stdout.write('{}')
} else if (args[0] === 'ssm' && option('--name').includes('/deploy-config/releases/')) {
  process.stdout.write(JSON.stringify({ Parameter: { Type: 'String', Value: process.env.SYNTHETIC_CONFIG_SOURCE } }))
} else if (args[0] === 'ssm' && option('--name').endsWith('/deployment-operation-lock') && existsSync(process.env.SYNTHETIC_OPERATION_LOCK)) {
  process.stdout.write(JSON.stringify({ Parameter: { Type: 'String', Value: readFileSync(process.env.SYNTHETIC_OPERATION_LOCK, 'utf8') } }))
} else if (args[0] === 'secretsmanager' && args[1] === 'describe-secret') {
  process.stdout.write(JSON.stringify({
    Tags: [
      { Key: 'boxlite:initial-value', Value: 'generated' },
      { Key: 'boxlite:initialization', Value: 'pending' },
    ],
    VersionIdsToStages: {},
  }))
} else if (args[0] === 'ssm') {
  process.stderr.write(process.env.SYNTHETIC_OUTPUT_SENTINEL)
  process.exit(44)
} else {
  process.exit(90)
}
`,
  )
  writeFileSync(fakeSst, '#!/bin/sh\nprintf called > "$SYNTHETIC_SST_MARKER"\n')
  chmodSync(fakeAws, 0o755)
  chmodSync(fakeSst, 0o755)

  try {
    const result = spawnSync(process.execPath, ['scripts/sst-with-cloudflare.mjs', 'remove', '--stage', 'dev'], {
      cwd: INFRA_ROOT,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        AWS_CLI_PATH: fakeAws,
        AWS_REGION: 'ap-southeast-1',
        BOXLITE_DEPLOY_CONFIG_RELEASE: CONFIG_RELEASE,
        CLOUDFLARE_API_TOKEN: ambientSentinel,
        CLOUDFLARE_DEFAULT_ACCOUNT_ID: ambientSentinel,
        SST_BIN_PATH: fakeSst,
        BOXLITE_TEST_UNAUDITED_SST_BIN: '1',
        SYNTHETIC_CONFIG_SOURCE: CONFIG_SOURCE,
        SYNTHETIC_OPERATION_LOCK: operationLock,
        SYNTHETIC_OUTPUT_SENTINEL: outputSentinel,
        SYNTHETIC_SST_MARKER: sstMarker,
      },
    })

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /\/boxlite\/dev\/cloudflare-api-token/)
    assert.equal(`${result.stdout}${result.stderr}`.includes(ambientSentinel), false)
    assert.equal(`${result.stdout}${result.stderr}`.includes(outputSentinel), false)
    assert.equal(existsSync(sstMarker), false)
    assert.equal(existsSync(operationLock), false, 'provider preflight failure must release the operation lock')
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
