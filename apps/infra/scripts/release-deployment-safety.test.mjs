// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SST_WRAPPER = join(REPO_ROOT, 'apps/infra/scripts/sst-with-cloudflare.mjs')
const DEV_API_DEPLOY_WORKFLOW = join(REPO_ROOT, '.github/workflows/deploy-dev-api.yml')
const LINT_WORKFLOW = join(REPO_ROOT, '.github/workflows/lint.yml')
const DEV_DEPLOY_ROLE = join(REPO_ROOT, 'apps/infra/ci/github-deploy-role.yaml')

test('SST deploy verifies Runner release assets before invoking SST', () => {
  const source = readFileSync(SST_WRAPPER, 'utf8')
  const preflightIndex = source.indexOf('await verifyRunnerReleaseAssets(')
  const sstIndex = source.indexOf('await withPulumiEventLogCleanup(')

  assert.match(source, /import \{ verifyRunnerReleaseAssets \} from '\.\/runner-release-assets\.mjs'/)
  assert.notEqual(preflightIndex, -1, 'the Runner release preflight is missing')
  assert.notEqual(sstIndex, -1, 'the guarded SST invocation is missing')
  assert.ok(preflightIndex < sstIndex, 'SST may run before Runner release availability is known')
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

test('manual dev API deployment runs natively in guarded GitHub CI', () => {
  assert.ok(existsSync(DEV_API_DEPLOY_WORKFLOW), 'the dev API deployment workflow is missing')
  const source = readFileSync(DEV_API_DEPLOY_WORKFLOW, 'utf8')

  assert.match(source, /workflow_dispatch:/)
  assert.match(source, /if: github\.ref == 'refs\/heads\/main'/)
  assert.match(source, /environment: dev/)
  assert.match(source, /id-token: write/)
  assert.match(source, /runs-on: ubuntu-24\.04/)
  assert.match(source, /uname -m[\s\S]*x86_64/)
  assert.match(source, /docker info[\s\S]*x86_64/)
  assert.match(source, /aws-actions\/configure-aws-credentials@/)
  assert.match(source, /role-to-assume: \$\{\{ vars\.AWS_DEPLOY_ROLE_ARN \}\}/)
  assert.match(source, /secrets\.DEPLOY_ENV/)
  assert.match(source, /AWS_ACCESS_KEY_ID[\s\S]*native CI builder/)
  assert.match(source, /npm run deploy -- --stage dev --target Api --exclude Runner/)
  assert.doesNotMatch(source, /setup-qemu/)
})

test('infrastructure tests cannot persist or write with the workflow token', () => {
  const source = readFileSync(LINT_WORKFLOW, 'utf8')
  const infraJob = source.slice(source.indexOf('\n  infra:\n'), source.indexOf('  # Single required status check'))

  assert.match(infraJob, /permissions:\s+contents: read/)
  assert.match(infraJob, /uses: actions\/checkout@v5\s+with:\s+persist-credentials: false/)
})

test('dev deploy role trusts only the repository GitHub Environment identity', () => {
  assert.ok(existsSync(DEV_DEPLOY_ROLE), 'the GitHub deployment role template is missing')
  const source = readFileSync(DEV_DEPLOY_ROLE, 'utf8')

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
  assert.match(source, /secret:boxlite-\$\{GitHubEnvironment\}-\*/)
  assert.match(source, /arn:\$\{AWS::Partition\}:s3:::boxlite-\$\{GitHubEnvironment\}-\*/)
  assert.match(source, /kms:ResourceAliases:/)
})

test('SST preflights the workspace Runner artifact even when VERSION overrides the public API version', () => {
  const source = readFileSync(SST_WRAPPER, 'utf8')

  assert.match(source, /const workspaceVersion = readWorkspaceVersion\(\)/)
  assert.match(source, /resolvePublicDeploymentConfig\(process\.env, workspaceVersion\)/)
  assert.match(source, /await verifyRunnerReleaseAssets\(workspaceVersion\)/)
  assert.doesNotMatch(source, /verifyRunnerReleaseAssets\(publicDeploymentConfig\.releaseVersion\)/)
})
