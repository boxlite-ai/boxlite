// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parse as parseDotenv } from 'dotenv'

import {
  GITHUB_OIDC_PROVIDER_URL,
  cloudFormationDeployChanged,
  cloudFormationParameterOverrides,
  deployableStageConfig,
  githubDeployRoleName,
  githubDeployRoleStackName,
  hasGitHubOidcProvider,
  isAwsCliVersionAtLeast,
  parseAwsCliVersion,
  prepareStageConfigLoad,
  runtimeBoundaryPolicyArn,
  serializeStageConfig,
  ssmParameterName,
  sstPlatformState,
  validateGitHubRepo,
} from './environment.js'
import {
  STAGE_CONFIG_DIGEST_KEY,
  STAGE_CONFIG_MANIFEST_KEY,
  hydrateStageConfig,
  parseSecretList,
  parseStageConfigManifest,
} from '../deployment/stage-config.js'

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

test('githubDeployRoleStackName rejects a stage CloudFormation cannot name', () => {
  // CloudFormation stack names allow only alphanumerics and hyphens. An
  // underscore has to be refused up front: bootstrap makes external changes
  // before it ever calls `cloudformation deploy`, so accepting `dev_blue` here
  // means failing partway through with a half-provisioned stage.
  assert.throws(() => githubDeployRoleStackName('dev_blue'), /must match/)
  assert.equal(githubDeployRoleStackName('dev-blue'), 'boxlite-dev-blue-github-deploy')
})

test('githubDeployRoleStackName stays stable per stage so a re-run updates one stack', () => {
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

test('githubDeployRoleName matches the RoleName the CloudFormation template declares', () => {
  // The workflows compose the deploy role ARN from this name, and the template creates the role, so
  // a drift between them is a deploy that cannot assume its own role. Read from the template rather
  // than restated, so editing either side alone fails here.
  const template = readFileSync(new URL('./aws/github-deploy-role.yaml', import.meta.url), 'utf8')
  assert.match(template, /RoleName: !Sub boxlite-\$\{GitHubEnvironment\}-github-deploy$/m)
  assert.equal(githubDeployRoleName('dev'), 'boxlite-dev-github-deploy')
  assert.throws(() => githubDeployRoleName('dev_blue'), /must match/)
})

test('deployableStageConfig stores stage configuration and keeps local-only keys out', () => {
  const { config, excluded } = deployableStageConfig(
    [
      'STACK_DOMAIN=dev.boxlite.ai',
      'OIDC_AUDIENCE=https://dev.boxlite.ai/api',
      // Legitimate locally — stack/app.ts reads it — so it must be kept out rather than reject
      // the whole file and leave an operator on a named profile unable to bootstrap.
      'AWS_PROFILE=developer',
      'AWS_CLI_PATH=/opt/local/bin/aws',
      // The selector CI owns: a stage-wide store entry redirecting it would deploy an artifact no
      // workflow run ever approved.
      'BOXLITE_ARTIFACT_SOURCE=release',
      '# a comment',
      'PROXY_TEMPLATE_URL=',
    ].join('\n'),
  )

  assert.deepEqual(config, {
    OIDC_AUDIENCE: 'https://dev.boxlite.ai/api',
    PROXY_TEMPLATE_URL: '',
    STACK_DOMAIN: 'dev.boxlite.ai',
  })
  assert.deepEqual(excluded, ['AWS_CLI_PATH', 'AWS_PROFILE', 'BOXLITE_ARTIFACT_SOURCE'])
})

/*
 * What `sst secret load` then `sst secret list` do to the payload, without sst.
 *
 * Load parses the file as dotenv; list prints `key=value` back under a `# <app>/<stage>` heading. The
 * round trip matters because bootstrap writes the digest and the deploy wrapper recomputes it: any
 * disagreement between serializeStageConfig's quoting and parseSecretList's reading surfaces as a
 * digest mismatch on every deploy, not as a parse error anyone would trace back here.
 */
function throughSecretStore(payload: Record<string, string>) {
  const stored = parseDotenv(serializeStageConfig(payload))
  const printed = ['# fallback', '# boxlite/dev']
  for (const [key, value] of Object.entries(stored)) printed.push(`${key}=${value}`)
  return parseSecretList(printed.join('\n'), { app: 'boxlite', stage: 'dev' })
}

const STAGE_ENV_SOURCE = [
  'STACK_DOMAIN=dev.boxlite.ai',
  'OIDC_AUDIENCE=https://dev.boxlite.ai/api',
  'AWS_PROFILE=developer',
  'PROXY_TEMPLATE_URL=',
].join('\n')

test('the digest bootstrap writes is the one hydration recomputes', () => {
  // The two halves of the generation check are computed by different modules from different inputs —
  // bootstrap from .env, the wrapper from what the store prints back. They have to agree on every
  // value that survives quoting, or the fail-closed check rejects a store that is perfectly intact.
  const { payload } = prepareStageConfigLoad(STAGE_ENV_SOURCE)
  const { recordedDigest, actualDigest, apply } = hydrateStageConfig({
    stored: throughSecretStore(payload),
    environment: {},
  })

  assert.notEqual(recordedDigest, '', 'bootstrap must write a digest for the check to have anything to do')
  assert.equal(recordedDigest, actualDigest)
  assert.deepEqual(apply, {
    OIDC_AUDIENCE: 'https://dev.boxlite.ai/api',
    PROXY_TEMPLATE_URL: '',
    STACK_DOMAIN: 'dev.boxlite.ai',
  })
})

test('a value left behind by an interrupted load is caught', () => {
  // `secret load` is a read-modify-write of one document and is not atomic, so an interrupted one
  // leaves some keys new and some old. The manifest cannot see it — every name it lists is still
  // present — which is the whole reason the digest exists.
  const { payload } = prepareStageConfigLoad(STAGE_ENV_SOURCE)
  const stored = throughSecretStore(payload)
  stored.STACK_DOMAIN = 'stale.boxlite.ai'

  const { recordedDigest, actualDigest } = hydrateStageConfig({ stored, environment: {} })
  assert.notEqual(recordedDigest, actualDigest)
})

test('a store with a manifest but no digest reads as torn, not as unverifiable', () => {
  // The first interrupted load is exactly this shape: the manifest landed, the digest did not. Treating
  // an absent digest as "cannot verify, carry on" would let that one case through unchecked — and it is
  // the only case that can occur, since no bootstrap has ever written a manifest without a digest.
  const { payload } = prepareStageConfigLoad(STAGE_ENV_SOURCE)
  const stored = throughSecretStore(payload)
  delete stored[STAGE_CONFIG_DIGEST_KEY]

  const { recordedDigest, actualDigest } = hydrateStageConfig({ stored, environment: {} })
  assert.equal(recordedDigest, '')
  assert.notEqual(actualDigest, '', 'the recomputed digest is what makes the absence detectable')
  assert.notEqual(recordedDigest, actualDigest, 'the wrapper compares these two and must see a mismatch')
})

test('a value the manifest does not name is outside the digest, as it is outside hydration', () => {
  // The store also holds hand-set sst.Secret values whose rotation has nothing to do with this
  // configuration. If they counted, every `sst secret set` would read as a torn load.
  const { payload } = prepareStageConfigLoad(STAGE_ENV_SOURCE)
  const stored = throughSecretStore(payload)
  stored.OIDC_CLIENT_ID = 'rotated-by-hand'

  const { recordedDigest, actualDigest, apply, unlisted } = hydrateStageConfig({ stored, environment: {} })
  assert.equal(recordedDigest, actualDigest, 'an unrelated secret must not read as a torn load')
  assert.equal(apply.OIDC_CLIENT_ID, undefined, 'the stack reads it through sst.Secret, not process.env')
  assert.ok(unlisted.includes('OIDC_CLIENT_ID'))
})

test('a .env with nothing storable in it is refused', () => {
  // main() runs this before the OIDC provider, the GitHub Environment and a non-idempotent Auth0 app
  // are created. A file of only local-only keys would otherwise store a manifest naming nothing, and
  // the deploy wrapper would fail with the stage half-bootstrapped.
  assert.throws(
    () => prepareStageConfigLoad('AWS_PROFILE=developer\nAWS_CLI_PATH=/opt/local/bin/aws\n'),
    /no deployable stage configuration/,
  )
})

test('the manifest names exactly the keys bootstrap stored', () => {
  // Not "everything in the store": the leftover from a key deleted from .env has to stay unnamed, and
  // the Cloudflare credentials are refused by the allowlist anyway — naming them would claim a
  // hydration that cannot happen.
  const { payload, storedKeys } = prepareStageConfigLoad(STAGE_ENV_SOURCE)
  // Sorted on both sides: the manifest is serialized in sorted order and hydration reads it into a
  // Set, so .env's line order is not part of the contract.
  assert.deepEqual(parseStageConfigManifest(payload[STAGE_CONFIG_MANIFEST_KEY]), [...storedKeys].sort())
  assert.deepEqual([...storedKeys].sort(), ['OIDC_AUDIENCE', 'PROXY_TEMPLATE_URL', 'STACK_DOMAIN'])
  assert.deepEqual(
    Object.keys(payload).filter((key) => key.startsWith('CLOUDFLARE_')),
    [],
    'the credentials that cannot live in the store must not be named as if they could',
  )
})

test('deployableStageConfig keeps the Cloudflare credentials out of the store', () => {
  // .env.example ships both keys at column 0, so a filled-in .env almost always holds the token.
  // Copying it into the store would be circular (reading the store initializes that provider) as well
  // as putting a live credential in a second place.
  const { config, excluded } = deployableStageConfig(
    [
      'CLOUDFLARE_API_TOKEN=synthetic-token',
      'CLOUDFLARE_DEFAULT_ACCOUNT_ID=synthetic-account',
      'AWS_REGION=eu-west-1',
      'SST_STAGE=dev',
      'VERSION=1.2.3',
      'STACK_DOMAIN=dev.boxlite.ai',
    ].join('\n'),
  )

  assert.deepEqual(config, { STACK_DOMAIN: 'dev.boxlite.ai' })
  assert.deepEqual(excluded, [
    'AWS_REGION',
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_DEFAULT_ACCOUNT_ID',
    'SST_STAGE',
    'VERSION',
  ])
})

test('deployableStageConfig keeps out the AWS_ENDPOINT_URL_<SERVICE> family, not just the bare name', () => {
  // A prefix rather than a name, so a membership test on its own would store every member of it
  // and let a store entry point the deploy at an attacker-controlled endpoint.
  const { config, excluded } = deployableStageConfig('AWS_ENDPOINT_URL_S3=https://s3.invalid\nSTACK_DOMAIN=dev.boxlite.ai\n')
  assert.deepEqual(Object.keys(config), ['STACK_DOMAIN'])
  assert.deepEqual(excluded, ['AWS_ENDPOINT_URL_S3'])
})

test('serializeStageConfig emits the single-quoted form sst secret load reads literally', () => {
  // Pinned, not incidental: sst's double-quoted branch unescapes \" \n \r \t, so that form cannot
  // carry a value holding one of those sequences literally.
  assert.equal(
    serializeStageConfig({ STACK_DOMAIN: 'dev.boxlite.ai', BOXLITE_SYSTEM_IMAGES: 'a=ghcr.io/x:1' }),
    "BOXLITE_SYSTEM_IMAGES='a=ghcr.io/x:1'\nSTACK_DOMAIN='dev.boxlite.ai'\n",
  )
  assert.equal(serializeStageConfig({}), '')
})

test('serializeStageConfig round-trips the values a stage config actually holds', () => {
  const config = {
    // `#` would start a comment unquoted, `=` must survive the split-on-first-`=`, and the spaces
    // would be eaten by the trim. `C:\new` is the one that rules out the double-quoted form: its
    // literal backslash-n goes through that form's unescape pass and comes back as a newline.
    BOXLITE_SYSTEM_IMAGES: 'base=ghcr.io/acme/base:v1,py=ghcr.io/acme/py:v1',
    OIDC_ISSUER_BASE_URL: 'https://tenant.auth0.com/',
    PADDED: '  leading and trailing  ',
    WINDOWS_PATH: 'C:\\new\\thing',
    WITH_HASH: 'value # not a comment',
  }
  assert.deepEqual(parseDotenv(serializeStageConfig(config)), config)
})

test('serializeStageConfig refuses a value it cannot represent, without echoing it', () => {
  for (const value of ["it's quoted", 'first\nsecond', 'carriage\rreturn']) {
    assert.throws(
      () => serializeStageConfig({ GHCR_TOKEN: value }),
      (error: any) => {
        assert.match(error.message, /GHCR_TOKEN contains a single quote or newline/)
        assert.equal(error.message.includes(value), false)
        return true
      },
    )
  }
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

test('sstPlatformState tells a finished install from an interrupted one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sst-platform-'))
  // sst has not run at all yet.
  assert.equal(sstPlatformState(dir), 'absent')

  // sst wrote package.json, then its bundled bun stalled before the deps
  // landed. This is the state that must trigger the npm recovery rather than
  // being reported as a working platform.
  writeFileSync(join(dir, 'package.json'), '{}')
  assert.equal(sstPlatformState(dir), 'deps-missing')

  mkdirSync(join(dir, 'node_modules'))
  assert.equal(sstPlatformState(dir), 'deps-missing', 'an empty node_modules is not a finished install')

  mkdirSync(join(dir, 'node_modules', '@pulumi'))
  assert.equal(sstPlatformState(dir), 'ready')
})
