/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import { BoxDto } from './box.dto'
import { IsOptional } from 'class-validator'
import { Box } from '../entities/box.entity'

@ApiSchema({ name: 'BoxInfo' })
export class BoxInfoDto {
  @ApiProperty({
    description: 'The creation timestamp of the project',
    example: '2023-10-01T12:00:00Z',
  })
  created: string

  @ApiProperty({
    description: 'Deprecated: The name of the box',
    example: 'MyBox',
    deprecated: true,
    default: '',
  })
  name: string

  @ApiPropertyOptional({
    description: 'Additional metadata provided by the provider',
    example: '{"key": "value"}',
    required: false,
  })
  @IsOptional()
  providerMetadata?: string
}

@ApiSchema({ name: 'Workspace' })
export class WorkspaceDto extends BoxDto {
  @ApiPropertyOptional({
    description: 'The image used for the workspace',
    example: 'boxlite-ai/workspace:latest',
  })
  image: string

  @ApiPropertyOptional({
    description: 'Additional information about the box',
    type: BoxInfoDto,
    required: false,
  })
  @IsOptional()
  info?: BoxInfoDto

  constructor() {
    super()
  }

  static fromBox(box: Box): WorkspaceDto {
    // Send empty string for toolboxProxyUrl as it is not needed in deprecated DTO
    const dto = super.fromBox(box, '')
    return this.fromBoxDto(dto)
  }

  static fromBoxDto(boxDto: BoxDto): WorkspaceDto {
    return {
      ...boxDto,
      image: '',
      info: {
        name: boxDto.name,
        created: boxDto.createdAt,
        providerMetadata: JSON.stringify({
          state: boxDto.state,
          region: boxDto.target,
          class: boxDto.class,
          updatedAt: boxDto.updatedAt,
          cpu: boxDto.cpu,
          gpu: boxDto.gpu,
          memory: boxDto.memory,
          disk: boxDto.disk,
          autoStopInterval: boxDto.autoStopInterval,
          daemonVersion: boxDto.daemonVersion,
        }),
      },
    }
  }
}
