// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse as parseDotenv } from 'dotenv'

import { deployableStageConfig, serializeStageConfig } from '../bootstrap/environment.js'

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

test('validateDotenvSyntax accepts every form the parser it guards accepts', () => {
  /*
   * This validator exists to reject what dotenv would silently drop, so rejecting something dotenv
   * reads is the opposite failure: the operator is told a working .env is invalid and bootstrap
   * refuses to run. `export KEY=value` comes from a file that doubles as a shell script; the spaces
   * come from ordinary tidying.
   *
   * Each line is asserted against `parse` as well, so the two cannot drift apart on someone's word.
   */
  const accepted = [
    'export STACK_DOMAIN=dev.boxlite.ai',
    'STACK_DOMAIN = dev.boxlite.ai',
    'export RUNNERS = 1',
    // Surprising, and exactly why this is checked against the parser rather than a pattern: dotenv 17
    // reads `KEY: value`, though not `KEY:value` or `KEY : value`. Rejecting it would refuse a file
    // that loads.
    'STACK_DOMAIN: dev.boxlite.ai',
  ]
  for (const line of accepted) {
    assert.notDeepEqual(parseDotenv(line), {}, `${line} must actually parse, or the premise here is wrong`)
    assert.doesNotThrow(() => validateDotenvSyntax(line), `${line} is valid dotenv`)
  }

  // And the near-misses dotenv really does drop, which are what this guard is for.
  for (const line of ['STACK_DOMAIN:dev.boxlite.ai', 'STACK_DOMAIN : dev.boxlite.ai']) {
    assert.deepEqual(parseDotenv(line), {}, `${line} must be dropped, or the premise here is wrong`)
    assert.throws(() => validateDotenvSyntax(line), /is not an assignment dotenv can read/)
  }

  /*
   * Accepting `KEY: value` does not loosen what may be stored. A credential written that way parses,
   * and is then refused by the allowlist like any other — the syntax check has never been what keeps
   * secrets out of the store, and reading it as though it were would misplace the guarantee.
   */
  const credentialLine = 'AWS_ACCESS_KEY_ID: synthetic-access-key'
  assert.notDeepEqual(parseDotenv(credentialLine), {}, 'dotenv reads this form')
  assert.doesNotThrow(() => validateDotenvSyntax(credentialLine))
  assert.deepEqual(deployableStageConfig(credentialLine).config, {}, 'and it must still never be stored')
})

test('validateDotenvSyntax rejects a line dotenv would silently skip, without echoing it', () => {
  // dotenv drops a malformed line in silence, so the key is simply absent from the store and the
  // failure surfaces much later as a missing value. Reject at the boundary instead.
  // The payloads deliberately avoid the word "value", which the error message itself carries in
  // `expected KEY=value`.
  const invalid = ['export AWS_SECRET_ACCESS_KEY:synthetic-secret-key', 'AWS_PROFILE : developer']
  for (const assignment of invalid) {
    const value = assignment.split(/\s*(?:=|:)\s*/, 2)[1]
    assert.deepEqual(parseDotenv(assignment), {}, `${assignment} must be dropped, or it is not this test's case`)
    assert.throws(
      () => validateDotenvSyntax(assignment),
      (error: any) => {
        assert.match(error.message, /line 1 is not an assignment dotenv can read/)
        if (value) assert.equal(error.message.includes(value), false, 'the value must not be echoed')
        return true
      },
    )
  }

  /*
   * A key starting with a digit is not one this validator's business. dotenv's key pattern allows it,
   * so the line is read rather than dropped and there is nothing here to warn about — and the
   * allowlist refuses to store it anyway, which is where an unrecognised key is supposed to stop.
   */
  // A lone CR is a line break to the parser but not to `split(/\r?\n/)`, so the malformed half hid
  // behind a line that parsed. The store would then simply lack that key.
  const carriageReturnHidden = 'STACK_DOMAIN=dev.boxlite.ai\rBROKEN : synthetic'
  assert.deepEqual(parseDotenv(carriageReturnHidden), { STACK_DOMAIN: 'dev.boxlite.ai' }, 'the second half is dropped')
  assert.throws(() => validateDotenvSyntax(carriageReturnHidden), /line 2 is not an assignment/)

  const digitLeading = '1INVALID=synthetic-payload'
  assert.notDeepEqual(parseDotenv(digitLeading), {}, 'dotenv reads a digit-leading key')
  assert.doesNotThrow(() => validateDotenvSyntax(digitLeading))
  assert.deepEqual(deployableStageConfig(digitLeading).config, {}, 'and it is refused by the allowlist')
})

test('a value quoted across lines is refused, and the message says why it might be', () => {
  /*
   * dotenv reads it, so this is a deliberate refusal rather than a parse failure — and it costs
   * nothing, because a stored value cannot contain a newline, so such a file could never be
   * bootstrapped either way.
   *
   * It is refused here rather than recognised and skipped because recognising one is not possible
   * without reimplementing the grammar: an unterminated quote parses to a key of its own, so a
   * continuation line and a typo are indistinguishable to anything short of dotenv itself. The message
   * therefore names both possibilities instead of asserting the wrong one.
   */
  const multiline = 'STACK_DOMAIN="first\nsecond"\nRUNNERS=1\n'
  assert.deepEqual(parseDotenv(multiline), { STACK_DOMAIN: 'first\nsecond', RUNNERS: '1' }, 'dotenv does read it')
  assert.notDeepEqual(parseDotenv('KEY="first'), {}, 'an unterminated quote yields a key, which is why')

  assert.throws(() => validateDotenvSyntax(multiline), (error: any) => {
    assert.match(error.message, /line 2 is not an assignment/)
    assert.match(error.message, /cannot contain a newline/)
    return true
  })
  assert.throws(() => serializeStageConfig({ STACK_DOMAIN: 'first\nsecond' }), /contains a newline/)
})

test('validateDotenvSyntax names the file it was given and the offending line', () => {
  assert.throws(
    () => validateDotenvSyntax('STACK_DOMAIN=dev.boxlite.ai\n\nOIDC_AUDIENCE', '/tmp/synthetic/.env'),
    /\/tmp\/synthetic\/\.env line 3 is not an assignment dotenv can read/,
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
