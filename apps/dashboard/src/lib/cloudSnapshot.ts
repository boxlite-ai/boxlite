/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import { ApiClient } from '@/api/apiClient'
import type { BoxApiBoxResponse } from './cloudBox'

export const SnapshotStatus = { CREATING: 'creating', READY: 'ready', FAILED: 'failed' } as const
export interface Snapshot {
  id: string
  name: string
  sourceBoxId: string
  status: (typeof SnapshotStatus)[keyof typeof SnapshotStatus]
  error?: string
  sizeBytes: number
  diskGb: number
  createdAt: string
}

interface SnapshotResponse {
  id: string
  name: string
  box_id: string
  status: Snapshot['status']
  error?: string
  size_bytes: number
  container_disk_bytes: number
  created_at: number
}

export interface SnapshotCapabilities {
  snapshots_enabled: boolean
  create_from_snapshot_enabled: boolean
  snapshot_copy_enabled: boolean
  memory_snapshots_enabled: boolean
}

const snapshotPath = (org: string) => `v1/${encodeURIComponent(org)}/snapshots`
const fromResponse = (snapshot: SnapshotResponse): Snapshot => ({
  id: snapshot.id,
  name: snapshot.name,
  sourceBoxId: snapshot.box_id,
  status: snapshot.status,
  error: snapshot.error,
  sizeBytes: snapshot.size_bytes,
  diskGb: snapshot.container_disk_bytes / 1024 ** 3,
  createdAt: new Date(snapshot.created_at * 1000).toISOString(),
})

export async function getSnapshotCapabilities(api: ApiClient): Promise<SnapshotCapabilities> {
  return (await api.axiosInstance.get<{ capabilities: SnapshotCapabilities }>('v1/config')).data.capabilities
}

export async function listSnapshots(api: ApiClient, org: string): Promise<Snapshot[]> {
  const { data } = await api.axiosInstance.get<{ snapshots: SnapshotResponse[] }>(snapshotPath(org))
  return data.snapshots.map(fromResponse)
}

export async function createSnapshot(api: ApiClient, org: string, boxId: string, name?: string): Promise<Snapshot> {
  const { data } = await api.axiosInstance.post<SnapshotResponse>(
    `v1/${encodeURIComponent(org)}/boxes/${encodeURIComponent(boxId)}/snapshots`,
    { name },
  )
  return fromResponse(data)
}

export async function deleteSnapshot(api: ApiClient, org: string, id: string): Promise<void> {
  await api.axiosInstance.delete(`${snapshotPath(org)}/${encodeURIComponent(id)}`)
}

export async function createBoxFromSnapshot(
  api: ApiClient,
  org: string,
  id: string,
  name?: string,
): Promise<BoxApiBoxResponse> {
  return (
    await api.axiosInstance.post<BoxApiBoxResponse>(`${snapshotPath(org)}/${encodeURIComponent(id)}/boxes`, { name })
  ).data
}
