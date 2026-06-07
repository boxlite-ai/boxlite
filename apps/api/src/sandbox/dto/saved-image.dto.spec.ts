/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { SavedImageDto } from './saved-image.dto'
import { SavedImage } from '../entities/saved-image.entity'
import { SavedImageState } from '../enums/saved-image-state.enum'

describe('SavedImageDto', () => {
  it('exposes savedImage metadata, runtime artifact ref, and default resources without image terminology', () => {
    const createdAt = new Date('2026-05-30T12:00:00.000Z')
    const updatedAt = new Date('2026-05-30T12:05:00.000Z')
    const lastUsedAt = new Date('2026-05-30T12:10:00.000Z')
    const savedImage = {
      id: 'saved-image-id',
      name: 'ubuntu:24.04',
      displayName: 'Ubuntu 24.04 LTS',
      description: 'General-purpose Linux savedImage',
      general: true,
      imageName: 'ubuntu:24.04',
      artifactRef: 'registry.internal/boxlite/ubuntu:24.04',
      state: SavedImageState.ACTIVE,
      cpu: 1,
      gpu: 0,
      mem: 2,
      disk: 8,
      errorReason: 'pull failed',
      createdAt,
      updatedAt,
      lastUsedAt,
      hideFromUsers: false,
      runners: [],
      savedImageRegions: [{ regionId: 'us' }, { regionId: 'eu' }],
    } as unknown as SavedImage

    expect(SavedImageDto.fromSavedImage(savedImage)).toEqual({
      id: 'saved-image-id',
      organizationId: undefined,
      name: 'ubuntu:24.04',
      displayName: 'Ubuntu 24.04 LTS',
      description: 'General-purpose Linux savedImage',
      general: true,
      artifactRef: 'registry.internal/boxlite/ubuntu:24.04',
      state: SavedImageState.ACTIVE,
      errorReason: 'pull failed',
      defaultResources: {
        cpu: 1,
        gpu: 0,
        memory: 2,
        disk: 8,
      },
      createdAt,
      updatedAt,
      lastUsedAt,
      regionIds: ['us', 'eu'],
    })
  })
})
