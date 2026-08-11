// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { canonicalizeDeploymentConfig, deploymentConfigReleaseId } from './deployment-config.mjs'
import {
  assertSstBaseEnvironmentIsClassified,
  AUDITED_SST_NATIVE_VERSION,
  AUDITED_SST_SOURCE_COMMIT,
  resolveSstConfigDirectory,
} from './sst-native-environment.mjs'

const INFRA_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const CONFIG_SOURCE = canonicalizeDeploymentConfig({
  accountId: '123456789012',
  region: 'ap-southeast-1',
  schemaVersion: 1,
  stage: 'ci',
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
    STACK_DOMAIN: 'ci.example.test',
  },
})
const CONFIG_RELEASE = deploymentConfigReleaseId(CONFIG_SOURCE)

function writeExecutable(path, source) {
  writeFileSync(path, source)
  chmodSync(path, 0o755)
}

test('pins the exact native SST build whose dotenv and fixed-log behavior was audited', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const packageLock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
  const locked = packageLock.packages['node_modules/sst']

  assert.equal(AUDITED_SST_SOURCE_COMMIT, 'c36553cf648fa0ec748197bae0ad5035000421a7')
  assert.equal(packageJson.devDependencies.sst, AUDITED_SST_NATIVE_VERSION)
  assert.equal(packageLock.packages[''].devDependencies.sst, AUDITED_SST_NATIVE_VERSION)
  assert.equal(locked.version, AUDITED_SST_NATIVE_VERSION)
  assert.equal(locked.resolved, `https://registry.npmjs.org/sst/-/sst-${AUDITED_SST_NATIVE_VERSION}.tgz`)
  assert.equal(locked.integrity, 'sha512-fepz1Xb8boDegv4mcgvZRmXQ7vObl09cX2e4cKrQiosZD3GeOC1MnMt08yyQcfOv12LcOI77/5+Hki9w2+6qGw==')
})

test('ignores application config arguments after the shell separator', () => {
  const workingDirectory = '/synthetic/infra'
  assert.equal(
    resolveSstConfigDirectory(
      [
        'shell',
        '--stage',
        'dev',
        '--config=deployment/sst.config.ts',
        '--',
        'node',
        'script.mjs',
        '--config',
        'application.json',
      ],
      workingDirectory,
    ),
    '/synthetic/infra/deployment',
  )
  assert.equal(
    resolveSstConfigDirectory(
      ['shell', '--stage', 'dev', '--', 'node', 'script.mjs', '--config=application.json'],
      workingDirectory,
    ),
    workingDirectory,
  )
})

test('native SST cannot reintroduce present ambient or base dotenv values on config-free install', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'boxlite-sst-native-load-'))
  const configDirectory = join(fixture, 'config')
  const configPath = join(configDirectory, 'sst.config.ts')
  const fakeSst = join(fixture, 'sst')
  const capture = join(fixture, 'capture.json')
  const sentinels = {
    release: 'ambient-release-secret-sentinel',
    runtime: 'ambient-runtime-secret-sentinel',
    provider: 'ambient-provider-secret-sentinel',
    obsolete: 'ambient-obsolete-secret-sentinel',
  }
  const nativeControlNames = [
    'CLOUDFLARE_API_KEY',
    'CLOUDFLARE_API_USER_SERVICE_KEY',
    'CLOUDFLARE_BASE_URL',
    'CLOUDFLARE_EMAIL',
    'CLOUDFLARE_USER_AGENT_OPERATOR_SUFFIX',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'https_proxy',
    'http_proxy',
    'all_proxy',
    'no_proxy',
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'AWS_CA_BUNDLE',
    'PULUMI_ACCESS_TOKEN',
    'PULUMI_BACKEND_URL',
    'PULUMI_CONFIG_PASSPHRASE',
    'PULUMI_CONFIG_PASSPHRASE_FILE',
    'PULUMI_DEBUG_GRPC',
    'PULUMI_HOME',
  ]
  const nativeAmbientControlNames = [
    'PULUMI_OPTION_SHOW_SECRETS',
    'PULUMI_DEBUG_PROVIDERS',
    'PULUMI_LANGUAGE_NODEJS_RUN_PATH',
    'AWS_ENDPOINT_URL_SSM',
    'AWS_SKIP_CREDENTIALS_VALIDATION',
    'SST_PULUMI_PATH',
    'SST_BUN_PATH',
    'SST_PRINT_LOGS',
  ]

  mkdirSync(configDirectory)
  writeFileSync(configPath, '// synthetic config\n')
  writeFileSync(
    join(configDirectory, '.env'),
    [
      'STACK_DOMAIN=base-dotenv-release-secret-sentinel',
      'ADMIN_API_KEY=base-dotenv-runtime-secret-sentinel',
      'CLOUDFLARE_API_TOKEN=base-dotenv-provider-secret-sentinel',
      'SSH_PRIVATE_KEY_B64=base-dotenv-obsolete-secret-sentinel',
      ...nativeControlNames.map((name) => `${name}=base-dotenv-native-control-secret-sentinel`),
      '',
    ].join('\n'),
  )
  writeExecutable(
    fakeSst,
    `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const args = process.argv.slice(2)
const stageIndex = args.indexOf('--stage')
const stage = stageIndex === -1 ? 'dev' : args[stageIndex + 1]
const load = (path, overload) => {
  let source
  try { source = readFileSync(path, 'utf8') } catch (error) { if (error.code === 'ENOENT') return; throw error }
  for (const line of source.split(/\\r?\\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (match && (overload || process.env[match[1]] === undefined)) process.env[match[1]] = match[2]
  }
}
// Faithful to pinned SST: project .env uses Load semantics, while .env.<stage>
// uses Overload. The separate guard test proves the latter never reaches SST.
load(join(process.env.SYNTHETIC_CONFIG_DIRECTORY, '.env'), false)
load(join(process.env.SYNTHETIC_CONFIG_DIRECTORY, '.env.' + stage), true)
writeFileSync(process.env.SYNTHETIC_CAPTURE, JSON.stringify({
  stackDomain: process.env.STACK_DOMAIN,
  runtime: process.env.ADMIN_API_KEY,
  provider: process.env.CLOUDFLARE_API_TOKEN,
  obsolete: process.env.SSH_PRIVATE_KEY_B64,
  nativeControls: Object.fromEntries(
    ${JSON.stringify(nativeControlNames)}.map((name) => [name, process.env[name]]),
  ),
  nativeAmbientControls: Object.fromEntries(
    ${JSON.stringify(nativeAmbientControlNames)}.map((name) => [name, process.env[name]]),
  ),
  version: process.env.VERSION,
  region: process.env.AWS_REGION,
  stage: process.env.SST_STAGE,
  sstLog: process.env.SST_LOG,
}))
`,
  )

  try {
    const result = spawnSync(
      process.execPath,
      ['scripts/sst-with-cloudflare.mjs', 'install', '--stage', 'ci', '--config', configPath],
      {
        cwd: INFRA_ROOT,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          SST_BIN_PATH: fakeSst,
          BOXLITE_TEST_UNAUDITED_SST_BIN: '1',
          STACK_DOMAIN: sentinels.release,
          ADMIN_API_KEY: sentinels.runtime,
          CLOUDFLARE_API_TOKEN: sentinels.provider,
          SSH_PRIVATE_KEY_B64: sentinels.obsolete,
          VERSION: '1.2.3',
          AWS_REGION: 'ap-southeast-1',
          SYNTHETIC_CAPTURE: capture,
          SYNTHETIC_CONFIG_DIRECTORY: configDirectory,
          ...Object.fromEntries(
            nativeAmbientControlNames.map((name) => [name, 'ambient-native-control-secret-sentinel']),
          ),
        },
      },
    )

    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), {
      stackDomain: '',
      runtime: '',
      provider: '',
      obsolete: '',
      nativeControls: Object.fromEntries(nativeControlNames.map((name) => [name, ''])),
      nativeAmbientControls: Object.fromEntries(nativeAmbientControlNames.map((name) => [name, ''])),
      version: '1.2.3',
      region: 'ap-southeast-1',
      stage: 'ci',
      sstLog: '/dev/null',
    })
    assert.doesNotMatch(`${result.stdout}${result.stderr}${readFileSync(capture, 'utf8')}`, /secret-sentinel/)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('rejects an unclassified base dotenv key before native SST can interpret it', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'boxlite-sst-native-unknown-env-'))
  const configPath = join(fixture, 'sst.config.ts')
  const fakeSst = join(fixture, 'sst')
  const marker = join(fixture, 'sst-called')
  writeFileSync(configPath, '// synthetic config\n')
  writeFileSync(join(fixture, '.env'), 'PULUMI_FUTURE_DEBUG_SINK=unknown-native-control-sentinel\n')
  writeExecutable(fakeSst, '#!/bin/sh\nprintf called > "$SYNTHETIC_SST_MARKER"\n')

  try {
    const result = spawnSync(
      process.execPath,
      ['scripts/sst-with-cloudflare.mjs', 'install', '--stage', 'ci', '--config', configPath],
      {
        cwd: INFRA_ROOT,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          SST_BIN_PATH: fakeSst,
          BOXLITE_TEST_UNAUDITED_SST_BIN: '1',
          SYNTHETIC_SST_MARKER: marker,
        },
      },
    )

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /unclassified|unsupported.*environment|bootstrap.*environment/i)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /unknown-native-control-sentinel/)
    assert.equal(existsSync(marker), false)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('audits both the native working-directory dotenv and an external config dotenv', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'boxlite-sst-native-two-root-load-'))
  const configDirectory = join(fixture, 'external-config')
  const configPath = join(configDirectory, 'sst.config.ts')
  mkdirSync(configDirectory)
  writeFileSync(configPath, '// synthetic config\n')
  writeFileSync(join(fixture, '.env'), 'PULUMI_FUTURE_DEBUG_SINK=working-directory-sentinel\n')

  try {
    assert.throws(
      () =>
        assertSstBaseEnvironmentIsClassified({
          args: ['install', '--stage', 'ci', '--config', configPath],
          workingDirectory: fixture,
          classifiedNames: new Set(),
        }),
      /unclassified key PULUMI_FUTURE_DEBUG_SINK/,
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('rejects the selected config directory stage dotenv before native install', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'boxlite-sst-stage-dotenv-install-'))
  const configPath = join(fixture, 'sst.config.ts')
  const fakeSst = join(fixture, 'sst')
  const marker = join(fixture, 'sst-called')
  writeFileSync(configPath, '// synthetic config\n')
  writeFileSync(join(fixture, '.env.ci'), 'STACK_DOMAIN=stage-override-secret-sentinel\n')
  writeExecutable(fakeSst, '#!/bin/sh\nprintf called > "$SYNTHETIC_SST_MARKER"\n')

  try {
    const result = spawnSync(
      process.execPath,
      ['scripts/sst-with-cloudflare.mjs', 'install', '--stage', 'ci', '--config', configPath],
      {
        cwd: INFRA_ROOT,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          SST_BIN_PATH: fakeSst,
          BOXLITE_TEST_UNAUDITED_SST_BIN: '1',
          SYNTHETIC_SST_MARKER: marker,
        },
      },
    )

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /\.env\.ci|stage.*environment/i)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /stage-override-secret-sentinel/)
    assert.equal(existsSync(marker), false)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('rejects a selected config stage dotenv before the internal state export', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'boxlite-sst-stage-dotenv-state-'))
  const configPath = join(fixture, 'sst.config.ts')
  const fakeSst = join(fixture, 'sst')
  const fakeAws = join(fixture, 'aws')
  const marker = join(fixture, 'sst-called')
  writeFileSync(configPath, '// synthetic config\n')
  writeFileSync(join(fixture, '.env.ci'), 'ADMIN_API_KEY=stage-override-secret-sentinel\n')
  writeExecutable(fakeSst, '#!/bin/sh\nprintf called > "$SYNTHETIC_SST_MARKER"\n')
  writeExecutable(
    fakeAws,
    `#!/usr/bin/env node
const args = process.argv.slice(2)
const option = (name) => args[args.indexOf(name) + 1]
if (args[0] === 'sts') {
  process.stdout.write(JSON.stringify({ Account: '123456789012' }))
} else if (args[0] === 'ssm' && option('--name').includes('/deploy-config/releases/')) {
  process.stdout.write(JSON.stringify({ Parameter: { Type: 'String', Value: process.env.SYNTHETIC_CONFIG_SOURCE } }))
} else if (args[0] === 'ssm') {
  process.stdout.write('synthetic-provider-value')
} else {
  process.exit(90)
}
`,
  )

  try {
    const result = spawnSync(
      process.execPath,
      ['scripts/sst-with-cloudflare.mjs', 'diff', '--stage', 'ci', '--config', configPath],
      {
        cwd: INFRA_ROOT,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          AWS_CLI_PATH: fakeAws,
          AWS_REGION: 'ap-southeast-1',
          BOXLITE_DEPLOY_CONFIG_RELEASE: CONFIG_RELEASE,
          SST_BIN_PATH: fakeSst,
          BOXLITE_TEST_UNAUDITED_SST_BIN: '1',
          SYNTHETIC_CONFIG_SOURCE: CONFIG_SOURCE,
          SYNTHETIC_SST_MARKER: marker,
        },
      },
    )

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /\.env\.ci|stage.*environment/i)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /stage-override-secret-sentinel/)
    assert.equal(existsSync(marker), false, 'state export must not run before the stage dotenv guard')
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('stage dotenv variants are ignored and the operator example remains tracked', () => {
  const ignoreSource = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8')
  assert.match(ignoreSource, /^\.env\.\*$/m)
  assert.match(ignoreSource, /^!\.env\.example$/m)
})
