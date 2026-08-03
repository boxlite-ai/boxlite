// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * The Api's published image: where it lives, and whether it is actually there.
 *
 * Both CI paths hand SST an image reference instead of a build context, so nothing in the deploy
 * ever compiles the Api — which is the point, since the artifact that reaches a stage should be
 * the one that was tested. A release deploys the image built for a version; a build deploys the
 * image its own workflow built for the selected commit, the way the Runner already worked. That
 * also means a missing or mistyped tag is not discovered until the ECS task fails to pull, long
 * after SST has started mutating the stack. This module is the preflight that turns it into a
 * refusal on the deployer instead.
 *
 * A deploy that resolves no ref still gets a build context: that is a developer running
 * `npm run deploy` against their own stage with nothing published, and demanding a CI image
 * there would make the local path depend on the remote one.
 *
 * The repository is named rather than looked up: the stage bootstrap
 * (ci/github-deploy-role.yaml) creates it because CI has to push into it before any deploy can
 * read it, so the consumer cannot be the thing that creates it. Both sides spell the name through
 * the same grammar — see resource-name.mjs.
 */

import { execFileSync } from 'node:child_process'

import { awsResourceName } from './resource-name.mjs'

// ECR's own rule, minus the uppercase it never allows: a stage that cannot name a repository
// should fail here rather than as an opaque AWS validation error mid-deploy.
const REPOSITORY_NAME = /^[a-z0-9][a-z0-9._/-]{1,255}$/
// ECR's tag rule, for the same reason. A commit tag is 47 characters, well inside the 128 limit.
const IMAGE_TAG = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/

export function apiImageRepository({ app, stage }) {
  const repository = awsResourceName({ app, stage, name: 'api' })
  if (!REPOSITORY_NAME.test(repository)) {
    throw new Error(`Api stage '${stage}' does not produce a valid ECR repository name`)
  }
  return repository
}

// What a tag names. A release names a version, so the tag is that version. A build names one
// commit, so it carries the ref as well — the same version+ref identity the Runner's tarball uses
// (runner-artifact.mjs), which keeps the two components addressable by the same pair. Distinct
// shapes also mean a commit build can never land on the tag a release promotes, in a repository
// where tags are immutable and a collision would be unrepairable.
export function apiImageTag({ version, ref }) {
  const tag = ref ? `v${version}-${ref}` : `${version}`
  if (!IMAGE_TAG.test(tag)) {
    throw new Error(`Api version '${version}'${ref ? ` at ${ref}` : ''} does not produce a valid image tag`)
  }
  return tag
}

export function apiImageReference({ app, stage, accountId, region, version, ref }) {
  const repository = apiImageRepository({ app, stage })
  return `${accountId}.dkr.ecr.${region}.amazonaws.com/${repository}:${apiImageTag({ version, ref })}`
}

// Proves the exact tag this deploy resolved to exists before SST runs. Returns the digest, so a
// caller can log which bytes it is about to deploy rather than only which tag.
export function verifyApiImage(
  { app, stage, region, version, ref },
  { awsCliPath = 'aws', environment = process.env, timeoutMs = 15_000, run = execFileSync } = {},
) {
  const repository = apiImageRepository({ app, stage })
  const tag = apiImageTag({ version, ref })
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
        `imageTag=${tag}`,
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
    throw new Error(`Api image ${repository}:${tag} is unavailable: ${detail}`, { cause: error })
  }

  digest = (digest || '').trim()
  // `--query` on a missing image yields the literal `None` with a zero exit, so an absent tag
  // would otherwise pass the preflight it exists to fail.
  if (!digest || digest === 'None') {
    throw new Error(`Api image ${repository}:${tag} is unavailable: no image digest was returned`)
  }
  return { repository, tag, digest }
}
