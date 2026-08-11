// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

const {
  RUNNER_ROLE_TAG,
  RUNNER_ROLE_VALUE,
  RUNNER_STAGE_TAG,
  extraRunnerInstanceProfileName,
} = require('./runner-inventory.cjs')

const EC2_INSTANCE_ID_PATTERN = /^i-(?:[0-9a-f]{8}|[0-9a-f]{17})$/
const MAX_RUNNER_TARGETS = 100

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseEc2InstanceId(value, message = 'Runner instance ids must use an EC2 i- identifier') {
  if (typeof value !== 'string' || !EC2_INSTANCE_ID_PATTERN.test(value)) throw new Error(message)
  return value
}

function validateRunnerInstanceIds(instanceIds) {
  if (!Array.isArray(instanceIds) || instanceIds.length === 0 || instanceIds.length > MAX_RUNNER_TARGETS) {
    throw new Error(`Runner instance ids must contain between 1 and ${MAX_RUNNER_TARGETS} targets`)
  }
  for (const instanceId of instanceIds) parseEc2InstanceId(instanceId)
  if (new Set(instanceIds).size !== instanceIds.length) throw new Error('Runner instance ids must be unique')
  return [...instanceIds]
}

function parseExplicitRunnerInstanceIds(environment = process.env) {
  if (!Object.prototype.hasOwnProperty.call(environment, 'INSTANCE_IDS') || environment.INSTANCE_IDS === undefined) {
    return undefined
  }
  if (typeof environment.INSTANCE_IDS !== 'string') {
    throw new Error('Runner instance ids must be a comma-separated string')
  }

  const instanceIds = environment.INSTANCE_IDS.split(',').map((instanceId) => instanceId.trim())
  if (instanceIds.some((instanceId) => instanceId.length === 0)) {
    throw new Error('Runner instance ids must not contain empty segments')
  }
  return validateRunnerInstanceIds(instanceIds)
}

function parseRunnerCommandAuthorizationTags(instance) {
  const instanceTags = instance?.Tags ?? []
  if (!Array.isArray(instanceTags)) throw new Error('EC2 instance metadata has invalid tags')
  const wanted = new Map([
    [RUNNER_STAGE_TAG.toLowerCase(), []],
    [RUNNER_ROLE_TAG.toLowerCase(), []],
  ])
  for (const tag of instanceTags) {
    if (!isObject(tag) || typeof tag.Key !== 'string' || typeof tag.Value !== 'string') {
      throw new Error('EC2 instance metadata has invalid tags')
    }
    const matches = wanted.get(tag.Key.toLowerCase())
    if (!matches) continue
    const canonicalKey = tag.Key.toLowerCase() === RUNNER_STAGE_TAG.toLowerCase() ? RUNNER_STAGE_TAG : RUNNER_ROLE_TAG
    if (tag.Key !== canonicalKey) throw new Error('EC2 instance has a case-variant command-authorization tag')
    matches.push(tag.Value)
  }
  for (const values of wanted.values()) {
    if (values.length > 1) throw new Error('EC2 instance has a duplicate command-authorization tag')
  }
  return {
    hasAny: [...wanted.values()].some((values) => values.length > 0),
    role: wanted.get(RUNNER_ROLE_TAG.toLowerCase())[0],
    stage: wanted.get(RUNNER_STAGE_TAG.toLowerCase())[0],
  }
}

function parseRunnerEc2Instances(source) {
  let response
  try {
    response = typeof source === 'string' ? JSON.parse(source) : source
  } catch {
    throw new Error('could not verify Runner command authorization tags from EC2 metadata')
  }
  if (!Array.isArray(response?.Reservations)) {
    throw new Error('could not verify Runner command authorization tags from EC2 metadata')
  }
  const instances = []
  for (const reservation of response.Reservations) {
    if (!Array.isArray(reservation?.Instances)) {
      throw new Error('could not verify Runner command authorization tags from EC2 metadata')
    }
    instances.push(...reservation.Instances)
  }
  return instances
}

function assertRunnerCommandTargets({ instances, requestedIds, stage }) {
  extraRunnerInstanceProfileName(stage)
  if (!Array.isArray(instances)) throw new Error('Runner command target verification requires EC2 metadata')
  if (requestedIds !== undefined) {
    requestedIds = validateRunnerInstanceIds(requestedIds)
  }

  const observedById = new Map()
  for (const instance of instances) {
    const instanceId = parseEc2InstanceId(instance?.InstanceId, 'EC2 returned an invalid Runner instance id')
    if (observedById.has(instanceId)) throw new Error('EC2 returned a duplicate Runner instance')
    if (instance.State?.Name !== 'running') throw new Error(`Runner instance ${instanceId} must be running`)
    const authorization = parseRunnerCommandAuthorizationTags(instance)
    if (authorization.stage !== stage || authorization.role !== RUNNER_ROLE_VALUE) {
      throw new Error(`Runner instance ${instanceId} does not have the selected-stage command authorization`)
    }
    observedById.set(instanceId, instance)
  }

  if (requestedIds === undefined) return [...observedById.keys()].sort()
  const requestedSet = new Set(requestedIds)
  if (
    observedById.size !== requestedIds.length ||
    requestedIds.some((instanceId) => !observedById.has(instanceId)) ||
    [...observedById].some(([instanceId]) => !requestedSet.has(instanceId))
  ) {
    throw new Error('EC2 metadata must contain exactly every requested Runner instance')
  }
  return [...requestedIds]
}

module.exports = {
  MAX_RUNNER_TARGETS,
  assertRunnerCommandTargets,
  parseEc2InstanceId,
  parseExplicitRunnerInstanceIds,
  parseRunnerCommandAuthorizationTags,
  parseRunnerEc2Instances,
  validateRunnerInstanceIds,
}
