/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { Volume } from '../../box/entities/volume.entity'

export function toVolumeSummary(volume: Volume) {
  return { id: volume.id, name: volume.name, state: volume.state, created_at: volume.createdAt.toISOString() }
}

export function toVolumeResponse(volume: Volume) {
  return {
    ...toVolumeSummary(volume),
    updated_at: volume.updatedAt.toISOString(),
    last_used_at: volume.lastUsedAt?.toISOString(),
    error_reason: volume.errorReason,
  }
}
