/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import { BoxCheckpoint } from '../../box/entities/box-checkpoint.entity'

export function checkpointToResponse(checkpoint: BoxCheckpoint) {
  return {
    id: checkpoint.id,
    box_id: checkpoint.sourceBoxId,
    name: checkpoint.name,
    status: checkpoint.state,
    created_at: Math.floor(checkpoint.createdAt.getTime() / 1000),
    error: checkpoint.errorReason,
    cpus: checkpoint.cpus,
    memory_bytes: checkpoint.memoryMib * 1024 * 1024,
    container_disk_bytes: checkpoint.diskGb * 1024 ** 3,
    size_bytes: checkpoint.sizeBytes,
  }
}
