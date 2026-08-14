// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  APP_SECRET_NAMES,
  isForbiddenDeploymentKey,
  isLocalOnlyDeploymentKey,
  validateDotenvSyntax,
} from './validate-environment.js'

test('every credential-context and artifact-selector key is refused', () => {
  // The set the deploy workflow was held to when the stage config travelled as DEPLOY_ENV. Each of
  // these either hands the deploy someone else's AWS identity or redirects which artifact it installs.
  const forbidden = [
    'ALLOW_DOWNGRADE',
    'API_ARTIFACT_REF',
    'API_ARTIFACT_SOURCE',
    'AWS_ACCESS_KEY_ID',
    'AWS_CLI_PATH',
    'AWS_CONFIG_FILE',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_DEFAULT_PROFILE',
    'AWS_ENDPOINT_URL',
    'AWS_PROFILE',
    'AWS_ROLE_ARN',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_SESSION_TOKEN',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'BOXLITE_ARTIFACT_REF',
    'BOXLITE_ARTIFACT_SOURCE',
    'BUILDX_BUILDER',
    'RUNNER_ARTIFACT_BUCKET',
    'RUNNER_ARTIFACT_REF',
    'RUNNER_ARTIFACT_SOURCE',
    'RUNNER_CREATE_ALLOWLIST',
    'SST_BIN_PATH',
  ]
  for (const key of forbidden) {
    assert.equal(isForbiddenDeploymentKey(key), true, `${key} must be refused`)
    assert.equal(isLocalOnlyDeploymentKey(key), true, `${key} must stay local`)
  }
})

test('the AWS_ENDPOINT_URL_<SERVICE> family is refused by prefix, not by name', () => {
  // A membership test alone accepts every member, and redirecting an endpoint points the deploy at
  // an attacker-chosen service.
  for (const key of ['AWS_ENDPOINT_URL_S3', 'AWS_ENDPOINT_URL_STS', 'AWS_ENDPOINT_URL_ANYTHING']) {
    assert.equal(isForbiddenDeploymentKey(key), true, `${key} must be refused`)
  }
})

test('keys consulted before the store can be reached are local-only but not "forbidden"', () => {
  // A distinct reason from the credential rule: each of these is read in order to reach the store, or
  // before it, so a stored copy could only ever disagree with the value actually used. CLOUDFLARE_*
  // is the sharpest case — reading the store initializes that provider, so a token kept there would
  // be needed to read itself.
  for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_DEFAULT_ACCOUNT_ID', 'AWS_REGION', 'SST_STAGE', 'VERSION']) {
    assert.equal(isLocalOnlyDeploymentKey(key), true, `${key} must stay local`)
    assert.equal(isForbiddenDeploymentKey(key), false, `${key} is excluded for reachability, not credentials`)
  }
})

test('every process control that would run code beside the deploy credentials is refused', () => {
  // Hydration injects into the environment of the sst child, which drives Pulumi with the deploy
  // role's credentials. Each of these names a file or program that a runtime executes or trusts on
  // startup, so a stored value for any of them is code execution, not configuration. Grown over three
  // review rounds — enumerated here so a removal fails rather than silently widening what may be
  // hydrated.
  const processControls = [
    'NODE_OPTIONS',
    'NODE_EXTRA_CA_CERTS',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'REQUESTS_CA_BUNDLE',
    'AWS_CA_BUNDLE',
    'PATH',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'BASH_ENV',
    'ENV',
    'GIT_SSH_COMMAND',
    'GIT_EXTERNAL_DIFF',
    'GIT_PAGER',
    'GIT_ASKPASS',
    'PERL5OPT',
    'PYTHONPATH',
    'PYTHONSTARTUP',
    'RUBYOPT',
    'DOCKER_HOST',
    'DOCKER_CONFIG',
    'DOCKER_CERT_PATH',
    'DOCKER_TLS_VERIFY',
  ]
  for (const key of processControls) {
    assert.equal(isLocalOnlyDeploymentKey(key), true, `${key} must never be hydrated`)
  }

  // Families, not names: git reads GIT_CONFIG_GLOBAL and the numbered KEY/VALUE pairs, and Pulumi
  // reads anything PULUMI_*.
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_COUNT']) {
    assert.equal(isLocalOnlyDeploymentKey(key), true, `${key} must never be hydrated`)
  }
  for (const key of ['PULUMI_CONFIG_PASSPHRASE', 'PULUMI_BACKEND_URL', 'PULUMI_SKIP_UPDATE_CHECK']) {
    assert.equal(isLocalOnlyDeploymentKey(key), true, `${key} must never be hydrated`)
  }
  // Both spellings: the proxy variables have no canonical case.
  for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy']) {
    assert.equal(isLocalOnlyDeploymentKey(key), true, `${key} must never be hydrated`)
  }
})

test('ordinary stage configuration is neither refused nor local-only', () => {
  for (const key of ['STACK_DOMAIN', 'OIDC_AUDIENCE', 'OIDC_ISSUER_BASE_URL', 'BOXLITE_SYSTEM_IMAGES', 'RUNNERS']) {
    assert.equal(isLocalOnlyDeploymentKey(key), false, `${key} belongs in the store`)
  }
})

test('validateDotenvSyntax accepts ordinary dotenv configuration', () => {
  assert.doesNotThrow(() =>
    validateDotenvSyntax(`
# a comment
STACK_DOMAIN=dev.boxlite.ai
OIDC_AUDIENCE=https://dev.boxlite.ai/api
RUNNERS=1
BLANK=
`),
  )
})

test('validateDotenvSyntax rejects a line dotenv would silently skip, without echoing it', () => {
  // dotenv drops a malformed line in silence, so the key is simply absent from the store and the
  // failure surfaces much later as a missing value. Reject at the boundary instead.
  const invalid = [
    'export AWS_SECRET_ACCESS_KEY:synthetic-secret-key',
    'export AWS_SECRET_ACCESS_KEY = synthetic-secret-key',
    'AWS_ACCESS_KEY_ID: synthetic-access-key',
    'AWS_PROFILE : developer',
    // A key that cannot start with a digit. The payload deliberately avoids the word "value", which
    // the error message itself carries in `expected KEY=value`.
    '1INVALID=synthetic-payload',
  ]
  for (const assignment of invalid) {
    const value = assignment.split(/\s*(?:=|:)\s*/, 2)[1]
    assert.throws(
      () => validateDotenvSyntax(assignment),
      (error: any) => {
        assert.match(error.message, /contains invalid assignment syntax on line 1/)
        if (value) assert.equal(error.message.includes(value), false, 'the value must not be echoed')
        return true
      },
    )
  }
})

test('validateDotenvSyntax names the file it was given and the offending line', () => {
  assert.throws(
    () => validateDotenvSyntax('STACK_DOMAIN=dev.boxlite.ai\n\nOIDC_AUDIENCE', '/tmp/synthetic/.env'),
    /\/tmp\/synthetic\/\.env contains invalid assignment syntax on line 3/,
  )
})

test('every sst.Secret the stack declares is reserved against the stage configuration', () => {
  // `sst secret load` runs after the individual `secret set` calls, so any of these names appearing in
  // .env would overwrite a value the operator was just prompted for. Read from stack/deploy.ts rather
  // than restated, so declaring a new sst.Secret without reserving it fails here.
  const deployStack = readFileSync(
    join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'stack/deploy.ts'),
    'utf8',
  )
  const declared = [...deployStack.matchAll(/new sst\.Secret\('([A-Z0-9_]+)'/g)].map((match) => match[1])
  assert.ok(declared.length > 0, 'no sst.Secret declarations found — the pattern has changed')
  assert.deepEqual([...declared].sort(), [...APP_SECRET_NAMES].sort())
  for (const name of declared) {
    assert.equal(isLocalOnlyDeploymentKey(name), true, `${name} must never enter the stage configuration`)
  }
})
