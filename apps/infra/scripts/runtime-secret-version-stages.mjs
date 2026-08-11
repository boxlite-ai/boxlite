// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalidVersionMap() {
  return new Error('runtime secret metadata has an invalid version map')
}

export function isRuntimeSecretVersionId(value) {
  if (typeof value !== 'string') return false
  // AWS recommends UUID-style ids but specifies only a 32-64 character length.
  const characterCount = [...value].length
  return characterCount >= 32 && characterCount <= 64
}

export function normalizeRuntimeSecretVersionStages(metadata, { allowOmitted = false } = {}) {
  if (!isPlainObject(metadata)) throw invalidVersionMap()

  if (!Object.hasOwn(metadata, 'VersionIdsToStages')) {
    if (allowOmitted) return {}
    throw invalidVersionMap()
  }

  // DescribeSecret may serialize a brand-new container as either an omitted
  // optional member or null. A JMESPath object projection consistently emits
  // null for the same state. Both mean exactly zero versions.
  const versionStages = metadata.VersionIdsToStages
  if (versionStages === null) return {}
  if (!isPlainObject(versionStages)) throw invalidVersionMap()

  for (const [versionId, stages] of Object.entries(versionStages)) {
    if (
      !isRuntimeSecretVersionId(versionId) ||
      !Array.isArray(stages) ||
      stages.length === 0 ||
      stages.length > 20 ||
      stages.some((stage) => typeof stage !== 'string' || stage.length === 0 || stage.length > 256)
    ) {
      throw invalidVersionMap()
    }
  }
  return versionStages
}

export function currentRuntimeSecretVersionId(versionStages) {
  const currentVersionIds = Object.entries(versionStages)
    .filter(([, stages]) => stages.includes('AWSCURRENT'))
    .map(([versionId]) => versionId)
  if (currentVersionIds.length > 1) throw invalidVersionMap()
  return currentVersionIds[0]
}
