// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const SCRIPTS_DIRECTORY = new URL('.', import.meta.url)
const INFRA_DIRECTORY = new URL('..', import.meta.url)

async function bootstrapFileModule() {
  return import('./bootstrap-environment-file.mjs')
}

function withEnvironmentFile(source, callback) {
  const directory = mkdtempSync(join(tmpdir(), 'boxlite-bootstrap-environment-'))
  const path = join(directory, '.env')
  writeFileSync(path, source)
  try {
    return callback(path)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('loads bootstrap dotenv with deterministic keys and shell-over-file precedence', async () => {
  const { loadBootstrapEnvironment } = await bootstrapFileModule()
  const environment = { AWS_REGION: 'eu-west-1' }

  withEnvironmentFile(
    'STACK_DOMAIN=dev.example.test\nAWS_REGION=ap-southeast-1\nOIDC_AUDIENCE=boxlite-api\n',
    (path) => {
      const loaded = loadBootstrapEnvironment({ path, environment })
      assert.equal(loaded.environment, environment)
      assert.deepEqual(loaded.configuredKeys, ['AWS_REGION', 'OIDC_AUDIENCE', 'STACK_DOMAIN'])
      assert.equal(environment.AWS_REGION, 'eu-west-1')
      assert.equal(environment.STACK_DOMAIN, 'dev.example.test')
      assert.equal(environment.OIDC_AUDIENCE, 'boxlite-api')
    },
  )
})

test('resolves an explicit bootstrap env file from the caller without changing the default', async () => {
  const { resolveBootstrapEnvironmentPath } = await bootstrapFileModule()
  const cwd = join(tmpdir(), 'boxlite-operator')
  const defaultPath = join(tmpdir(), 'boxlite-worktree', 'apps', 'infra', '.env')

  assert.equal(resolveBootstrapEnvironmentPath({ args: [], cwd, defaultPath }), defaultPath)
  assert.equal(
    resolveBootstrapEnvironmentPath({ args: ['--env-file', '../boxlite3/apps/infra/.env'], cwd, defaultPath }),
    resolve(cwd, '../boxlite3/apps/infra/.env'),
  )
  assert.equal(
    resolveBootstrapEnvironmentPath({ args: [`--env-file=${defaultPath}`], cwd, defaultPath }),
    defaultPath,
  )
  assert.throws(
    () => resolveBootstrapEnvironmentPath({ args: ['--env-file', '--stage', 'dev'], cwd, defaultPath }),
    /--env-file requires a value/,
  )
  assert.throws(
    () =>
      resolveBootstrapEnvironmentPath({
        args: ['--env-file', 'first.env', '--env-file=second.env'],
        cwd,
        defaultPath,
      }),
    /--env-file may be specified only once/,
  )
})

test('rejects unknown, duplicate, and incomplete bootstrap arguments without echoing values', async () => {
  const { validateBootstrapArguments } = await bootstrapFileModule()

  assert.doesNotThrow(() =>
    validateBootstrapArguments([
      '--stage=dev',
      '--repo',
      'boxlite-ai/boxlite',
      '--reviewers=123,456',
      '--env-file',
      '/operator/boxlite.env',
      '--force',
      '--provision-auth0',
    ]),
  )
  assert.throws(() => validateBootstrapArguments(['--stgae', 'prod']), /unknown bootstrap argument --stgae/)
  assert.throws(() => validateBootstrapArguments(['--env-fiel=/sentinel/secret/path']), (error) => {
    assert.match(error.message, /unknown bootstrap argument --env-fiel/)
    assert.equal(error.message.includes('/sentinel/secret/path'), false)
    return true
  })
  assert.throws(() => validateBootstrapArguments(['--stage', 'dev', '--stage=prod']), /only once/)
  assert.throws(() => validateBootstrapArguments(['--repo', '--force']), /--repo requires a value/)
  assert.throws(() => validateBootstrapArguments(['unexpected-position']), /unexpected positional argument/)
})

test('rejects malformed or duplicate dotenv assignments without echoing their values', async () => {
  const { loadBootstrapEnvironment } = await bootstrapFileModule()
  const fixtures = [
    'export STACK_DOMAIN=sentinel-malformed-value\n',
    'STACK_DOMAIN : sentinel-malformed-value\n',
    'STACK_DOMAIN=first.example.test\nSTACK_DOMAIN=sentinel-duplicate-value\n',
  ]

  for (const source of fixtures) {
    withEnvironmentFile(source, (path) => {
      assert.throws(
        () => loadBootstrapEnvironment({ path, environment: {} }),
        (error) => {
          assert.match(error.message, /assignment|duplicate|dotenv/i)
          assert.equal(error.message.includes('sentinel-malformed-value'), false)
          assert.equal(error.message.includes('sentinel-duplicate-value'), false)
          return true
        },
      )
    })
  }
})

test('rejects a conflicting ambient SST stage at the bootstrap boundary', async () => {
  const { validateBootstrapStageSelection } = await import('./bootstrap-environment.mjs')

  assert.equal(validateBootstrapStageSelection('dev', {}), 'dev')
  assert.equal(validateBootstrapStageSelection('dev', { SST_STAGE: 'dev' }), 'dev')
  assert.throws(
    () => validateBootstrapStageSelection('dev', { SST_STAGE: 'prod' }),
    /ambient SST_STAGE conflicts with the selected bootstrap stage/,
  )
})

test('dotenv is imported only by the bootstrap file boundary', () => {
  const productionScripts = readdirSync(SCRIPTS_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs'))
    .map((entry) => ({ name: entry.name, source: readFileSync(new URL(entry.name, SCRIPTS_DIRECTORY), 'utf8') }))
  const dotenvImports = productionScripts
    .filter(({ source }) => /from ['"]dotenv['"]|require\(['"]dotenv['"]\)/.test(source))
    .map(({ name }) => name)
    .sort()

  assert.deepEqual(dotenvImports, ['bootstrap-environment-file.mjs'])

  const routineConsumers = [
    'deployment-environment.mjs',
    'runner-artifact-build.mjs',
    'sst-with-cloudflare.mjs',
    'verify-deploy-role-boundary.mjs',
  ]
  for (const name of routineConsumers) {
    const source = productionScripts.find((candidate) => candidate.name === name)?.source
    assert.ok(source, `${name} is missing`)
    assert.doesNotMatch(source, /loadDeploymentEnvironment|loadBootstrapEnvironment/, `${name} must not load dotenv`)
  }
  assert.doesNotMatch(
    readFileSync(new URL('sst.config.ts', INFRA_DIRECTORY), 'utf8'),
    /loadDeploymentEnvironment|from ['"]dotenv(?:\/config)?['"]|import\(['"]dotenv(?:\/config)?['"]\)/,
  )
})

test('bootstrap publishes the release and no longer uploads DEPLOY_ENV', () => {
  const bootstrapPath = new URL('bootstrap-environment.mjs', SCRIPTS_DIRECTORY)
  const source = readFileSync(bootstrapPath, 'utf8')

  assert.match(source, /loadBootstrapEnvironment/)
  assert.match(source, /validateBootstrapArguments/)
  assert.match(source, /DeploymentConfigStore/)
  assert.match(source, /\.prepare\(/)
  assert.match(source, /\.activate\(/)
  assert.doesNotMatch(source, /\.publish\(/)
  assert.doesNotMatch(source, /DEPLOY_ENV/)
  assert.doesNotMatch(source, /ghSecretSetFromFile/)

  const mainSource = source.slice(source.indexOf('async function main()'))
  const argumentValidation = mainSource.indexOf('validateBootstrapArguments(args)')
  const environmentRead = mainSource.indexOf('loadBootstrapEnvironment(')
  const runtimeSeedValidation = mainSource.indexOf('resolveRuntimeSecretSeedValues(process.env)')
  const bootstrapStageValidation = mainSource.indexOf('validateDeploymentConfigStage(stage)')
  const stageSelectionValidation = mainSource.indexOf('validateBootstrapStageSelection(stage)')
  const deployRolePlan = mainSource.indexOf('githubDeployRoleStackName(stage)')
  const preflightDocumentValidation = mainSource.indexOf(
    'const deploymentConfigPreflightDocument = createDeploymentConfigDocument({',
  )
  const preflightDocumentCanonicalization = mainSource.indexOf(
    'canonicalizeDeploymentConfig(deploymentConfigPreflightDocument)',
  )
  const documentValidation = mainSource.indexOf(
    'const deploymentConfigDocument = createDeploymentConfigDocument({',
  )
  const documentCanonicalization = mainSource.indexOf('canonicalizeDeploymentConfig(deploymentConfigDocument)')
  const runtimeSecretPlan = mainSource.indexOf('const runtimeSecretPlan = planRuntimeSecrets({')
  const platformInstall = mainSource.indexOf('ensureSstPlatform(stage)')
  const runnerGateRead = mainSource.indexOf('const runnerCommandTagGateEnabled = await resolveRunnerCommandTagGate({')
  const releaseCommit = mainSource.indexOf('commitBootstrapConfigRelease({')
  const githubWiring = mainSource.indexOf('wireGithubEnvironment({')
  const mainRuntimeApplyCallback = mainSource.indexOf('applyRuntimeSecrets() {')
  const firstMutation = mainSource.indexOf('ensureGitHubOidcProvider(')
  assert.ok(argumentValidation !== -1 && argumentValidation < environmentRead)
  assert.ok(
    runtimeSeedValidation !== -1 && runtimeSeedValidation < firstMutation,
    'runtime secret seed validation must finish before the first GitHub/AWS mutation',
  )
  assert.ok(
    preflightDocumentValidation !== -1 &&
      preflightDocumentValidation < preflightDocumentCanonicalization &&
      preflightDocumentCanonicalization < runtimeSecretPlan &&
      runtimeSecretPlan < documentValidation &&
      documentValidation < documentCanonicalization &&
      documentCanonicalization < firstMutation,
    'typed bootstrap input, runtime secret refusal checks, and final release size must be validated before mutation',
  )
  assert.ok(
    platformInstall !== -1 && platformInstall < runnerGateRead && runnerGateRead < firstMutation,
    'live CloudFormation, SST state, and EC2 gate reads must finish before the first GitHub/AWS mutation',
  )
  assert.ok(
    releaseCommit < githubWiring && githubWiring < mainRuntimeApplyCallback,
    'GitHub wiring must succeed inside the commit prerequisite before runtime mutation and pointer activation',
  )
  const commitSource = source.slice(
    source.indexOf('export function commitBootstrapConfigRelease('),
    source.indexOf('async function main()'),
  )
  const releasePrepare = commitSource.indexOf('deploymentConfigStore.prepare(')
  const bootstrapPolicyCallback = commitSource.indexOf('deployBootstrapPolicy()')
  const runtimeApplyCallback = commitSource.indexOf('applyRuntimeSecrets()')
  const releaseActivate = commitSource.indexOf('deploymentConfigStore.activate(')
  assert.ok(
    releasePrepare !== -1 &&
      releasePrepare < bootstrapPolicyCallback &&
      bootstrapPolicyCallback < runtimeApplyCallback &&
      runtimeApplyCallback < releaseActivate,
    'the config commit boundary must verify immutable bytes, finish policy/wiring, apply secrets, and activate current last',
  )
  assert.doesNotMatch(mainSource, /ensureRuntimeSecrets\(/)
  assert.ok(
    bootstrapStageValidation !== -1 && bootstrapStageValidation < firstMutation,
    'the bounded lowercase stage contract must be validated before the first GitHub/AWS mutation',
  )
  assert.ok(
    stageSelectionValidation !== -1 && stageSelectionValidation < firstMutation,
    'ambient and explicit stage selection must agree before the first GitHub/AWS mutation',
  )
  assert.ok(
    deployRolePlan !== -1 && deployRolePlan < firstMutation,
    'the CloudFormation-compatible stage must be validated before the first GitHub/AWS mutation',
  )
})
