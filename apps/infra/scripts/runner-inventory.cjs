// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

const MAX_RUNNER_COUNT = 100
const RUNNER_NAME_PATTERN = /^[a-zA-Z0-9_.-]+$/
const RUNNER_RESOURCE_TYPE = 'aws:ec2/instance:Instance'
const RUNNER_RESOURCE_NAME_PATTERN = /^Runner(?:-runner-[1-9][0-9]*)?$/
const RUNNER_RESOURCE_CANDIDATE_PATTERN = /^Runner(?:-|$)/
const CONTROL_PLANE_NAME_TAG = 'boxlite:control-plane-runner-name'
const RUNNER_STAGE_TAG = 'boxlite:stage'
const RUNNER_ROLE_TAG = 'boxlite:ssm-role'
const RUNNER_ROLE_VALUE = 'runner'
const SST_STAGE_PATTERN = /^[a-z0-9]{1,20}$/

function extraRunnerInstanceProfileName(stage) {
  const name = `boxlite-${stage}-extra-runner-profile`
  if (typeof stage !== 'string' || !SST_STAGE_PATTERN.test(stage) || name.length > 128) {
    throw new Error('invalid SST stage for the extra Runner instance profile')
  }
  return name
}

function hasRunnerIdentityTags(properties) {
  for (const tags of [properties?.tags, properties?.tagsAll]) {
    if (!tags || typeof tags !== 'object' || Array.isArray(tags)) continue
    if (typeof tags.Name === 'string' && tags.Name.startsWith('boxlite-runner-')) return true
    if (Object.prototype.hasOwnProperty.call(tags, CONTROL_PLANE_NAME_TAG)) return true
  }
  return false
}

function isRunnerLikeResource({ name, type, properties }, expectedResourceNames = new Set()) {
  if (expectedResourceNames.has(name) || RUNNER_RESOURCE_CANDIDATE_PATTERN.test(name || '')) return true
  return type === RUNNER_RESOURCE_TYPE && hasRunnerIdentityTags(properties)
}

function resolveRunnerCount(configuredCount) {
  const runnerCount = configuredCount || '1'
  if (!/^[1-9][0-9]*$/.test(runnerCount)) {
    throw new Error(`RUNNERS must be an integer between 1 and ${MAX_RUNNER_COUNT}`)
  }

  const parsedCount = Number(runnerCount)
  if (!Number.isSafeInteger(parsedCount) || parsedCount > MAX_RUNNER_COUNT) {
    throw new Error(`RUNNERS must be an integer between 1 and ${MAX_RUNNER_COUNT}`)
  }
  return parsedCount
}

function requireValidRunnerName(name) {
  if (name.length < 2 || name.length > 255 || !RUNNER_NAME_PATTERN.test(name)) {
    throw new Error(
      'DEFAULT_RUNNER_NAME must be 2-255 characters containing only letters, numbers, underscores, periods, and hyphens',
    )
  }
}

function resolveRunnerInventory(environment = process.env) {
  const totalRunners = resolveRunnerCount(environment.RUNNERS)
  const defaultRunnerName = environment.DEFAULT_RUNNER_NAME || 'default'
  requireValidRunnerName(defaultRunnerName)

  const inventory = Array.from({ length: totalRunners }, (_, offset) => {
    const index = offset + 1
    if (index === 1) {
      return {
        resourceName: 'Runner',
        nameTag: 'boxlite-runner-default',
        controlPlaneRunnerName: defaultRunnerName,
      }
    }

    return {
      resourceName: `Runner-runner-${index}`,
      nameTag: `boxlite-runner-${index}`,
      controlPlaneRunnerName: `runner-${index}`,
    }
  })

  const runnerNames = new Set(inventory.map((runner) => runner.controlPlaneRunnerName))
  if (runnerNames.size !== inventory.length) {
    throw new Error('Runner names must be unique within the deployment inventory')
  }

  return inventory
}

module.exports = {
  CONTROL_PLANE_NAME_TAG,
  RUNNER_ROLE_TAG,
  RUNNER_ROLE_VALUE,
  RUNNER_STAGE_TAG,
  RUNNER_RESOURCE_CANDIDATE_PATTERN,
  RUNNER_RESOURCE_NAME_PATTERN,
  RUNNER_RESOURCE_TYPE,
  extraRunnerInstanceProfileName,
  hasRunnerIdentityTags,
  isRunnerLikeResource,
  resolveRunnerInventory,
}
