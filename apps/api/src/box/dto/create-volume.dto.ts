/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiSchema } from '@nestjs/swagger'
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator'
import { VolumeBackend } from '../enums/volume-backend.enum'

@ApiSchema({ name: 'CreateVolume' })
export class CreateVolumeDto {
  @ApiProperty()
  @IsString()
  @IsOptional()
  name?: string

  @ApiProperty({ enum: VolumeBackend, default: VolumeBackend.S3, required: false })
  @IsEnum(VolumeBackend)
  @IsOptional()
  backend?: VolumeBackend

  @ApiProperty({
    description: 'Logical capacity limit in GiB',
    minimum: 1,
    maximum: 16384,
    default: 10,
    required: false,
  })
  @IsInt()
  @Min(1)
  @Max(16384)
  @IsOptional()
  sizeGiB?: number
}
