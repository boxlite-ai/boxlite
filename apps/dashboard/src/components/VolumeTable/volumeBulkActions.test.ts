/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { VolumeDto, VolumeState } from '@boxlite-ai/api-client'
import { describe, expect, it } from 'vitest'
import { getVolumeBulkActionCounts, isVolumeDeletable } from './volumeBulkActions'

function volume(state: VolumeState): VolumeDto {
  return {
    id: `vol-${state}`,
    name: `vol-${state}`,
    organizationId: 'org-1',
    state,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    errorReason: null,
  }
}

describe('isVolumeDeletable', () => {
  it('accepts a volume that still exists to be deleted', () => {
    expect(isVolumeDeletable(volume(VolumeState.READY))).toBe(true)
  })

  it.each([VolumeState.PENDING_DELETE, VolumeState.DELETING, VolumeState.DELETED])(
    'refuses a volume already on its way out: %s',
    (state) => {
      expect(isVolumeDeletable(volume(state))).toBe(false)
    },
  )
})

describe('getVolumeBulkActionCounts', () => {
  it('counts only what the action can actually touch', () => {
    const counts = getVolumeBulkActionCounts([
      volume(VolumeState.READY),
      volume(VolumeState.DELETED),
      volume(VolumeState.PENDING_DELETE),
    ])

    expect(counts).toEqual({ deletable: 1 })
  })

  it('reports zero rather than failing on an empty selection', () => {
    expect(getVolumeBulkActionCounts([])).toEqual({ deletable: 0 })
  })
})
