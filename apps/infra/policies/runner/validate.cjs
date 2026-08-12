// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

const {
  CONTROL_PLANE_NAME_TAG,
  RUNNER_ROLE_TAG,
  RUNNER_ROLE_VALUE,
  RUNNER_RESOURCE_TYPE,
  RUNNER_STAGE_TAG,
  extraRunnerInstanceProfileName,
  isRunnerLikeResource,
  resolveRunnerInventory,
} = require('../../scripts/runner-inventory.cjs')
const {
  createRunnerIdentityFingerprint,
  createRunnerProfileMigrationFingerprint,
  createRunnerSafetyFingerprint,
  hasExactIgnoredProperties,
} = require('../../scripts/runner-state-baseline.cjs')

function readTags(resource) {
  try {
    return resource.props?.tags
  } catch {
    return undefined
  }
}

function readTagsAll(resource) {
  try {
    return resource.props?.tagsAll
  } catch {
    return undefined
  }
}

function readTagValue(tags, key) {
  try {
    return tags[key]
  } catch {
    return undefined
  }
}

function isRunnerCandidate(resource, expectedByResourceName) {
  return isRunnerLikeResource(
    {
      name: resource.name,
      type: resource.type,
      properties: { tags: readTags(resource), tagsAll: readTagsAll(resource) },
    },
    new Set(expectedByResourceName.keys()),
  )
}

function isAllowedExtraRunnerProfileMigration(resource, currentProperties, baseline) {
  if (!/^Runner-runner-[1-9][0-9]*$/.test(resource.name)) return false
  if (resource.props?.iamInstanceProfile !== extraRunnerInstanceProfileName(baseline.stage)) return false
  return (
    createRunnerProfileMigrationFingerprint(resource.props) === currentProperties.profileMigrationFingerprint
  )
}

function validateRunnerResource(resource, inventory, baseline) {
  inventory ??= resolveRunnerInventory()
  const expectedByResourceName = new Map(inventory.map((runner) => [runner.resourceName, runner]))
  if (!isRunnerCandidate(resource, expectedByResourceName)) return []

  const expected = expectedByResourceName.get(resource.name)
  if (!expected) {
    return ['Runner identity is not declared by the deployment inventory.']
  }

  const violations = []
  if (resource.type !== RUNNER_RESOURCE_TYPE) {
    violations.push('Runner resources must remain EC2 instances.')
  }

  // The stage comes from the baseline, which this function accepts as optional.
  // Comparing the tag against `baseline?.stage` directly would let two
  // undefineds satisfy the assertion, so require an actual stage string first.
  const expectedStage = baseline?.stage
  const tags = readTags(resource)
  const hasExpectedIdentity =
    typeof expectedStage === 'string' &&
    expectedStage !== '' &&
    tags &&
    typeof tags === 'object' &&
    !Array.isArray(tags) &&
    readTagValue(tags, 'Name') === expected.nameTag &&
    readTagValue(tags, CONTROL_PLANE_NAME_TAG) === expected.controlPlaneRunnerName &&
    readTagValue(tags, RUNNER_STAGE_TAG) === expectedStage &&
    readTagValue(tags, RUNNER_ROLE_TAG) === RUNNER_ROLE_VALUE
  if (!hasExpectedIdentity) {
    violations.push('Runner identity tags must match the deployment inventory.')
  }

  if (resource.opts?.protect !== true) {
    violations.push('Runner resources must keep deletion protection enabled.')
  }
  if (!hasExactIgnoredProperties(resource.opts?.ignoreChanges)) {
    violations.push('Runner resources must ignore only AMI and user-data changes.')
  }

  const currentProperties = baseline?.resources?.[resource.name]
  if (currentProperties === undefined) {
    violations.push('Routine deployment must not create a Runner resource.')
  } else {
    try {
      const desiredFingerprint = createRunnerSafetyFingerprint(resource.props)
      if (
        desiredFingerprint !== currentProperties.inputFingerprint &&
        !isAllowedExtraRunnerProfileMigration(resource, currentProperties, baseline)
      ) {
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

function validateRunnerStack(resources, inventory, baseline) {
  inventory ??= resolveRunnerInventory()
  const expectedByResourceName = new Map(inventory.map((runner) => [runner.resourceName, runner]))
  const resourceCounts = new Map(inventory.map((runner) => [runner.resourceName, 0]))
  let undeclaredRunnerCount = 0

  for (const resource of resources) {
    if (!isRunnerCandidate(resource, expectedByResourceName)) continue

    if (resourceCounts.has(resource.name)) {
      resourceCounts.set(resource.name, resourceCounts.get(resource.name) + 1)
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

  const currentResourceNames = new Set(Object.keys(baseline?.resources ?? {}))
  const inventoryDiffersFromState =
    inventory.some((runner) => !currentResourceNames.has(runner.resourceName)) ||
    [...currentResourceNames].some((name) => !expectedByResourceName.has(name))
  if (inventoryDiffersFromState) {
    violations.push('Runner inventory differs from the current deployment state.')
  }

  return violations
}

module.exports = { validateRunnerResource, validateRunnerStack }
