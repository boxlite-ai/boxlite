// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { execFileSync } from 'node:child_process'

/** Preserve existing GitHub Environment rules. Reviewers are configured when bootstrap creates an Environment.
 * Cloud identity variables belong to that Environment; mstage reads application values from its encrypted stage store.
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

export function ensureGithubEnvironment(
  { repo, stage, reviewerIds }: { repo: string; stage: string; reviewerIds: number[] },
  run = execFileSync,
) {
  const path = environmentApiPath(repo, stage)
  try {
    const existing = JSON.parse(
      run('gh', ['api', path], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }),
    )
    if (
      stage === 'prod' &&
      !existing.protection_rules?.some(
        (rule: { type: string; reviewers?: unknown[] }) => rule.type === 'required_reviewers' && rule.reviewers?.length,
      )
    ) {
      throw new Error('Existing prod GitHub Environment needs required reviewers before bootstrap')
    }
    return
  } catch (error: any) {
    if (!/\(HTTP 404\)/.test(error.stderr?.toString() ?? '')) throw error
  }
  const payload = githubEnvironmentPayload({ reviewerIds })
  try {
    run('gh', ['api', '--method', 'PUT', environmentApiPath(repo, stage), '--input', '-'], {
      input: JSON.stringify(payload),
      stdio: ['pipe', 'ignore', 'pipe'],
      timeout: 30_000,
      killSignal: 'SIGTERM',
    })
    const reviewers = reviewerIds.length > 0 ? `required reviewers: ${reviewerIds.join(', ')}` : 'no required reviewers'
    console.log(`==> GitHub ${stage} environment`)
    console.log(`    ready (${reviewers})`)
    return
  } catch (error: any) {
    const stderr = error.stderr?.toString() ?? ''
    if (!isProtectionUnavailableError(stderr) || reviewerIds.length === 0) throw error

    // Fail closed on the protected stage. Everywhere else an unprotected
    // environment is a downgrade worth taking to keep bootstrap moving; for
    // prod it would silently produce the thing the reviewers exist to prevent
    // — a stage anyone who can run the workflow can deploy unreviewed.
    if (stage === 'prod') {
      throw new Error(
        `refusing to create the GitHub '${stage}' environment without required reviewers: ` +
          'deployment protection rules need a public repository, or GitHub Pro/Team/Enterprise ' +
          'on a private one. Enable protection for this repository, then rerun.',
        { cause: error },
      )
    }

    // Protection rules need a public repo, or a paid plan on a private one.
    // The environment itself still has to exist for vars/secrets to land, so
    // fall back to an unprotected one rather than blocking the bootstrap.
    run('gh', ['api', '--method', 'PUT', environmentApiPath(repo, stage), '--input', '-'], {
      input: JSON.stringify(githubEnvironmentPayload({ reviewerIds: [] })),
      stdio: ['pipe', 'ignore', 'inherit'],
      timeout: 30_000,
      killSignal: 'SIGTERM',
    })
    console.warn(`==> GitHub ${stage} environment`)
    console.warn(
      '    created WITHOUT required reviewers ' +
        '(deployment protection rules need a public repository, or GitHub Pro/Team/Enterprise on a private one). ' +
        'Anyone who can run the workflow can deploy this stage unreviewed.',
    )
  }
}
