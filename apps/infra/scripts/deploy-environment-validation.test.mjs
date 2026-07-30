// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { validateDeployEnvironment } from './deploy-environment-validation.mjs'

test('accepts ordinary dotenv deployment configuration', () => {
  assert.doesNotThrow(() =>
    validateDeployEnvironment(`
STACK_DOMAIN=dev.boxlite.ai
OIDC_AUDIENCE=https://dev.boxlite.ai/api
RUNNERS=1
`),
  )
})

test('rejects every forbidden workflow override', () => {
  const forbiddenAssignments = [
    'AWS_PROFILE=developer',
    'AWS_ACCESS_KEY_ID=synthetic-access-key',
    'AWS_CONFIG_FILE=/tmp/synthetic-aws-config',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI=https://credentials.invalid',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/synthetic-credentials',
    'AWS_DEFAULT_PROFILE=developer',
    'AWS_ENDPOINT_URL=https://aws.invalid',
    'AWS_ENDPOINT_URL_S3=https://s3.invalid',
    'AWS_ROLE_ARN=arn:aws:iam::123456789012:role/synthetic',
    'AWS_SECRET_ACCESS_KEY=synthetic-secret-key',
    'AWS_SHARED_CREDENTIALS_FILE=/tmp/synthetic-aws-credentials',
    'AWS_SESSION_TOKEN="synthetic-session-token"',
    'AWS_WEB_IDENTITY_TOKEN_FILE=/tmp/synthetic-web-identity-token',
    'AWS_CLI_PATH=/opt/local/bin/aws',
    'BUILDX_BUILDER=laptop-builder',
    'RUNNER_CREATE_ALLOWLIST=Runner',
    'SST_BIN_PATH=/tmp/synthetic-sst',
  ]

  for (const assignment of forbiddenAssignments) {
    const secretValue = assignment.split('=', 2)[1].replaceAll('"', '')
    assert.throws(
      () => validateDeployEnvironment(assignment),
      (error) => {
        assert.match(error.message, /DEPLOY_ENV must rely on workflow OIDC/)
        assert.equal(error.message.includes(secretValue), false)
        return true
      },
    )
  }
})

test('rejects non-canonical dotenv assignments before parsing', () => {
  const invalidAssignments = [
    'export AWS_SECRET_ACCESS_KEY:synthetic-secret-key',
    'export AWS_SECRET_ACCESS_KEY = synthetic-secret-key',
    'AWS_ACCESS_KEY_ID: synthetic-access-key',
    'AWS_PROFILE : developer',
  ]

  for (const assignment of invalidAssignments) {
    const secretValue = assignment.split(/\s*(?:=|:)\s*/, 2)[1]
    assert.throws(
      () => validateDeployEnvironment(assignment),
      (error) => {
        assert.match(error.message, /DEPLOY_ENV contains invalid assignment syntax on line 1/)
        assert.equal(error.message.includes(secretValue), false)
        return true
      },
    )
  }
})
