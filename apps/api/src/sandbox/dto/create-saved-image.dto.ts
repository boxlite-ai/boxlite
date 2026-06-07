/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import { IsArray, IsObject, IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator'
import { CreateBuildInfoDto } from './create-build-info.dto'

@ApiSchema({ name: 'CreateSavedImage' })
export class CreateSavedImageDto {
  @ApiProperty({
    description: 'The saved image name',
    example: 'ubuntu-4vcpu-8ram-100gb',
  })
  @IsString()
  name: string

  @ApiPropertyOptional({
    description: 'The source image used to create the saved image artifact',
    example: 'ubuntu:22.04',
  })
  @IsOptional()
  @IsString()
  imageName?: string

  @ApiPropertyOptional({
    description: 'The entrypoint command for boxes created from the savedImage',
    example: 'sleep infinity',
  })
  @IsString({
    each: true,
  })
  @IsArray()
  @IsOptional()
  entrypoint?: string[]

  @ApiPropertyOptional({
    description: 'Whether the savedImage is available to all organizations',
  })
  @IsBoolean()
  @IsOptional()
  general?: boolean

  @ApiPropertyOptional({
    description: 'Default CPU cores allocated to boxes created from the savedImage',
    example: 1,
    type: 'integer',
  })
  @IsOptional()
  @IsNumber()
  cpu?: number

  @ApiPropertyOptional({
    description: 'Default GPU units allocated to boxes created from the savedImage',
    example: 0,
    type: 'integer',
  })
  @IsOptional()
  @IsNumber()
  gpu?: number

  @ApiPropertyOptional({
    description: 'Default memory allocated to boxes created from the saved image in GB',
    example: 1,
    type: 'integer',
  })
  @IsOptional()
  @IsNumber()
  memory?: number

  @ApiPropertyOptional({
    description: 'Default disk allocated to boxes created from the saved image in GB',
    example: 3,
    type: 'integer',
  })
  @IsOptional()
  @IsNumber()
  disk?: number

  @ApiPropertyOptional({
    description: 'Build information for the saved image artifact',
    type: CreateBuildInfoDto,
  })
  @IsOptional()
  @IsObject()
  buildInfo?: CreateBuildInfoDto

  @ApiPropertyOptional({
    description:
      'ID of the region where the savedImage will be available. Defaults to organization default region if not specified.',
  })
  @IsOptional()
  @IsString()
  regionId?: string
}
