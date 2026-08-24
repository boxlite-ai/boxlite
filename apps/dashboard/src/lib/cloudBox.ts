/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiClient } from '@/api/apiClient'

// Dashboard-side client for the Box API contract (openapi/box.openapi.yaml),
// served by apps/api/src/boxlite-rest. Box verbs (create/start/stop/delete)
// go through this door so the dashboard and SDKs speak the same dialect;
// cloud-capability reads stay on the generated api-client.

export interface Resources {
  cpu?: number
  memory?: number
  disk?: number
}

export type BoxApiNetworkSpec = {
  mode: 'enabled' | 'disabled'
  allow_net?: string[]
}

export type LifecyclePolicy = {
  autoStopIntervalSeconds: number
  autoDelete: number
  autoResume?: boolean
}

// A managed volume attached at a path inside the box. Mounts exist only at
// create time — there is no attach/detach endpoint — so this is the one moment
// a box and a volume can be connected.
export type BoxVolumeMount = {
  /** Volume id or name; the API resolves either. */
  volumeId: string
  mountPath: string
}

export type CreateBoxParams = {
  name?: string
  image?: string
  user?: string
  envVars?: Record<string, string>
  network?: BoxApiNetworkSpec
  resources?: Resources
  autoStopIntervalSeconds?: number
  autoDelete?: number
  autoResume?: boolean
  volumes?: BoxVolumeMount[]
}

// Request body shape defined by openapi/box.openapi.yaml CreateBoxRequest.
export type BoxApiCreateRequest = {
  name?: string
  image?: string
  cpus?: number
  memory_mib?: number
  disk_size_gb?: number
  env?: Record<string, string>
  user?: string
  network?: BoxApiNetworkSpec
  auto_stop?: number
  auto_delete?: number
  auto_resume?: boolean
  // The REST boundary takes a source URI + guest path, not the internal
  // {volumeId, mountPath} pair the API maps it onto (box-to-box.mapper.ts).
  volumes?: { source: string; guest_path: string }[]
}

/** Scheme the REST boundary requires for a managed volume source. */
const VOLUME_SOURCE_SCHEME = 'volume://'

export type BoxApiBoxResponse = {
  box_id: string
  name?: string
  status: string
  created_at: string
  updated_at: string
  image: string
  cpus: number
  memory_mib: number
  labels: Record<string, string>
  auto_stop: number
  auto_delete: number
  auto_resume?: boolean
}

export function toBoxApiCreateRequest(params?: CreateBoxParams): BoxApiCreateRequest {
  const p = params ?? {}
  return {
    name: p.name,
    image: p.image,
    user: p.user,
    env: p.envVars,
    cpus: p.resources?.cpu,
    // The dashboard form works in GiB; the Box API contract takes MiB.
    memory_mib: p.resources?.memory !== undefined ? p.resources.memory * 1024 : undefined,
    disk_size_gb: p.resources?.disk,
    network: p.network,
    auto_stop: p.autoStopIntervalSeconds,
    auto_delete: p.autoDelete,
    auto_resume: p.autoResume ?? true,
    volumes: p.volumes?.length
      ? p.volumes.map((mount) => ({
          // `volumeId` may be an id or a name; the API resolves either once
          // the scheme prefix is stripped.
          source: `${VOLUME_SOURCE_SCHEME}${mount.volumeId}`,
          guest_path: mount.mountPath,
        }))
      : undefined,
  }
}

// The mount paths the API will reject, checked here so the form can say why
// before a request is spent. Mirrors validateMountPaths in
// apps/api/src/box/utils/volume-mount-path-validation.util.ts — the server
// stays the authority, this is only a faster first opinion.
const FORBIDDEN_MOUNT_ROOTS = ['/proc', '/sys', '/dev', '/boot', '/etc', '/bin', '/sbin', '/lib', '/lib64']

export function validateMountPath(value: string): string | null {
  if (!value) return 'Mount path is required.'
  if (!value.startsWith('/')) return 'Mount path must be absolute.'
  if (value === '/' || value === '//') return 'Cannot mount to the root directory.'
  if (value.includes('/../') || value.includes('/./') || value.endsWith('/..') || value.endsWith('/.')) {
    return 'Mount path cannot contain relative path components.'
  }
  if (/\/\/+/.test(value.slice(1))) return 'Mount path cannot contain consecutive slashes.'
  const forbidden = FORBIDDEN_MOUNT_ROOTS.find((root) => value === root || value.startsWith(`${root}/`))
  if (forbidden) return `Cannot mount to the system directory ${forbidden}.`
  return null
}

/** First problem across a whole mount list, including duplicate paths. */
export function validateMounts(mounts: BoxVolumeMount[]): string | null {
  const seen = new Set<string>()
  for (const mount of mounts) {
    if (!mount.volumeId) return 'Pick a volume for every mount.'
    const pathError = validateMountPath(mount.mountPath)
    if (pathError) return pathError
    if (seen.has(mount.mountPath)) return `Two volumes cannot share the mount path ${mount.mountPath}.`
    seen.add(mount.mountPath)
  }
  return null
}

export function validateLifecyclePolicy(policy: LifecyclePolicy): string | null {
  if (!Number.isInteger(policy.autoStopIntervalSeconds) || policy.autoStopIntervalSeconds < 0) {
    return 'Auto-stop must be a non-negative integer number of seconds.'
  }
  if (!Number.isInteger(policy.autoDelete) || policy.autoDelete < 0) {
    return 'Auto-delete must be 0 (disabled) or a positive integer number of seconds.'
  }
  if (policy.autoDelete > 0 && policy.autoDelete <= policy.autoStopIntervalSeconds) {
    return 'Auto-delete must be greater than auto-stop.'
  }
  return null
}

export function formatLifecycleSeconds(seconds: number): string {
  if (seconds === 0) return 'Disabled'
  if (seconds % 86400 === 0) return `${seconds / 86400}d`
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

function boxesBasePath(organizationId: string): string {
  return `v1/${organizationId}/boxes`
}

export async function createBoxViaBoxApi(
  api: ApiClient,
  organizationId: string,
  params?: CreateBoxParams,
): Promise<BoxApiBoxResponse> {
  const response = await api.axiosInstance.post<BoxApiBoxResponse>(
    boxesBasePath(organizationId),
    toBoxApiCreateRequest(params),
  )
  return response.data
}

export async function startBoxViaBoxApi(api: ApiClient, organizationId: string, boxId: string): Promise<void> {
  await api.axiosInstance.post(`${boxesBasePath(organizationId)}/${boxId}/start`)
}

export async function stopBoxViaBoxApi(api: ApiClient, organizationId: string, boxId: string): Promise<void> {
  await api.axiosInstance.post(`${boxesBasePath(organizationId)}/${boxId}/stop`)
}

export async function deleteBoxViaBoxApi(api: ApiClient, organizationId: string, boxId: string): Promise<void> {
  await api.axiosInstance.delete(`${boxesBasePath(organizationId)}/${boxId}`)
}
