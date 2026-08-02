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

function requireStageLike(name, value) {
  if (!value || !STAGE_LIKE_PATTERN.test(value)) {
    throw new Error(`${name} '${value}' must match ${STAGE_LIKE_PATTERN}`)
  }
  return value
}

export function validateGitHubRepo(repo) {
  if (!repo || !GITHUB_REPO_PATTERN.test(repo)) {
    throw new Error(`repo '${repo}' must look like 'owner/name'`)
  }
  return repo
}

// Mirrors sst.config.ts's own `${$app.name}-${$app.stage}-runtime-boundary`
// interpolation (apps/infra/sst.config.ts:131) — this script and the SST run
// must agree on the boundary policy name without either importing the other.
export function runtimeBoundaryPolicyArn({ accountId, appName, stage }) {
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
export function githubDeployRoleStackName(stage) {
  requireStageLike('stage', stage)
  return `boxlite-${stage}-github-deploy`
}

export function cloudFormationParameterOverrides({ repo, stage }) {
  validateGitHubRepo(repo)
  requireStageLike('stage', stage)
  return [`GitHubRepository=${repo}`, `GitHubEnvironment=${stage}`]
}

// `aws cloudformation deploy --no-fail-on-empty-changeset` exits 0 whether or
// not anything changed; the only signal is this literal stdout line, so the
// script can report "already up to date" instead of claiming every rerun
// made a change.
export function cloudFormationDeployChanged(stdout) {
  return !stdout.includes('No changes to deploy')
}

export function ssmParameterName(stage, param) {
  requireStageLike('stage', stage)
  if (!param) throw new Error('param is required')
  return `/boxlite/${stage}/${param}`
}

/**
 * `/boxlite/<stage>/<param>` already holds a value from a previous run —
 * decide what this run does about it.
 *
 * This script has to stay idempotent for two different operators: BoxLite's
 * own reruns, and a community fork's operator running it against their own
 * AWS account, possibly months apart. "Already exists" therefore needs a
 * deliberate answer instead of whatever a generic overwrite-or-skip default
 * would do:
 *
 *   'skip'   — leave the existing value alone. Safest: never clobbers a
 *              token that may have been rotated or hand-edited since the
 *              last run. Matches how `sst-with-cloudflare.mjs` already
 *              treats a credential found in the environment — used as-is,
 *              never re-probed (scripts/sst-with-cloudflare.mjs:164-165).
 *   'prompt' — always re-collect and overwrite. Simplest mental model: the
 *              parameter always ends up matching whatever was just typed,
 *              at the cost of retyping a token on every rerun.
 *
 * `force` is the operator's explicit `--force` CLI flag and should always
 * win, in whichever direction makes sense for the answer below.
 *
 * @param {{ exists: boolean, force: boolean }} args
 * @returns {'skip' | 'prompt'}
 */
export function decideSsmOverwrite({ exists, force }) {
  if (!exists) return 'prompt' // nothing to protect yet
  return force ? 'prompt' : 'skip'
}

// `aws --version` prints e.g. `aws-cli/2.35.11 Python/3.14.6 Darwin/27.0.0 source/arm64`.
export function parseAwsCliVersion(versionOutput) {
  const match = AWS_CLI_VERSION_PATTERN.exec((versionOutput ?? '').trim())
  if (!match) {
    throw new Error(`could not parse an AWS CLI version from '${versionOutput}' (expected 'aws-cli/X.Y.Z ...')`)
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

export function isAwsCliVersionAtLeast(versionOutput, minimum = MINIMUM_AWS_CLI_VERSION) {
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
export function hasGitHubOidcProvider(listOutput, url = GITHUB_OIDC_PROVIDER_URL) {
  const host = url.replace(/^https:\/\//, '')
  const providers = listOutput?.OpenIDConnectProviderList ?? []
  return providers.some(({ Arn }) => typeof Arn === 'string' && Arn.endsWith(`:oidc-provider/${host}`))
}

/*
 * Whether sst's platform directory is usable. sst writes package.json on its
 * first run and only then installs the deps, so "package.json but no
 * node_modules" is the signature of an install that started and did not finish
 * — which is exactly what a stalled bun leaves behind.
 */
export function sstPlatformState(dir) {
  if (!existsSync(join(dir, 'package.json'))) return 'absent'
  try {
    return readdirSync(join(dir, 'node_modules')).length > 0 ? 'ready' : 'deps-missing'
  } catch {
    return 'deps-missing'
  }
}
