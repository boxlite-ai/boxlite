// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

export interface FilestoreInstanceConfig {
  instance: string
  projectId: string
  zone: string
}

export const FILESTORE_INSTANCE_NAME_PATTERN = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/
export const GCP_PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/
export const GCP_ZONE_PATTERN = /^[a-z]+(?:-[a-z0-9]+)*\d+-[a-z]$/

export class FilestoreConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FilestoreConfigurationError'
  }
}

function parseFilestoreInstance(value: unknown): FilestoreInstanceConfig {
  if (typeof value !== 'object' || value === null) {
    throw new FilestoreConfigurationError('FILESTORE_INSTANCES entries must be objects')
  }

  const entry = value as Record<string, unknown>
  const instance = typeof entry.instance === 'string' ? entry.instance.trim() : ''
  const projectId = typeof entry.project_id === 'string' ? entry.project_id.trim() : ''
  const zone = typeof entry.zone === 'string' ? entry.zone.trim() : ''

  if (!FILESTORE_INSTANCE_NAME_PATTERN.test(instance)) {
    throw new FilestoreConfigurationError(
      `FILESTORE_INSTANCES entry has an invalid instance '${instance}' (must match ${FILESTORE_INSTANCE_NAME_PATTERN})`,
    )
  }
  if (!GCP_PROJECT_ID_PATTERN.test(projectId)) {
    throw new FilestoreConfigurationError(
      `FILESTORE_INSTANCES entry '${instance}' has an invalid project_id '${projectId}' (must match ${GCP_PROJECT_ID_PATTERN})`,
    )
  }
  if (!GCP_ZONE_PATTERN.test(zone)) {
    throw new FilestoreConfigurationError(
      `FILESTORE_INSTANCES entry '${instance}' has an invalid zone '${zone}' (must be a GCP zone such as us-central1-a)`,
    )
  }

  return { instance, projectId, zone }
}

export function parseFilestoreInstances(env: { FILESTORE_INSTANCES?: string } = {}): FilestoreInstanceConfig[] {
  const raw = env.FILESTORE_INSTANCES?.trim()
  if (raw === undefined || !raw) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new FilestoreConfigurationError(
      'FILESTORE_INSTANCES must be a JSON array of { instance, project_id, zone } objects',
    )
  }
  if (!Array.isArray(parsed)) {
    throw new FilestoreConfigurationError(
      'FILESTORE_INSTANCES must be a JSON array of { instance, project_id, zone } objects',
    )
  }

  const instances = parsed.map(parseFilestoreInstance)
  const instanceNames = instances.map((entry) => entry.instance)
  if (new Set(instanceNames).size !== instanceNames.length) {
    throw new FilestoreConfigurationError('FILESTORE_INSTANCES defines an instance more than once')
  }

  return instances
}
