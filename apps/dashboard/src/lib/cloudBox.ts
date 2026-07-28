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
  autoPauseIntervalSeconds: number
  autoDelete: number
  autoResume?: boolean
}

export type CreateBoxParams = {
  name?: string
  image?: string
  user?: string
  envVars?: Record<string, string>
  network?: BoxApiNetworkSpec
  resources?: Resources
  autoPauseIntervalSeconds?: number
  autoDelete?: number
  autoResume?: boolean
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
  auto_pause?: number
  auto_delete?: number
  auto_resume?: boolean
}

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
  auto_pause: number
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
    auto_pause: p.autoPauseIntervalSeconds,
    auto_delete: p.autoDelete,
    auto_resume: p.autoResume ?? true,
  }
}

export function validateLifecyclePolicy(policy: LifecyclePolicy): string | null {
  if (!Number.isInteger(policy.autoPauseIntervalSeconds) || policy.autoPauseIntervalSeconds < 0) {
    return 'Auto-pause must be a non-negative integer number of seconds.'
  }
  if (!Number.isInteger(policy.autoDelete) || policy.autoDelete < 0) {
    return 'Auto-delete must be 0 (disabled) or a positive integer number of seconds.'
  }
  if (policy.autoDelete > 0 && policy.autoDelete <= policy.autoPauseIntervalSeconds) {
    return 'Auto-delete must be greater than auto-pause.'
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
