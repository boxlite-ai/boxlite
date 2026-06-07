/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { getSystemSavedImageDefinition } from '../constants/system-saved-images'
import { SavedImage } from '../entities/saved-image.entity'
import { SavedImageState } from '../enums/saved-image-state.enum'
import { BuildInfoDto } from './build-info.dto'

type SavedImagePresentation = Pick<
  SavedImage,
  | 'id'
  | 'organizationId'
  | 'general'
  | 'name'
  | 'artifactRef'
  | 'state'
  | 'errorReason'
  | 'cpu'
  | 'gpu'
  | 'mem'
  | 'disk'
  | 'createdAt'
  | 'updatedAt'
  | 'lastUsedAt'
  | 'buildInfo'
  | 'initialRunnerId'
  | 'savedImageRegions'
> & {
  displayName?: string
  description?: string
}

export class SavedImageDefaultResourcesDto {
  @ApiProperty()
  cpu: number

  @ApiProperty()
  gpu: number

  @ApiProperty()
  memory: number

  @ApiProperty()
  disk: number
}

export class SavedImageDto {
  @ApiProperty()
  id: string

  @ApiPropertyOptional()
  organizationId?: string

  @ApiProperty()
  general: boolean

  @ApiProperty()
  name: string

  @ApiProperty()
  displayName: string

  @ApiPropertyOptional()
  description?: string

  @ApiPropertyOptional()
  artifactRef?: string

  @ApiProperty({
    enum: SavedImageState,
    enumName: 'SavedImageState',
  })
  state: SavedImageState

  @ApiPropertyOptional()
  errorReason?: string

  @ApiProperty({ type: SavedImageDefaultResourcesDto })
  defaultResources: SavedImageDefaultResourcesDto

  @ApiProperty()
  createdAt: Date

  @ApiProperty()
  updatedAt: Date

  @ApiPropertyOptional()
  lastUsedAt?: Date

  @ApiPropertyOptional({
    description: 'Build information for this savedImage',
    type: BuildInfoDto,
  })
  buildInfo?: BuildInfoDto

  @ApiPropertyOptional({
    description: 'The initial runner ID of the savedImage',
    example: 'runner123',
  })
  initialRunnerId?: string

  @ApiPropertyOptional({
    description: 'IDs of regions where the savedImage is available to this organization',
    type: [String],
  })
  regionIds?: string[]

  static fromSavedImage(savedImage: SavedImagePresentation): SavedImageDto {
    return {
      id: savedImage.id,
      organizationId: savedImage.organizationId,
      general: savedImage.general,
      name: savedImage.name,
      displayName: savedImage.displayName ?? savedImage.name,
      description: savedImage.description,
      artifactRef: savedImage.artifactRef,
      state: savedImage.state,
      errorReason: savedImage.errorReason,
      defaultResources: {
        cpu: savedImage.cpu,
        gpu: savedImage.gpu,
        memory: savedImage.mem,
        disk: savedImage.disk,
      },
      createdAt: savedImage.createdAt,
      updatedAt: savedImage.updatedAt,
      lastUsedAt: savedImage.lastUsedAt,
      buildInfo: savedImage.buildInfo
        ? {
            dockerfileContent: savedImage.buildInfo.dockerfileContent,
            contextHashes: savedImage.buildInfo.contextHashes,
            createdAt: savedImage.buildInfo.createdAt,
            updatedAt: savedImage.buildInfo.updatedAt,
            artifactRef: savedImage.buildInfo.artifactRef,
          }
        : undefined,
      initialRunnerId: savedImage.initialRunnerId,
      regionIds: savedImage.savedImageRegions?.map((region) => region.regionId) ?? undefined,
    }
  }

  static fromSavedImageEntity(savedImage: SavedImage): SavedImageDto {
    const displaySource = savedImage.imageName || savedImage.name
    const systemSavedImage = getSystemSavedImageDefinition(displaySource)

    return SavedImageDto.fromSavedImage({
      id: savedImage.id,
      organizationId: savedImage.organizationId,
      general: savedImage.general,
      name: savedImage.name,
      displayName: systemSavedImage?.displayName ?? displaySource,
      description: systemSavedImage?.description,
      artifactRef: savedImage.artifactRef,
      state: savedImage.state,
      cpu: savedImage.cpu,
      gpu: savedImage.gpu,
      mem: savedImage.mem,
      disk: savedImage.disk,
      buildInfo: savedImage.buildInfo,
      initialRunnerId: savedImage.initialRunnerId,
      savedImageRegions: savedImage.savedImageRegions,
      createdAt: savedImage.createdAt,
      updatedAt: savedImage.updatedAt,
      lastUsedAt: savedImage.lastUsedAt,
    })
  }
}
