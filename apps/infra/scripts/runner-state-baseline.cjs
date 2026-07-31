// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

const { createHash } = require('node:crypto')

const {
  CONTROL_PLANE_NAME_TAG,
  RUNNER_RESOURCE_NAME_PATTERN,
  RUNNER_RESOURCE_TYPE,
  isRunnerLikeResource,
} = require('./runner-inventory.cjs')

const ALLOWED_MUTABLE_INPUTS = new Set(['ami', 'tags', 'tagsAll', 'userDataBase64'])
const REQUIRED_IGNORED_PROPERTIES = ['ami', 'userDataBase64']
const RUNNER_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/
const UNORDERED_ARRAY_PATHS = new Set(['vpcSecurityGroupIds'])
const AUDITED_PROVIDER_DEFAULTS = new Map([
  ['forceDestroy', false],
  ['getPasswordData', false],
  ['sourceDestCheck', true],
  ['userDataReplaceOnChange', false],
  ['metadataOptions.httpProtocolIpv6', 'disabled'],
  ['rootBlockDevice.deleteOnTermination', true],
])

function resourceName(urn) {
  return typeof urn === 'string' ? urn.slice(urn.lastIndexOf('::') + 2) : ''
}

function canonicalize(value, path = []) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid Runner input')
    return value
  }
  if (Array.isArray(value)) {
    const canonicalValues = value.map((entry) => canonicalize(entry, [...path, '[]']))
    if (!UNORDERED_ARRAY_PATHS.has(path.join('.'))) return canonicalValues
    return canonicalValues.sort((left, right) => {
      const serializedLeft = JSON.stringify(left)
      const serializedRight = JSON.stringify(right)
      if (serializedLeft === serializedRight) return 0
      return serializedLeft < serializedRight ? -1 : 1
    })
  }
  if (!value || typeof value !== 'object') throw new Error('invalid Runner input')

  const defaultKeys = value.__defaults === undefined ? [] : value.__defaults
  if (!Array.isArray(defaultKeys) || defaultKeys.some((key) => typeof key !== 'string')) {
    throw new Error('invalid Runner defaults metadata')
  }
  const providerDefaults = new Set(defaultKeys)
  for (const key of providerDefaults) {
    const propertyPath = [...path, key].join('.')
    if (!AUDITED_PROVIDER_DEFAULTS.has(propertyPath) || value[key] !== AUDITED_PROVIDER_DEFAULTS.get(propertyPath)) {
      throw new Error('unrecognized Runner provider default')
    }
  }
  const canonical = {}
  for (const key of Object.keys(value).sort()) {
    const propertyPath = [...path, key].join('.')
    const isAuditedProviderDefault =
      AUDITED_PROVIDER_DEFAULTS.has(propertyPath) && value[key] === AUDITED_PROVIDER_DEFAULTS.get(propertyPath)
    if (key === '__defaults' || isAuditedProviderDefault || value[key] === undefined) continue
    canonical[key] = canonicalize(value[key], [...path, key])
  }
  return canonical
}

function normalizeRunnerProtectedInputs(properties) {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new Error('invalid Runner inputs')
  }

  const protectedInputs = {}
  for (const key of Object.keys(properties)) {
    if (ALLOWED_MUTABLE_INPUTS.has(key) || properties[key] === undefined) continue
    protectedInputs[key] = properties[key]
  }
  if (Array.isArray(protectedInputs.__defaults)) {
    protectedInputs.__defaults = protectedInputs.__defaults.filter((key) => !ALLOWED_MUTABLE_INPUTS.has(key))
  }
  return canonicalize(protectedInputs)
}

function createRunnerSafetyFingerprint(properties) {
  const serializedInputs = JSON.stringify(normalizeRunnerProtectedInputs(properties))
  return `sha256:${createHash('sha256').update(serializedInputs).digest('hex')}`
}

function readConsistentIdentityTag(properties, key) {
  const values = []
  for (const tags of [properties?.tags, properties?.tagsAll]) {
    if (!tags || typeof tags !== 'object' || Array.isArray(tags)) continue
    if (!Object.prototype.hasOwnProperty.call(tags, key)) continue
    if (typeof tags[key] !== 'string' || tags[key].length === 0) throw new Error('invalid Runner identity tag')
    values.push(tags[key])
  }
  const uniqueValues = new Set(values)
  if (uniqueValues.size > 1) throw new Error('conflicting Runner identity tags')
  return values[0]
}

function legacyControlPlaneRunnerName(resourceName, nameTag) {
  if (resourceName === 'Runner' && nameTag === 'boxlite-runner-default') return 'default'

  const extraRunner = resourceName.match(/^Runner-runner-([1-9][0-9]*)$/)
  if (extraRunner && nameTag === `boxlite-runner-${extraRunner[1]}`) return `runner-${extraRunner[1]}`
  throw new Error('Runner state is missing its control-plane identity tag')
}

function createRunnerIdentityFingerprint(properties, resourceName, { allowLegacyFallback = false } = {}) {
  const nameTag = readConsistentIdentityTag(properties, 'Name')
  if (!nameTag) throw new Error('Runner state is missing its Name identity tag')

  let controlPlaneRunnerName = readConsistentIdentityTag(properties, CONTROL_PLANE_NAME_TAG)
  if (!controlPlaneRunnerName && allowLegacyFallback) {
    controlPlaneRunnerName = legacyControlPlaneRunnerName(resourceName, nameTag)
  }
  if (!controlPlaneRunnerName) throw new Error('Runner state is missing its control-plane identity tag')

  const serializedIdentity = JSON.stringify({ controlPlaneRunnerName, nameTag })
  return `sha256:${createHash('sha256').update(serializedIdentity).digest('hex')}`
}

function hasExactIgnoredProperties(ignoreChanges) {
  if (!Array.isArray(ignoreChanges) || ignoreChanges.length !== REQUIRED_IGNORED_PROPERTIES.length) return false
  const uniqueProperties = new Set(ignoreChanges)
  return (
    uniqueProperties.size === REQUIRED_IGNORED_PROPERTIES.length &&
    REQUIRED_IGNORED_PROPERTIES.every((property) => uniqueProperties.has(property))
  )
}

function createRunnerStateBaseline(exportedState) {
  const latest = exportedState?.latest
  const resources = latest?.resources
  if (!Array.isArray(resources)) throw new Error('SST state export does not contain a resource checkpoint')
  for (const pendingOperationsField of ['pending_operations', 'pendingOperations']) {
    if (!Object.prototype.hasOwnProperty.call(latest, pendingOperationsField)) continue
    const pendingOperations = latest[pendingOperationsField]
    if (!Array.isArray(pendingOperations) || pendingOperations.length > 0) {
      throw new Error('SST state export contains pending operations')
    }
  }

  const runnerResources = {}
  for (const resource of resources) {
    const name = resourceName(resource?.urn)
    if (!isRunnerLikeResource({ name, type: resource?.type, properties: resource?.inputs })) continue
    if (resource?.type !== RUNNER_RESOURCE_TYPE || !RUNNER_RESOURCE_NAME_PATTERN.test(name)) {
      throw new Error('SST state export contains an unexpected Runner-like resource')
    }
    if (Object.prototype.hasOwnProperty.call(runnerResources, name)) {
      throw new Error('SST state export contains a duplicate Runner resource')
    }
    if (
      resource.custom !== true ||
      typeof resource.id !== 'string' ||
      resource.id.length === 0 ||
      typeof resource.provider !== 'string' ||
      resource.provider.length === 0 ||
      ['delete', 'external', 'pendingReplacement', 'retainOnDelete', 'taint'].some(
        (flag) => resource[flag] !== undefined && resource[flag] !== false,
      ) ||
      (resource.initErrors !== undefined && (!Array.isArray(resource.initErrors) || resource.initErrors.length > 0))
    ) {
      throw new Error('SST state export contains an incomplete or transitional Runner resource')
    }
    if (resource.protect !== true || !hasExactIgnoredProperties(resource.ignoreChanges)) {
      throw new Error('SST state export contains unsafe Runner lifecycle options')
    }

    try {
      runnerResources[name] = {
        inputFingerprint: createRunnerSafetyFingerprint(resource.inputs),
        identityFingerprint: createRunnerIdentityFingerprint(resource.inputs, name, { allowLegacyFallback: true }),
      }
    } catch {
      throw new Error('SST state export contains invalid Runner inputs')
    }
  }

  return { version: 3, resources: runnerResources }
}

function parseRunnerStateBaseline(serializedBaseline) {
  let baseline
  try {
    baseline = JSON.parse(serializedBaseline)
  } catch {
    throw new Error('Runner state baseline is not valid JSON')
  }
  if (
    baseline?.version !== 3 ||
    !baseline.resources ||
    typeof baseline.resources !== 'object' ||
    Array.isArray(baseline.resources)
  ) {
    throw new Error('Runner state baseline has an unsupported shape')
  }

  for (const [name, properties] of Object.entries(baseline.resources)) {
    if (
      !RUNNER_RESOURCE_NAME_PATTERN.test(name) ||
      !properties ||
      typeof properties !== 'object' ||
      Array.isArray(properties) ||
      Object.keys(properties).sort().join('\0') !== 'identityFingerprint\0inputFingerprint' ||
      !RUNNER_FINGERPRINT_PATTERN.test(properties.inputFingerprint) ||
      !RUNNER_FINGERPRINT_PATTERN.test(properties.identityFingerprint)
    ) {
      throw new Error('Runner state baseline has invalid safety fingerprints')
    }
  }
  return baseline
}

module.exports = {
  createRunnerIdentityFingerprint,
  createRunnerSafetyFingerprint,
  createRunnerStateBaseline,
  hasExactIgnoredProperties,
  normalizeRunnerProtectedInputs,
  parseRunnerStateBaseline,
}
