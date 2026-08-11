// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import runnerInventory from './runner-inventory.cjs'
import runnerInstanceIdentity from './runner-instance-identity.cjs'

const { RUNNER_ROLE_VALUE, extraRunnerInstanceProfileName } = runnerInventory
const {
  parseEc2InstanceId,
  parseRunnerCommandAuthorizationTags,
  parseRunnerEc2Instances,
} = runnerInstanceIdentity

export { parseRunnerEc2Instances }

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireValidInstanceId(instanceId, message) {
  try {
    return parseEc2InstanceId(instanceId, message)
  } catch {
    throw new Error(message)
  }
}

export function evaluateRunnerCommandTagGate({
  previousEnabled,
  stage,
  desiredInventory,
  baseline,
  instances,
}) {
  if (typeof previousEnabled !== 'boolean') throw new Error('previous Runner command tag gate state must be boolean')
  extraRunnerInstanceProfileName(stage)
  if (baseline?.stage !== stage || !isObject(baseline?.resources)) {
    throw new Error('Runner state baseline does not match the selected stage')
  }
  if (!Array.isArray(desiredInventory) || !Array.isArray(instances)) {
    throw new Error('Runner command tag gate requires declared inventory and EC2 metadata')
  }

  const desiredNames = new Set()
  for (const runner of desiredInventory) {
    if (typeof runner?.resourceName !== 'string' || desiredNames.has(runner.resourceName)) {
      throw new Error('declared Runner inventory is invalid')
    }
    desiredNames.add(runner.resourceName)
  }

  const expectedIds = new Map()
  for (const [resourceName, resource] of Object.entries(baseline.resources)) {
    if (!desiredNames.has(resourceName)) {
      throw new Error('Runner state contains an instance outside the declared inventory')
    }
    const instanceId = resource?.instanceId
    if (expectedIds.has(instanceId)) {
      throw new Error('Runner state baseline contains an invalid or duplicate instance id')
    }
    expectedIds.set(
      requireValidInstanceId(instanceId, 'Runner state baseline contains an invalid or duplicate instance id'),
      resourceName,
    )
  }

  const observedById = new Map()
  for (const instance of instances) {
    const instanceId = instance?.InstanceId
    if (observedById.has(instanceId)) {
      throw new Error('EC2 returned an invalid or duplicate EC2 instance')
    }
    observedById.set(
      requireValidInstanceId(instanceId, 'EC2 returned an invalid or duplicate EC2 instance'),
      instance,
    )
  }

  let allExistingRunnersAuthorized = true
  for (const [instanceId] of expectedIds) {
    const instance = observedById.get(instanceId)
    if (!instance) throw new Error('a Runner state instance is missing from EC2')
    if (['shutting-down', 'terminated'].includes(instance.State?.Name)) {
      throw new Error('every Runner state instance must be nonterminated')
    }
    const tags = parseRunnerCommandAuthorizationTags(instance)
    if (tags.stage !== stage || tags.role !== RUNNER_ROLE_VALUE) allExistingRunnersAuthorized = false
  }

  for (const [instanceId, instance] of observedById) {
    const tags = parseRunnerCommandAuthorizationTags(instance)
    if (expectedIds.has(instanceId) || !tags.hasAny) continue
    let hasValidOtherStage = false
    try {
      extraRunnerInstanceProfileName(tags.stage)
      hasValidOtherStage = tags.stage !== stage && tags.role === RUNNER_ROLE_VALUE
    } catch {
      hasValidOtherStage = false
    }
    if (!hasValidOtherStage) throw new Error('EC2 contains an extra auth-tagged EC2 instance outside Runner state')
  }

  const desiredRunnersMissingFromState = [...desiredNames].filter(
    (resourceName) => !Object.prototype.hasOwnProperty.call(baseline.resources, resourceName),
  )
  if (previousEnabled && desiredRunnersMissingFromState.includes('Runner')) {
    throw new Error('the enabled Runner command tag gate requires the default Runner in state')
  }
  const canEnable = allExistingRunnersAuthorized && desiredRunnersMissingFromState.length === 0
  if (previousEnabled && !allExistingRunnersAuthorized) {
    throw new Error('the enabled Runner command tag gate cannot be downgraded')
  }
  if (previousEnabled) return true
  return canEnable
}
