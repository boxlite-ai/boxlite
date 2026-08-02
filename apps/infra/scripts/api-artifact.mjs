// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * The Api's published image: where it lives, and whether it is actually there.
 *
 * Release mode hands SST an image reference instead of a build context, so nothing in the deploy
 * ever compiles the Api — which is the point, since the artifact that reaches a stage should be
 * the one that was tested. That also means a missing or mistyped tag is not discovered until the
 * ECS task fails to pull, long after SST has started mutating the stack. This module is the
 * preflight that turns it into a refusal on the deployer instead.
 *
 * The repository is named rather than looked up: the stage bootstrap
 * (ci/github-deploy-role.yaml) creates `<app>-<stage>-api` because CI has to push into it before
 * any deploy can read it, so the consumer cannot be the thing that creates it.
 */

import { execFileSync } from 'node:child_process'

// ECR's own rule, minus the uppercase it never allows: a stage that cannot name a repository
// should fail here rather than as an opaque AWS validation error mid-deploy.
const REPOSITORY_NAME = /^[a-z0-9][a-z0-9._/-]{1,255}$/

export function apiImageRepository({ app, stage }) {
  const repository = `${app}-${stage}-api`
  if (!REPOSITORY_NAME.test(repository)) {
    throw new Error(`Api stage '${stage}' does not produce a valid ECR repository name`)
  }
  return repository
}

export function apiImageReference({ app, stage, accountId, region, version }) {
  return `${accountId}.dkr.ecr.${region}.amazonaws.com/${apiImageRepository({ app, stage })}:${version}`
}

// Proves the exact tag this deploy resolved to exists before SST runs. Returns the digest, so a
// caller can log which bytes it is about to deploy rather than only which tag.
export function verifyApiReleaseImage(
  { app, stage, region, version },
  { awsCliPath = 'aws', environment = process.env, timeoutMs = 15_000, run = execFileSync } = {},
) {
  const repository = apiImageRepository({ app, stage })
  let digest
  try {
    digest = run(
      awsCliPath,
      [
        'ecr',
        'describe-images',
        '--region',
        region,
        '--repository-name',
        repository,
        '--image-ids',
        `imageTag=${version}`,
        '--query',
        'imageDetails[0].imageDigest',
        '--output',
        'text',
      ],
      {
        encoding: 'utf8',
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        killSignal: 'SIGTERM',
      },
    )
  } catch (error) {
    const detail = error.stderr?.trim() || error.message
    throw new Error(`Api release image ${repository}:${version} is unavailable: ${detail}`, { cause: error })
  }

  digest = (digest || '').trim()
  // `--query` on a missing image yields the literal `None` with a zero exit, so an absent tag
  // would otherwise pass the preflight it exists to fail.
  if (!digest || digest === 'None') {
    throw new Error(`Api release image ${repository}:${version} is unavailable: no image digest was returned`)
  }
  return { repository, digest }
}
