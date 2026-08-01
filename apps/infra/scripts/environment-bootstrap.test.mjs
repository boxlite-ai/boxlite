// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GITHUB_OIDC_PROVIDER_URL,
  cloudFormationDeployChanged,
  cloudFormationParameterOverrides,
  decideSsmOverwrite,
  githubDeployRoleStackName,
  hasGitHubOidcProvider,
  isAwsCliVersionAtLeast,
  parseAwsCliVersion,
  runtimeBoundaryPolicyArn,
  ssmParameterName,
  validateGitHubRepo,
} from './environment-bootstrap.mjs'

test('runtimeBoundaryPolicyArn matches sst.config.ts interpolation', () => {
  assert.equal(
    runtimeBoundaryPolicyArn({ accountId: '123456789012', appName: 'boxlite', stage: 'dev' }),
    'arn:aws:iam::123456789012:policy/boxlite-dev-runtime-boundary',
  )
})

test('runtimeBoundaryPolicyArn rejects a malformed account id', () => {
  assert.throws(
    () => runtimeBoundaryPolicyArn({ accountId: '12345', appName: 'boxlite', stage: 'dev' }),
    /must be a 12-digit AWS account id/,
  )
})

test('githubDeployRoleStackName matches the README manual bootstrap stack name', () => {
  assert.equal(githubDeployRoleStackName('dev'), 'boxlite-dev-github-deploy')
})

test('cloudFormationParameterOverrides validates repo shape and stage', () => {
  assert.deepEqual(cloudFormationParameterOverrides({ repo: 'boxlite-ai/boxlite', stage: 'dev' }), [
    'GitHubRepository=boxlite-ai/boxlite',
    'GitHubEnvironment=dev',
  ])
  assert.throws(() => cloudFormationParameterOverrides({ repo: 'not-a-repo', stage: 'dev' }), /must look like/)
})

test('validateGitHubRepo accepts a community fork owner/name', () => {
  assert.equal(validateGitHubRepo('someone-else/boxlite'), 'someone-else/boxlite')
  assert.throws(() => validateGitHubRepo(''), /must look like/)
  assert.throws(() => validateGitHubRepo('boxlite'), /must look like/)
})

test('cloudFormationDeployChanged reads the no-op sentinel line', () => {
  assert.equal(cloudFormationDeployChanged('\nWaiting for changeset to be created..\nNo changes to deploy. Stack boxlite-dev-github-deploy is up to date\n'), false)
  assert.equal(cloudFormationDeployChanged('\nSuccessfully created/updated stack - boxlite-dev-github-deploy\n'), true)
})

test('ssmParameterName is stage-scoped', () => {
  assert.equal(ssmParameterName('dev', 'cloudflare-api-token'), '/boxlite/dev/cloudflare-api-token')
  assert.throws(() => ssmParameterName('dev', ''), /param is required/)
})

test('decideSsmOverwrite skips an existing parameter unless --force is set', () => {
  assert.equal(decideSsmOverwrite({ exists: true, force: false }), 'skip')
  assert.equal(decideSsmOverwrite({ exists: true, force: true }), 'prompt')
})

test('decideSsmOverwrite always prompts when the parameter does not exist yet', () => {
  assert.equal(decideSsmOverwrite({ exists: false, force: false }), 'prompt')
  assert.equal(decideSsmOverwrite({ exists: false, force: true }), 'prompt')
})

test('parseAwsCliVersion reads the real `aws --version` banner', () => {
  assert.deepEqual(parseAwsCliVersion('aws-cli/2.35.11 Python/3.14.6 Darwin/27.0.0 source/arm64'), {
    major: 2,
    minor: 35,
    patch: 11,
  })
})

test('parseAwsCliVersion rejects output that is not an AWS CLI banner', () => {
  assert.throws(() => parseAwsCliVersion('aws-cli/2.x'), /could not parse an AWS CLI version/)
  assert.throws(() => parseAwsCliVersion(''), /could not parse an AWS CLI version/)
})

test('isAwsCliVersionAtLeast gates the aws login flow on 2.32.0', () => {
  // `aws login` shipped in 2.32.0; older CLIs lack the browser flow entirely.
  assert.equal(isAwsCliVersionAtLeast('aws-cli/2.35.11 Python/3.14.6'), true)
  assert.equal(isAwsCliVersionAtLeast('aws-cli/2.32.0 Python/3.12.0'), true)
  assert.equal(isAwsCliVersionAtLeast('aws-cli/2.31.9 Python/3.12.0'), false)
  assert.equal(isAwsCliVersionAtLeast('aws-cli/1.42.0 Python/3.12.0'), false)
})

test('isAwsCliVersionAtLeast compares numerically, not lexicographically', () => {
  // '2.9.0' > '2.32.0' under string comparison; it must not be accepted.
  assert.equal(isAwsCliVersionAtLeast('aws-cli/2.9.0 Python/3.12.0'), false)
  assert.equal(isAwsCliVersionAtLeast('aws-cli/2.320.0 Python/3.12.0'), true)
})

test('hasGitHubOidcProvider detects an already-registered provider', () => {
  const listOutput = {
    OpenIDConnectProviderList: [
      { Arn: 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com' },
      { Arn: 'arn:aws:iam::123456789012:oidc-provider/oidc.eks.us-west-2.amazonaws.com/id/ABC' },
    ],
  }
  assert.equal(hasGitHubOidcProvider(listOutput), true)
})

test('hasGitHubOidcProvider reports absence so the bootstrap creates one', () => {
  assert.equal(hasGitHubOidcProvider({ OpenIDConnectProviderList: [] }), false)
  assert.equal(hasGitHubOidcProvider({}), false)
  assert.equal(
    hasGitHubOidcProvider({
      OpenIDConnectProviderList: [{ Arn: 'arn:aws:iam::123456789012:oidc-provider/gitlab.com' }],
    }),
    false,
  )
})

test('hasGitHubOidcProvider does not match a lookalike suffix', () => {
  // A provider whose host merely ENDS with the GitHub host must not count —
  // creating a duplicate would fail with EntityAlreadyExists either way, but a
  // false positive would skip a genuinely required creation.
  assert.equal(
    hasGitHubOidcProvider({
      OpenIDConnectProviderList: [{ Arn: 'arn:aws:iam::123456789012:oidc-provider/evil-token.actions.githubusercontent.com' }],
    }),
    false,
  )
  assert.equal(GITHUB_OIDC_PROVIDER_URL, 'https://token.actions.githubusercontent.com')
})
