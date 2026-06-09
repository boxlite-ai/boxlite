/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { getSystemTemplateDefinition } from '../constants/system-templates'
import { BoxTemplate } from '../entities/box-template.entity'
import { BoxTemplateState } from '../enums/box-template-state.enum'
import { BuildInfoDto } from './build-info.dto'

type BoxTemplatePresentation = Pick<
  BoxTemplate,
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
  | 'templateRegions'
> & {
  displayName?: string
  description?: string
  capabilities?: string[]
}

export class BoxTemplateDefaultResourcesDto {
  @ApiProperty()
  cpu: number

  @ApiProperty()
  gpu: number

  @ApiProperty()
  memory: number

  @ApiProperty()
  disk: number
}

export class BoxTemplateDto {
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

  @ApiPropertyOptional({
    description: 'Agent/runtime capabilities included in this official image',
    type: [String],
  })
  capabilities?: string[]

  @ApiPropertyOptional()
  artifactRef?: string

  @ApiProperty({
    enum: BoxTemplateState,
    enumName: 'BoxTemplateState',
  })
  state: BoxTemplateState

  @ApiPropertyOptional()
  errorReason?: string

  @ApiProperty({ type: BoxTemplateDefaultResourcesDto })
  defaultResources: BoxTemplateDefaultResourcesDto

  @ApiProperty()
  createdAt: Date

  @ApiProperty()
  updatedAt: Date

  @ApiPropertyOptional()
  lastUsedAt?: Date

  @ApiPropertyOptional({
    description: 'Build information for this template',
    type: BuildInfoDto,
  })
  buildInfo?: BuildInfoDto

  @ApiPropertyOptional({
    description: 'The initial runner ID of the template',
    example: 'runner123',
  })
  initialRunnerId?: string

  @ApiPropertyOptional({
    description: 'IDs of regions where the template is available to this organization',
    type: [String],
  })
  regionIds?: string[]

  static fromBoxTemplate(template: BoxTemplatePresentation): BoxTemplateDto {
    const systemTemplate = getSystemTemplateDefinition(template.name)

    return {
      id: template.id,
      organizationId: template.organizationId,
      general: template.general,
      name: template.name,
      displayName: template.displayName ?? template.name,
      description: template.description,
      capabilities: template.capabilities ?? systemTemplate?.capabilities,
      artifactRef: template.artifactRef,
      state: template.state,
      errorReason: template.errorReason,
      defaultResources: {
        cpu: template.cpu,
        gpu: template.gpu,
        memory: template.mem,
        disk: template.disk,
      },
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
      lastUsedAt: template.lastUsedAt,
      buildInfo: template.buildInfo
        ? {
            dockerfileContent: template.buildInfo.dockerfileContent,
            contextHashes: template.buildInfo.contextHashes,
            createdAt: template.buildInfo.createdAt,
            updatedAt: template.buildInfo.updatedAt,
            artifactRef: template.buildInfo.artifactRef,
          }
        : undefined,
      initialRunnerId: template.initialRunnerId,
      regionIds: template.templateRegions?.map((region) => region.regionId) ?? undefined,
    }
  }

  static fromBoxTemplateEntity(template: BoxTemplate): BoxTemplateDto {
    const displaySource = template.imageName || template.name
    const systemTemplate = getSystemTemplateDefinition(displaySource)

    return BoxTemplateDto.fromBoxTemplate({
      id: template.id,
      organizationId: template.organizationId,
      general: template.general,
      name: template.name,
      displayName: systemTemplate?.displayName ?? displaySource,
      description: systemTemplate?.description,
      capabilities: systemTemplate?.capabilities,
      artifactRef: template.artifactRef,
      state: template.state,
      cpu: template.cpu,
      gpu: template.gpu,
      mem: template.mem,
      disk: template.disk,
      buildInfo: template.buildInfo,
      initialRunnerId: template.initialRunnerId,
      templateRegions: template.templateRegions,
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
      lastUsedAt: template.lastUsedAt,
    })
  }
}
