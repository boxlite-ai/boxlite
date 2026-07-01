/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiClient } from '@/api/apiClient'
import { buildBoxUploadPath, createBoxUploadTar, createBoxUploadFileItem, type BoxUploadItem } from '@/lib/box-upload'

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

export type CreateBoxParams = {
  name?: string
  image?: string
  user?: string
  envVars?: Record<string, string>
  network?: BoxApiNetworkSpec
  resources?: Resources
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
  }
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

export async function uploadFileToBoxViaBoxApi(
  api: ApiClient,
  organizationId: string,
  boxId: string,
  file: File,
  destinationDir: string,
): Promise<string> {
  return uploadBoxItemViaBoxApi(api, organizationId, boxId, createBoxUploadFileItem(file), destinationDir)
}

export async function uploadBoxItemViaBoxApi(
  api: ApiClient,
  organizationId: string,
  boxId: string,
  item: BoxUploadItem,
  destinationDir: string,
): Promise<string> {
  const remotePath = buildBoxUploadPath(destinationDir, item)
  const archive = await createBoxUploadTar(item)

  await api.axiosInstance.put(`${boxesBasePath(organizationId)}/${boxId}/files`, archive, {
    headers: { 'Content-Type': 'application/x-tar' },
    params: { path: remotePath },
  })

  return remotePath
}
