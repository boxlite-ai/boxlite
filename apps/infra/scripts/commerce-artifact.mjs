// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * The Commerce service's published image: where it lives.
 *
 * Sibling of api-artifact.mjs, and for the same reason — nothing in the deploy compiles this
 * service, so the reference SST receives has to be assembled and checked somewhere other than
 * inline in sst.config.ts, where a mistyped tag would only surface as an ECS pull failure long
 * after SST began mutating the stack.
 *
 * It differs from the Api in one way worth stating: the source lives in another repository
 * (boxlite-ai/boxlite-commerce), whose own publish-image workflow pushes each commit into this
 * account's private ECR. So there is no build-context fallback — a stage with no published image
 * has no way to produce one locally, which is why the caller omits the service entirely rather
 * than handing SST a reference that cannot resolve.
 *
 * The repository is named, not looked up, through the same grammar as every other name here; see
 * resource-name.mjs.
 */

import { awsResourceName } from './resource-name.mjs'

// ECR's own rules. api-artifact.mjs states the same two constraints for the same reason: a stage
// that cannot name a repository, or a tag ECR would reject, should fail on the deployer rather
// than as an opaque AWS validation error mid-deploy.
const REPOSITORY_NAME = /^[a-z0-9][a-z0-9._/-]{1,255}$/
const IMAGE_TAG = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/

export function commerceImageRepository({ app, stage }) {
  const repository = awsResourceName({ app, stage, name: 'commerce' })
  if (!REPOSITORY_NAME.test(repository)) {
    throw new Error(`Commerce stage '${stage}' does not produce a valid ECR repository name`)
  }
  return repository
}

/**
 * The image reference for a stage, or undefined when the stage has no tag selected.
 *
 * Returning undefined rather than throwing is deliberate: a stage without a published commerce
 * image is a normal state (only the stages whose workflow has pushed one have it), and the caller
 * responds by not declaring the service at all. Throwing would make every unrelated deploy of
 * every other stage depend on this one.
 */
export function commerceImageReference({ app, stage, accountId, region, tag }) {
  if (!tag) {
    return undefined
  }
  if (!IMAGE_TAG.test(tag)) {
    throw new Error(`COMMERCE_IMAGE_TAG '${tag}' is not a valid ECR image tag`)
  }
  const repository = commerceImageRepository({ app, stage })
  return `${accountId}.dkr.ecr.${region}.amazonaws.com/${repository}:${tag}`
}
