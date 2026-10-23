/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxSnapshot } from '../../box/entities/box-snapshot.entity'
import { BoxSnapshotRestore } from '../../box/entities/box-snapshot-restore.entity'

const GIB = 1024 ** 3

/** `Snapshot` in openapi/box.openapi.yaml. */
export interface SnapshotResponse {
  id: string
  box_id: string
  name: string
  status: string
  error?: string
  created_at: number
  guest_disk_bytes: number
  container_disk_bytes: number
  size_bytes: number
}

/** `SnapshotRestore` in openapi/box.openapi.yaml. */
export interface SnapshotRestoreResponse {
  id: string
  box_id: string
  snapshot_id: string
  status: string
  error?: string
  created_at: number
  completed_at?: number
}

const unixSeconds = (date: Date) => Math.floor(date.getTime() / 1000)

export function snapshotToResponse(snapshot: BoxSnapshot): SnapshotResponse {
  return {
    id: snapshot.id,
    box_id: snapshot.sourceBoxId,
    name: snapshot.name,
    status: snapshot.state,
    error: snapshot.errorReason ?? undefined,
    created_at: unixSeconds(snapshot.createdAt),
    // The guest rootfs is a shared base the archive never carries.
    guest_disk_bytes: 0,
    container_disk_bytes: snapshot.diskGb * GIB,
    // What the archive occupies in object storage.
    size_bytes: snapshot.sizeBytes,
  }
}

export function restoreToResponse(restore: BoxSnapshotRestore): SnapshotRestoreResponse {
  return {
    id: restore.id,
    box_id: restore.boxId,
    snapshot_id: restore.snapshotId,
    status: restore.state,
    error: restore.errorReason ?? undefined,
    created_at: unixSeconds(restore.createdAt),
    completed_at: restore.completedAt ? unixSeconds(restore.completedAt) : undefined,
  }
}
