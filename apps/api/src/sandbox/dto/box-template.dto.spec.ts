/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxTemplateDto } from './box-template.dto'
import { BoxTemplate } from '../entities/box-template.entity'
import { BoxTemplateState } from '../enums/box-template-state.enum'

describe('BoxTemplateDto', () => {
  it('exposes template metadata, runtime artifact ref, and default resources without image terminology', () => {
    const createdAt = new Date('2026-05-30T12:00:00.000Z')
    const updatedAt = new Date('2026-05-30T12:05:00.000Z')
    const lastUsedAt = new Date('2026-05-30T12:10:00.000Z')
    const template = {
      id: 'template-id',
      name: 'ubuntu:24.04',
      displayName: 'Ubuntu 24.04 LTS',
      description: 'General-purpose Linux template',
      general: true,
      imageName: 'ubuntu:24.04',
      artifactRef: 'registry.internal/boxlite/ubuntu:24.04',
      state: BoxTemplateState.ACTIVE,
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
      templateRegions: [{ regionId: 'us' }, { regionId: 'eu' }],
    } as unknown as BoxTemplate

    expect(BoxTemplateDto.fromBoxTemplate(template)).toEqual({
      id: 'template-id',
      organizationId: undefined,
      name: 'ubuntu:24.04',
      displayName: 'Ubuntu 24.04 LTS',
      description: 'General-purpose Linux template',
      general: true,
      artifactRef: 'registry.internal/boxlite/ubuntu:24.04',
      state: BoxTemplateState.ACTIVE,
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
