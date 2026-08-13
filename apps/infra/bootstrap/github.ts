// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Pure helpers for creating the deployment stage's GitHub Environment.
 *
 * The deploy workflow binds to `environment: ${{ inputs.stage }}` and reads
 * `AWS_DEPLOY_ROLE_ARN`/`AWS_REGION`/`DEPLOY_ENV` from it, and the AWS trust
 * policy pins `repo:<owner>/<repo>:environment:<stage>` — so the Environment
 * must exist, under exactly that name, before any of it works.
 *
 * `PUT /repos/{owner}/{repo}/environments/{name}` is create-or-update, which
 * is what makes rerunning the bootstrap safe.
 */

// Protection rules are a paid feature on private repositories: "Users with
// GitHub Free plans can only configure environments for public repositories."
// A self-hoster on a private free repo can still deploy — they just get an
// unprotected environment — so a 422 here must not abort the bootstrap.
const PROTECTION_UNAVAILABLE_PATTERN = /(only available|not available|upgrade|advanced security|payment)/i

export function githubEnvironmentPayload({ reviewerIds = [] }: { reviewerIds?: unknown[] } = {}) {
  if (!Array.isArray(reviewerIds)) throw new Error('reviewerIds must be an array of numeric GitHub actor ids')
  for (const id of reviewerIds) {
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
      throw new Error(`reviewer id '${id}' must be a positive integer (GitHub user/team id, not a login)`)
    }
  }

  return {
    // GitHub rejects an empty `reviewers` array differently across plans; omit
    // the key entirely when there is nobody to require, so an unprotected
    // environment is still created cleanly.
    ...(reviewerIds.length > 0 ? { reviewers: reviewerIds.map((id) => ({ type: 'User', id: id as number })) } : {}),
    deployment_branch_policy: null,
  }
}

export function environmentApiPath(repo: any, stage: any) {
  return `repos/${repo}/environments/${stage}`
}

/*
 * Distinguish "this plan cannot do protection rules" (degrade: the environment
 * itself still needs to exist) from a real failure the operator must fix.
 */
export function isProtectionUnavailableError(stderr: any) {
  return PROTECTION_UNAVAILABLE_PATTERN.test(stderr ?? '')
}

export function parseReviewerIds(rawReviewers: any) {
  if (rawReviewers === undefined || rawReviewers === '') return []
  return rawReviewers
    .split(',')
    .map((entry: any) => entry.trim())
    .filter(Boolean)
    .map((entry: any) => {
      if (!/^\d+$/.test(entry)) {
        throw new Error(`--reviewers expects numeric GitHub user ids, received '${entry}'`)
      }
      return Number(entry)
    })
}
