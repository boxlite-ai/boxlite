// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

// eslint-disable-next-line @nx/enforce-module-boundaries -- The policy pack and deployment share one Runner identity model.
import {
  CONTROL_PLANE_NAME_TAG,
  RUNNER_RESOURCE_TYPE,
  isRunnerLikeResource,
  resolveRunnerInventory,
} from '../../runner/model/inventory.ts'
// eslint-disable-next-line @nx/enforce-module-boundaries -- The policy pack and deployment share one Runner state model.
import {
  createRunnerIdentityFingerprint,
  createRunnerSafetyFingerprint,
  hasExactIgnoredProperties,
} from '../../runner/model/state-baseline.ts'

function readTags(resource: any) {
  try {
    return resource.props?.tags
  } catch {
    return undefined
  }
}

function readTagsAll(resource: any) {
  try {
    return resource.props?.tagsAll
  } catch {
    return undefined
  }
}

function readTagValue(tags: any, key: any) {
  try {
    return tags[key]
  } catch {
    return undefined
  }
}

function isRunnerCandidate(resource: any, expectedByResourceName: any) {
  return isRunnerLikeResource(
    {
      name: resource.name,
      type: resource.type,
      properties: { tags: readTags(resource), tagsAll: readTagsAll(resource) },
    },
    new Set(expectedByResourceName.keys()),
  )
}

export function validateRunnerResource(resource: any, inventory: any, baseline: any) {
  inventory ??= resolveRunnerInventory()
  const expectedByResourceName = new Map<string, any>(inventory.map((runner: any) => [runner.resourceName, runner]))
  if (!isRunnerCandidate(resource, expectedByResourceName)) return []

  const expected = expectedByResourceName.get(resource.name)
  if (!expected) {
    return ['Runner identity is not declared by the deployment inventory.']
  }

  const violations = []
  if (resource.type !== RUNNER_RESOURCE_TYPE) {
    violations.push('Runner resources must remain EC2 instances.')
  }

  const tags = readTags(resource)
  const hasExpectedIdentity =
    tags &&
    typeof tags === 'object' &&
    !Array.isArray(tags) &&
    readTagValue(tags, 'Name') === expected.nameTag &&
    readTagValue(tags, CONTROL_PLANE_NAME_TAG) === expected.controlPlaneRunnerName
  if (!hasExpectedIdentity) {
    violations.push('Runner identity tags must match the deployment inventory.')
  }

  if (resource.opts?.protect !== true) {
    violations.push('Runner resources must keep deletion protection enabled.')
  }
  if (!hasExactIgnoredProperties(resource.opts?.ignoreChanges)) {
    violations.push('Runner resources must ignore only AMI and user-data changes.')
  }

  // A Runner the state does not hold yet is a create, and a create has nothing to be compared
  // against — so the two fingerprint checks below are skipped rather than failed. Everything above
  // still applies: a host this deploy is about to create is protected, ignores the same two
  // properties, and carries the same identity as one that has been running for months.
  const currentProperties = baseline?.resources?.[resource.name]
  if (currentProperties !== undefined) {
    try {
      const desiredFingerprint = createRunnerSafetyFingerprint(resource.props)
      if (desiredFingerprint !== currentProperties.inputFingerprint) {
        violations.push('Runner protected properties must match the current deployment state.')
      }
    } catch {
      violations.push('Runner protected properties could not be resolved for comparison.')
    }
    if (hasExpectedIdentity) {
      try {
        const desiredIdentityFingerprint = createRunnerIdentityFingerprint(resource.props, resource.name)
        if (desiredIdentityFingerprint !== currentProperties.identityFingerprint) {
          violations.push('Runner identity tags must match the current deployment state.')
        }
      } catch {
        violations.push('Runner identity tags could not be resolved for comparison.')
      }
    }
  }

  return violations
}

export function validateRunnerStack(resources: any, inventory: any, baseline: any) {
  inventory ??= resolveRunnerInventory()
  const expectedByResourceName = new Map<string, any>(inventory.map((runner: any) => [runner.resourceName, runner]))
  const resourceCounts = new Map<string, number>(inventory.map((runner: any) => [runner.resourceName, 0]))
  let undeclaredRunnerCount = 0

  for (const resource of resources) {
    if (!isRunnerCandidate(resource, expectedByResourceName)) continue

    if (resourceCounts.has(resource.name)) {
      const resourceCount = resourceCounts.get(resource.name)
      if (resourceCount !== undefined) resourceCounts.set(resource.name, resourceCount + 1)
    } else {
      undeclaredRunnerCount += 1
    }
  }

  const violations = []
  for (const resourceCount of resourceCounts.values()) {
    if (resourceCount === 0) violations.push('Runner inventory is missing a declared resource.')
    if (resourceCount > 1) violations.push('Runner inventory contains a duplicate declared resource.')
  }
  if (undeclaredRunnerCount > 0) {
    violations.push('Runner inventory contains an undeclared resource.')
  }

  // Only one direction of inventory/state drift is refused. A declared Runner the state lacks is
  // growth, and this pack lets a deploy create it; a state resource the inventory has stopped
  // declaring is a scale-down, which Pulumi reads as a delete of a protected host holding live
  // microVMs — the one shape no deploy of this stack may plan.
  const currentResourceNames = Object.keys(baseline?.resources ?? {})
  if (currentResourceNames.some((name) => !expectedByResourceName.has(name))) {
    violations.push('Runner inventory must keep declaring every Runner the deployment state holds.')
  }

  return violations
}

export default { validateRunnerResource, validateRunnerStack }
