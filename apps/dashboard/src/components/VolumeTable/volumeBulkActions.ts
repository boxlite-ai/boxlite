/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { VolumeDto, VolumeState } from '@boxlite-ai/api-client'

export function isVolumeDeletable(volume: VolumeDto) {
  return (
    volume.state !== VolumeState.PENDING_DELETE &&
    volume.state !== VolumeState.DELETING &&
    volume.state !== VolumeState.DELETED
  )
}

export function getVolumeBulkActionCounts(volumes: VolumeDto[]) {
  return {
    deletable: volumes.filter(isVolumeDeletable).length,
  }
}
