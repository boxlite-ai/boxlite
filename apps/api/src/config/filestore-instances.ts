// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

export interface FilestoreInstanceConfig {
  instance: string
  projectId: string
  zone: string
}

export interface FilestoreInstancesConfig {
  instances: FilestoreInstanceConfig[]
}

export const FILESTORE_INSTANCE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/
const GCP_PROJECT_ID_PATTERN = /^[a-z](?:[a-z0-9-]{4,28}[a-z0-9])?$/
const GCP_ZONE_PATTERN = /^[a-z]+(?:-[a-z0-9]+)*\d+-[a-z]$/
const DEFAULT_FILESTORE_INSTANCES: FilestoreInstanceConfig[] = [
  { instance: 'boxlite-dev-shared', projectId: 'boxlite-dev-project', zone: 'us-east5-a' },
]

function parseFilestoreInstance(value: unknown): FilestoreInstanceConfig {
  if (typeof value !== 'object' || value === null) {
    throw new Error('FILESTORE_INSTANCES entries must be objects')
  }

  const entry = value as Record<string, unknown>
  const instance = typeof entry.instance === 'string' ? entry.instance.trim() : ''
  const projectId = typeof entry.project_id === 'string' ? entry.project_id.trim() : ''
  const zone = typeof entry.zone === 'string' ? entry.zone.trim() : ''

  if (!FILESTORE_INSTANCE_NAME_PATTERN.test(instance)) {
    throw new Error(
      `FILESTORE_INSTANCES entry has an invalid instance '${instance}' (must match ${FILESTORE_INSTANCE_NAME_PATTERN})`,
    )
  }
  if (!GCP_PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error(
      `FILESTORE_INSTANCES entry '${instance}' has an invalid project_id '${projectId}' (must match ${GCP_PROJECT_ID_PATTERN})`,
    )
  }
  if (!GCP_ZONE_PATTERN.test(zone)) {
    throw new Error(
      `FILESTORE_INSTANCES entry '${instance}' has an invalid zone '${zone}' (must be a GCP zone such as us-east5-a)`,
    )
  }

  return { instance, projectId, zone }
}

export function parseFilestoreInstances(env: NodeJS.ProcessEnv = process.env): FilestoreInstancesConfig {
  const raw = env.FILESTORE_INSTANCES?.trim()
  if (raw === undefined) {
    return { instances: DEFAULT_FILESTORE_INSTANCES.map((instance) => ({ ...instance })) }
  }
  if (!raw) {
    return { instances: [] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('FILESTORE_INSTANCES must be a JSON array of { instance, project_id, zone } objects')
  }
  if (!Array.isArray(parsed)) {
    throw new Error('FILESTORE_INSTANCES must be a JSON array of { instance, project_id, zone } objects')
  }

  const instances = parsed.map(parseFilestoreInstance)
  const instanceNames = instances.map((entry) => entry.instance)
  if (new Set(instanceNames).size !== instanceNames.length) {
    throw new Error('FILESTORE_INSTANCES defines an instance more than once')
  }

  return { instances }
}
