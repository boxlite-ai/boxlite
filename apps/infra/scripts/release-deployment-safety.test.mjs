// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { DEFAULT_SCHEMA, Type, load } from 'js-yaml'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SST_WRAPPER = join(REPO_ROOT, 'apps/infra/scripts/sst-with-cloudflare.mjs')
const RUNNER_POLICY_PROJECT = join(REPO_ROOT, 'apps/infra/PulumiPolicy.yaml')
const RUNNER_POLICY_ENTRY = join(REPO_ROOT, 'apps/infra/policies/runner/index.js')
const RUNNER_POLICY_DEFINITIONS = join(REPO_ROOT, 'apps/infra/policies/runner/definitions.cjs')
const DEV_DEPLOY_WORKFLOW = join(REPO_ROOT, '.github/workflows/deploy-dev-api.yml')
const LINT_WORKFLOW = join(REPO_ROOT, '.github/workflows/lint.yml')
const DEV_DEPLOY_ROLE = join(REPO_ROOT, 'apps/infra/ci/github-deploy-role.yaml')
const CLOUDFORMATION_SCHEMA = DEFAULT_SCHEMA.extend([
  new Type('!Sub', {
    kind: 'scalar',
    construct: (value) => value,
  }),
  new Type('!Ref', {
    kind: 'scalar',
    construct: (value) => value,
  }),
  new Type('!GetAtt', {
    kind: 'scalar',
    construct: (value) => value,
  }),
])
const requireFromTest = createRequire(import.meta.url)

function readRuntimeBoundaryStatements() {
  const template = load(readFileSync(DEV_DEPLOY_ROLE, 'utf8'), { schema: CLOUDFORMATION_SCHEMA })
  return template.Resources.BoxLiteRuntimePermissionsBoundary.Properties.PolicyDocument.Statement
}

function findStatement(statements, sid) {
  const statement = statements.find((candidate) => candidate.Sid === sid)
  assert.ok(statement, `missing ${sid} statement`)
  return statement
}

test('SST deploy verifies Runner release assets before invoking SST', () => {
  const source = readFileSync(SST_WRAPPER, 'utf8')
  const preflightIndex = source.indexOf('await verifyRunnerReleaseAssets(')
  const sstIndex = source.indexOf('await withPulumiEventLogCleanup(')

  assert.match(source, /import \{ verifyRunnerReleaseAssets \} from '\.\/runner-release-assets\.mjs'/)
  assert.notEqual(preflightIndex, -1, 'the Runner release preflight is missing')
  assert.notEqual(sstIndex, -1, 'the guarded SST invocation is missing')
  assert.ok(preflightIndex < sstIndex, 'SST may run before Runner release availability is known')
  assert.doesNotMatch(source, /isSstComponentExcluded/)
  assert.match(source, /requireFullStackDeploy\(sstArgs\)/)
  assert.match(source, /withRequiredRunnerPolicy\(sstArgs\)/)
  assert.doesNotMatch(source, /RUNNER_POLICY_ROOT/)
})

test('preview and deploy use the mandatory local Runner policy', () => {
  assert.ok(existsSync(RUNNER_POLICY_PROJECT), 'PulumiPolicy.yaml is missing')
  assert.ok(existsSync(RUNNER_POLICY_ENTRY), 'the Runner policy entry point is missing')
  assert.ok(existsSync(RUNNER_POLICY_DEFINITIONS), 'the Runner policy definitions are missing')
  assert.deepEqual(load(readFileSync(RUNNER_POLICY_PROJECT, 'utf8')), {
    runtime: 'nodejs',
    main: 'policies/runner/index.js',
    description: 'Mandatory BoxLite Runner lifecycle and identity policy',
  })

  const policySource = readFileSync(RUNNER_POLICY_ENTRY, 'utf8')
  const policyDefinitions = readFileSync(RUNNER_POLICY_DEFINITIONS, 'utf8')
  assert.match(policySource, /new PolicyPack\('boxlite-runner-safety'/)
  assert.match(policySource, /serializedRunnerStateBaseline = process\.env\.BOXLITE_RUNNER_STATE_BASELINE/)
  assert.match(policySource, /parseRunnerStateBaseline\(serializedRunnerStateBaseline\)/)
  assert.match(policySource, /policies: createRunnerPolicies\(runnerInventory, runnerStateBaseline\)/)
  assert.equal(policyDefinitions.match(/enforcementLevel: 'mandatory'/g)?.length, 2)

  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'apps/infra/package.json'), 'utf8'))
  const packageLock = JSON.parse(readFileSync(join(REPO_ROOT, 'apps/infra/package-lock.json'), 'utf8'))
  assert.equal(packageJson.main, 'policies/runner/index.js')
  assert.ok(existsSync(join(REPO_ROOT, 'apps/infra', packageJson.main)), 'the Node policy entry point is missing')
  assert.equal(requireFromTest.resolve(join(REPO_ROOT, 'apps/infra')), RUNNER_POLICY_ENTRY)
  assert.equal(packageJson.devDependencies['@pulumi/policy'], '1.21.0')
  assert.equal(packageLock.packages[''].devDependencies['@pulumi/policy'], '1.21.0')
})

test('SST deploy does not depend on a laptop-managed remote builder', () => {
  const source = readFileSync(SST_WRAPPER, 'utf8')
  const packageSource = readFileSync(join(REPO_ROOT, 'apps/infra/package.json'), 'utf8')

  assert.doesNotMatch(source, /RemoteAmd64Builder/)
  assert.doesNotMatch(source, /BUILDX_BUILDER/)
  assert.doesNotMatch(packageSource, /builder:(?:provision|start|status|stop)/)
  for (const legacyPath of [
    'apps/infra/scripts/buildx-builder.mjs',
    'apps/infra/scripts/buildx-builder-cli.mjs',
    'apps/infra/buildkit/amd64-builder.yaml',
    'apps/infra/buildkit/buildkitd.toml',
  ]) {
    assert.equal(existsSync(join(REPO_ROOT, legacyPath)), false, `${legacyPath} must be removed`)
  }
})

test('manual dev deployment previews and reconciles the full stack in guarded GitHub CI', () => {
  assert.ok(existsSync(DEV_DEPLOY_WORKFLOW), 'the dev stack deployment workflow is missing')
  const source = readFileSync(DEV_DEPLOY_WORKFLOW, 'utf8')
  const workflow = load(source)
  const safetyTestStep = workflow.jobs.deploy.steps.find((step) => step.name === 'Run deployment safety tests')
  const materializeStep = workflow.jobs.deploy.steps.find((step) => step.name === 'Materialize stage configuration')
  const installStep = workflow.jobs.deploy.steps.find((step) => step.name === 'Install SST providers')
  const previewStep = workflow.jobs.deploy.steps.find((step) => step.name === 'Preview the full stack')
  const deployStep = workflow.jobs.deploy.steps.find((step) => step.name === 'Deploy the full stack')

  assert.match(source, /workflow_dispatch:/)
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.apply, {
    description: 'Preview again, then deploy the full stack',
    required: true,
    default: false,
    type: 'boolean',
  })
  assert.equal(workflow.on.workflow_dispatch.inputs.runner_create_allowlist, undefined)
  assert.match(source, /if: github\.ref == 'refs\/heads\/main'/)
  assert.match(source, /environment: dev/)
  assert.match(source, /id-token: write/)
  assert.match(source, /runs-on: ubuntu-24\.04/)
  assert.match(source, /uname -m[\s\S]*x86_64/)
  assert.match(source, /docker info[\s\S]*x86_64/)
  assert.match(source, /aws-actions\/configure-aws-credentials@/)
  assert.match(source, /role-to-assume: \$\{\{ vars\.AWS_DEPLOY_ROLE_ARN \}\}/)
  assert.match(source, /secrets\.DEPLOY_ENV/)
  assert.equal(workflow.jobs.deploy.env.RUNNER_CREATE_ALLOWLIST, undefined)
  assert.match(source, /node apps\/infra\/scripts\/deploy-environment-validation\.mjs apps\/infra\/\.env/)
  assert.doesNotMatch(materializeStep.run, /grep/)
  assert.ok(safetyTestStep, 'the deployment safety test step is missing')
  assert.equal(safetyTestStep.run, 'npm test')
  assert.ok(materializeStep, 'the stage configuration step is missing')
  const materializeConfigIndex = materializeStep.run.indexOf('printf \'%s\\n\' "$DEPLOY_ENV" > apps/infra/.env')
  const validateConfigIndex = materializeStep.run.indexOf(
    'node apps/infra/scripts/deploy-environment-validation.mjs apps/infra/.env',
  )
  assert.notEqual(materializeConfigIndex, -1, 'the stage configuration is not materialized')
  assert.ok(validateConfigIndex > materializeConfigIndex, 'DEPLOY_ENV must be validated after it is materialized')
  assert.ok(installStep, 'the SST provider installation step is missing')
  assert.equal(installStep.run, 'npm run --silent sst -- install --stage dev')
  assert.ok(previewStep, 'the full-stack preview step is missing')
  assert.equal(previewStep.if, undefined, 'Preview validation must not be conditional')
  assert.equal(previewStep['continue-on-error'], undefined, 'Preview failures must stop deployment')
  assert.equal(previewStep.shell, 'bash')
  assert.equal(
    previewStep.run,
    [
      'set -euo pipefail',
      'npm run --silent sst -- diff --stage dev --policy . --json |',
      '  node scripts/deployment-preview.mjs',
      '',
    ].join('\n'),
  )
  assert.ok(deployStep, 'the full-stack deployment step is missing')
  assert.equal(deployStep.if, '${{ inputs.apply }}')
  assert.equal(deployStep.run, 'npm run deploy -- --stage dev --policy .')
  assert.ok(
    workflow.jobs.deploy.steps.indexOf(previewStep) < workflow.jobs.deploy.steps.indexOf(deployStep),
    'Preview validation must complete before deployment',
  )
  assert.ok(
    workflow.jobs.deploy.steps.indexOf(safetyTestStep) < workflow.jobs.deploy.steps.indexOf(previewStep),
    'Runner lifecycle contracts must be tested before the deployment preview',
  )
  assert.ok(
    workflow.jobs.deploy.steps.indexOf(materializeStep) < workflow.jobs.deploy.steps.indexOf(installStep) &&
      workflow.jobs.deploy.steps.indexOf(installStep) < workflow.jobs.deploy.steps.indexOf(previewStep),
    'SST providers must be installed after stage config and before the deployment preview',
  )
  assert.doesNotMatch(`${previewStep.run}\n${deployStep.run}`, /--(?:target|exclude)(?:[=\s]|$)/)
  assert.doesNotMatch(source, /setup-qemu/)
})

test('package scripts disable long-running SST dev for the stateful stack', () => {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'apps/infra/package.json'), 'utf8'))

  assert.equal(packageJson.scripts.dev, undefined)
})

test('infrastructure tests cannot persist or write with the workflow token', () => {
  const source = readFileSync(LINT_WORKFLOW, 'utf8')
  const infraJobStart = source.indexOf('\n  infra:\n')
  const infraJobEnd = source.indexOf('  # Single required status check', infraJobStart)
  assert.notEqual(infraJobStart, -1, 'infra job marker is missing from lint.yml')
  assert.notEqual(infraJobEnd, -1, 'required-status marker is missing from lint.yml')
  const infraJob = source.slice(infraJobStart, infraJobEnd)

  assert.match(infraJob, /permissions:\s+contents: read/)
  assert.match(infraJob, /uses: actions\/checkout@v5\s+with:\s+persist-credentials: false/)
})

test('dev deploy role trusts only the repository GitHub Environment identity', () => {
  assert.ok(existsSync(DEV_DEPLOY_ROLE), 'the GitHub deployment role template is missing')
  const source = readFileSync(DEV_DEPLOY_ROLE, 'utf8')
  const statements = readRuntimeBoundaryStatements()

  assert.match(source, /oidc-provider\/token\.actions\.githubusercontent\.com/)
  assert.match(source, /token\.actions\.githubusercontent\.com:aud: sts\.amazonaws\.com/)
  assert.match(
    source,
    /token\.actions\.githubusercontent\.com:sub: !Sub repo:\$\{GitHubRepository\}:environment:\$\{GitHubEnvironment\}/,
  )
  assert.doesNotMatch(source, /AdministratorAccess/)
  assert.match(source, /BoxLiteRuntimePermissionsBoundary:/)
  assert.match(source, /iam:PermissionsBoundary/)
  assert.match(source, /PolicyName: boxlite-sst-deploy/)

  assert.deepEqual(findStatement(statements, 'BoxLiteStageSecrets'), {
    Sid: 'BoxLiteStageSecrets',
    Effect: 'Allow',
    Action: ['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue'],
    Resource:
      'arn:${AWS::Partition}:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:boxlite-${GitHubEnvironment}-*',
  })
  assert.deepEqual(findStatement(statements, 'BoxLiteStageKmsKeys'), {
    Sid: 'BoxLiteStageKmsKeys',
    Effect: 'Allow',
    Action: 'kms:Decrypt',
    Resource: 'arn:${AWS::Partition}:kms:${AWS::Region}:${AWS::AccountId}:key/*',
    Condition: {
      'ForAnyValue:StringLike': {
        'kms:ResourceAliases': 'alias/boxlite-${GitHubEnvironment}-*',
      },
    },
  })
  assert.deepEqual(findStatement(statements, 'BoxLiteBuckets'), {
    Sid: 'BoxLiteBuckets',
    Effect: 'Allow',
    Action: [
      's3:CreateBucket',
      's3:DeleteBucket',
      's3:GetBucketLocation',
      's3:ListBucket',
      's3:ListBucketVersions',
      's3:PutBucketTagging',
    ],
    Resource: [
      'arn:${AWS::Partition}:s3:::boxlite-${GitHubEnvironment}-*',
      'arn:${AWS::Partition}:s3:::boxlite-volume-*',
    ],
  })
  assert.deepEqual(findStatement(statements, 'BoxLiteBucketObjects'), {
    Sid: 'BoxLiteBucketObjects',
    Effect: 'Allow',
    Action: ['s3:AbortMultipartUpload', 's3:DeleteObject', 's3:DeleteObjectVersion', 's3:GetObject', 's3:PutObject'],
    Resource: [
      'arn:${AWS::Partition}:s3:::boxlite-${GitHubEnvironment}-*/*',
      'arn:${AWS::Partition}:s3:::boxlite-volume-*/*',
    ],
  })
})

test('SST preflights the workspace Runner artifact even when VERSION overrides the public API version', () => {
  const source = readFileSync(SST_WRAPPER, 'utf8')

  assert.match(source, /const workspaceVersion = readWorkspaceVersion\(\)/)
  assert.match(source, /resolvePublicDeploymentConfig\(process\.env, workspaceVersion\)/)
  assert.match(
    source,
    /await verifyRunnerReleaseAssets\(workspaceVersion, \{ signal: runnerReleasePreflightAbortController\.signal \}\)/,
  )
  assert.doesNotMatch(source, /verifyRunnerReleaseAssets\(publicDeploymentConfig\.releaseVersion\)/)
})
