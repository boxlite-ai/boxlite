/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { IsEnum, IsObject, IsOptional, IsString, IsNumber, IsBoolean, IsArray, IsInt, Min } from 'class-validator'
import { ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import { BoxClass } from '../enums/box-class.enum'
import { BoxVolume } from './box.dto'

@ApiSchema({ name: 'CreateBox' })
export class CreateBoxDto {
  @ApiPropertyOptional({
    description: 'The name of the box. If not provided, the box ID will be used as the name',
    example: 'MyBox',
  })
  @IsOptional()
  @IsString()
  name?: string

  @ApiPropertyOptional({
    description: 'The image to use for the box',
    example: 'boxlite/base',
  })
  @IsOptional()
  @IsString()
  image?: string

  @ApiPropertyOptional({
    description: 'The user associated with the project',
    example: 'boxlite',
  })
  @IsOptional()
  @IsString()
  user?: string

  @ApiPropertyOptional({
    description: 'Environment variables for the box',
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { NODE_ENV: 'production' },
  })
  @IsOptional()
  @IsObject()
  env?: { [key: string]: string }

  @ApiPropertyOptional({
    description: 'Labels for the box',
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { 'boxlite.io/public': 'true' },
  })
  @IsOptional()
  @IsObject()
  labels?: { [key: string]: string }

  @ApiPropertyOptional({
    description: 'Whether the box http preview is publicly accessible',
    default: true,
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  public?: boolean

  @ApiPropertyOptional({
    description: 'Whether to block all network access for the box',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  networkBlockAll?: boolean

  @ApiPropertyOptional({
    description: 'Comma-separated list of allowed CIDR network addresses for the box',
    example: '192.168.1.0/16,10.0.0.0/24',
  })
  @IsOptional()
  @IsString()
  networkAllowList?: string

  @ApiPropertyOptional({
    description: 'The box class type',
    enum: BoxClass,
    example: Object.values(BoxClass)[0],
  })
  @IsOptional()
  @IsEnum(BoxClass)
  class?: BoxClass

  @ApiPropertyOptional({
    description: 'The target (region) where the box will be created',
    example: 'us',
  })
  @IsOptional()
  @IsString()
  target?: string

  @ApiPropertyOptional({
    description: 'CPU cores allocated to the box',
    example: 2,
    type: 'integer',
  })
  @IsOptional()
  @IsNumber()
  cpu?: number

  @ApiPropertyOptional({
    description: 'GPU units allocated to the box',
    example: 1,
    type: 'integer',
  })
  @IsOptional()
  @IsNumber()
  gpu?: number

  @ApiPropertyOptional({
    description: 'Memory allocated to the box in GB',
    example: 1,
    type: 'integer',
  })
  @IsOptional()
  @IsNumber()
  memory?: number

  @ApiPropertyOptional({
    description: 'Disk space allocated to the box in GB',
    example: 3,
    type: 'integer',
  })
  @IsOptional()
  @IsNumber()
  disk?: number

  @ApiPropertyOptional({
    description: 'Auto-pause interval in seconds (0 means disabled)',
    example: 900,
    type: 'integer',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  autoPause?: number

  @ApiPropertyOptional({
    description: 'Auto-delete interval in seconds (0 means disabled)',
    example: 604800,
    type: 'integer',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  autoDelete?: number

  @ApiPropertyOptional({
    description: 'Whether the box should be automatically resumed on proxy access',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  autoResume?: boolean

  @ApiPropertyOptional({
    description: 'Array of volumes to attach to the box',
    type: [BoxVolume],
    required: false,
  })
  @IsOptional()
  @IsArray()
  volumes?: BoxVolume[]
}
