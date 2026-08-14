// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Pure helpers for `bootstrap-environment.mjs` — the idempotent, human-run
 * environment preparation script. Kept side-effect-free (no AWS/GitHub CLI
 * calls) so the naming, ARN construction, and idempotency decisions are
 * covered by unit tests instead of only being exercised against live AWS.
 */

// No underscore: the stage is interpolated into a CloudFormation stack name
// (githubDeployRoleStackName), and CloudFormation accepts only alphanumerics
// and hyphens. Allowing `dev_blue` here would pass validation and then fail at
// `cloudformation deploy`, after bootstrap had already made external changes.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { parse } from 'dotenv'

import {
  STAGE_CONFIG_DIGEST_KEY,
  STAGE_CONFIG_MANIFEST_KEY,
  parseStageConfigManifest,
  serializeStageConfigManifest,
  stageConfigDigest,
} from '../deployment/stage-config.js'
import { isStorableStageConfigKey } from '../deployment/storable-keys.js'
import { isLocalOnlyDeploymentKey } from '../deployment/validate-environment.js'

const STAGE_LIKE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/
const ACCOUNT_ID_PATTERN = /^\d{12}$/

// `aws login` (browser-based AWS Management Console credentials) is what lets a
// self-hoster bootstrap without minting long-lived access keys. It shipped in
// AWS CLI 2.32.0, so an older CLI silently lacks the whole flow and the
// operator would be sent to the IAM console instead.
export const MINIMUM_AWS_CLI_VERSION = '2.32.0'
export const GITHUB_OIDC_PROVIDER_URL = 'https://token.actions.githubusercontent.com'
const AWS_CLI_VERSION_PATTERN = /^aws-cli\/(\d+)\.(\d+)\.(\d+)/

function requireStageLike(name: any, value: any) {
  if (!value || !STAGE_LIKE_PATTERN.test(value)) {
    throw new Error(`${name} '${value}' must match ${STAGE_LIKE_PATTERN}`)
  }
  return value
}

export function validateGitHubRepo(repo: any) {
  if (!repo || !GITHUB_REPO_PATTERN.test(repo)) {
    throw new Error(`repo '${repo}' must look like 'owner/name'`)
  }
  return repo
}

// Mirrors sst.config.ts's own `${$app.name}-${$app.stage}-runtime-boundary`
// interpolation (apps/infra/sst.config.ts:131) — this script and the SST run
// must agree on the boundary policy name without either importing the other.
export function runtimeBoundaryPolicyArn({ accountId, appName, stage }: any) {
  if (!accountId || !ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error(`accountId '${accountId}' must be a 12-digit AWS account id`)
  }
  requireStageLike('appName', appName)
  requireStageLike('stage', stage)
  return `arn:aws:iam::${accountId}:policy/${appName}-${stage}-runtime-boundary`
}

// CloudFormation stack name for the GitHub deploy role. Stable per stage so
// `cloudformation deploy` updates the existing stack in place rather than
// creating a second one; changing it would orphan whatever is already deployed.
export function githubDeployRoleStackName(stage: any) {
  requireStageLike('stage', stage)
  return `boxlite-${stage}-github-deploy`
}

export function cloudFormationParameterOverrides({ repo, stage }: any) {
  validateGitHubRepo(repo)
  requireStageLike('stage', stage)
  return [`GitHubRepository=${repo}`, `GitHubEnvironment=${stage}`]
}

// `aws cloudformation deploy --no-fail-on-empty-changeset` exits 0 whether or
// not anything changed; the only signal is this literal stdout line, so the
// script can report "already up to date" instead of claiming every rerun
// made a change.
export function cloudFormationDeployChanged(stdout: any) {
  return !stdout.includes('No changes to deploy')
}

export function ssmParameterName(stage: any, param: any) {
  requireStageLike('stage', stage)
  if (!param) throw new Error('param is required')
  return `/boxlite/${stage}/${param}`
}

/*
 * IAM role name for the GitHub deploy role.
 *
 * Its own function even though it currently returns the same string as githubDeployRoleStackName: a
 * CloudFormation stack name and the IAM role that stack declares are separate contracts, and the
 * workflows compose the role ARN from this name while `cloudformation deploy` addresses the stack by
 * the other. Renaming one must not silently rename the other. Pinned against the template's own
 * `RoleName` by a test, which turns a drift into a failure instead of a deploy that cannot assume its
 * role.
 *
 * It sits outside shared/resource-name.ts's grammar for now — see the note there. Moving it costs a
 * CloudFormation replacement and an edit to every workflow that composes the ARN, which is its own
 * change rather than a rider on this one.
 */
export function githubDeployRoleName(stage: any) {
  requireStageLike('stage', stage)
  return `boxlite-${stage}-github-deploy`
}

// `aws --version` prints e.g. `aws-cli/2.35.11 Python/3.14.6 Darwin/27.0.0 source/arm64`.
export function parseAwsCliVersion(versionOutput: any) {
  const match = AWS_CLI_VERSION_PATTERN.exec((versionOutput ?? '').trim())
  if (!match) {
    throw new Error(`could not parse an AWS CLI version from '${versionOutput}' (expected 'aws-cli/X.Y.Z ...')`)
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

export function isAwsCliVersionAtLeast(versionOutput: any, minimum = MINIMUM_AWS_CLI_VERSION) {
  const actual = parseAwsCliVersion(versionOutput)
  const [major, minor, patch] = minimum.split('.').map(Number)
  const ordered = [
    [actual.major, major],
    [actual.minor, minor],
    [actual.patch, patch],
  ]
  for (const [left, right] of ordered) {
    if (left !== right) return left > right
  }
  return true
}

/*
 * IAM OIDC providers are account-global and `CreateOpenIDConnectProvider`
 * rejects a duplicate URL with EntityAlreadyExists — so a bootstrap that
 * unconditionally creates one breaks on every account that has ever wired
 * GitHub Actions to AWS. Detect first, create only when genuinely absent.
 */
export function hasGitHubOidcProvider(listOutput: any, url = GITHUB_OIDC_PROVIDER_URL) {
  const host = url.replace(/^https:\/\//, '')
  const providers = listOutput?.OpenIDConnectProviderList ?? []
  return providers.some(({ Arn }: any) => typeof Arn === 'string' && Arn.endsWith(`:oidc-provider/${host}`))
}

/*
 * Split the operator's local .env into the part that belongs in the stage's shared SST secret
 * store and the part that must stay on this machine.
 *
 * Two rules decide what is kept: the key must be one the deploy actually reads
 * (isStorableStageConfigKey, derived from source), and it must not be one that has to stay on this
 * machine (isLocalOnlyDeploymentKey — AWS_PROFILE, AWS_CLI_PATH, the artifact selectors CI owns, and
 * the keys consulted before the store can be reached at all). Anything else in .env is left here,
 * which is deliberate: an operator's file may hold all sorts of things, and only what a deploy reads
 * belongs in a store every deployer of the stage can read. They are kept OUT rather than made a hard error, because they
 * are legitimate locally — stack/app.ts reads AWS_PROFILE — so rejecting the file would leave an
 * operator who needs a named profile unable to bootstrap at all. Storing them would be worse than
 * either: a machine-specific `aws` path, or an artifact redirect, handed to every deployer of the
 * stage.
 *
 * Everything else is stored exactly as dotenv parsed it, empty values included. `KEY=` and an
 * absent key already mean the same thing to every consumer (envOr, requireEnv, and the
 * `process.env.X && {...}` spreads all treat '' as unset), so dropping blanks would add a rule
 * without changing a deploy.
 */
export function deployableStageConfig(source: any) {
  const parsed = parse(source ?? '')
  const config: Record<string, string> = {}
  const excluded = []
  for (const key of Object.keys(parsed).sort()) {
    if (!isStorableStageConfigKey(key) || isLocalOnlyDeploymentKey(key)) {
      excluded.push(key)
      continue
    }
    config[key] = parsed[key]
  }
  return { config, excluded }
}

/*
 * The stage config as a file `sst secret load` reads back byte-for-byte.
 *
 * sst's parser splits each line on the first `=`, trims both halves, and only then strips quotes.
 * The double-quoted form then runs an unescape pass over \" \n \r \t, so a value holding one of
 * those two-character sequences literally — `C:\new`, a token with a stray backslash — comes back
 * changed. The single-quoted form strips the quotes and does nothing else, so it round-trips, and
 * the quotes also protect a leading or trailing space from the trim and a `#` from being read as
 * the start of a comment.
 *
 * A value containing a single quote or a newline has no such representation. Refuse it here rather
 * than store a mangled token, which would surface much later as an opaque auth failure. The value
 * itself stays out of the message — this runs over credentials.
 */
export function serializeStageConfig(config: any) {
  const lines = Object.keys(config ?? {})
    .sort()
    .map((key) => {
      const value = String(config[key])
      if (/['\r\n]/.test(value)) {
        throw new Error(`${key} contains a single quote or newline, which the stage configuration store cannot represent`)
      }
      return `${key}='${value}'`
    })
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

/*
 * Whether sst's platform directory is usable. sst writes package.json on its
 * first run and only then installs the deps, so "package.json but no
 * node_modules" is the signature of an install that started and did not finish
 * — which is exactly what a stalled bun leaves behind.
 */
export function sstPlatformState(dir: any) {
  if (!existsSync(join(dir, 'package.json'))) return 'absent'
  try {
    return readdirSync(join(dir, 'node_modules')).length > 0 ? 'ready' : 'deps-missing'
  } catch {
    return 'deps-missing'
  }
}

/*
 * Everything one `sst secret load` will write, decided in one place.
 *
 * Both the values and the bookkeeping that describes them — the manifest of key names and the digest
 * hydration verifies against — because they have to go into the same load. Written apart, an
 * interruption between them leaves values whose digest describes a different generation, which is the
 * failure the digest exists to catch rather than cause.
 *
 * Pure, so bootstrap's .env-to-store wiring is checkable without an AWS account: the arguments, the
 * manifest and the refusals are all decided here.
 */
export function prepareStageConfigLoad(source: any) {
  const { config, excluded } = deployableStageConfig(source)
  const storedKeys = Object.keys(config)
  if (storedKeys.length === 0) {
    throw new Error(
      'defines no deployable stage configuration — every key is local-only or unread by the deploy',
    )
  }

  const manifest = serializeStageConfigManifest(storedKeys)
  return {
    excluded,
    storedKeys,
    payload: {
      ...config,
      [STAGE_CONFIG_MANIFEST_KEY]: manifest,
      // Over the manifest's own keys rather than over `config`, so the two sides hash the same list:
      // hydration has only the manifest to go by. A value that reaches the store without being named
      // is then outside the digest, which is correct — an unnamed key is never hydrated either.
      [STAGE_CONFIG_DIGEST_KEY]: stageConfigDigest(parseStageConfigManifest(manifest), config),
    },
  }
}