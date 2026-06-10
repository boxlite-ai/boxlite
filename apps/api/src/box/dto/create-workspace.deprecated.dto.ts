/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { IsEnum, IsObject, IsOptional, IsString, IsNumber, IsBoolean } from 'class-validator'
import { ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import { BoxClass } from '../enums/box-class.enum'
import { BoxVolume } from './box.dto'

enum RunnerRegion {
  EU = 'eu',
  US = 'us',
  ASIA = 'asia',
}
@ApiSchema({ name: 'CreateWorkspace' })
export class CreateWorkspaceDto {
  @ApiPropertyOptional({
    description: 'The image used for the workspace',
    example: 'boxlite-ai/workspace:latest',
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
    description: 'Environment variables for the workspace',
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { NODE_ENV: 'production' },
  })
  @IsOptional()
  @IsObject()
  env?: { [key: string]: string }

  @ApiPropertyOptional({
    description: 'Labels for the workspace',
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { 'boxlite.io/public': 'true' },
  })
  @IsOptional()
  @IsObject()
  labels?: { [key: string]: string }

  @ApiPropertyOptional({
    description: 'Whether the workspace http preview is publicly accessible',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  public?: boolean

  @ApiPropertyOptional({
    description: 'The workspace class type',
    enum: BoxClass,
    example: Object.values(BoxClass)[0],
  })
  @IsOptional()
  @IsEnum(BoxClass)
  class?: BoxClass

  @ApiPropertyOptional({
    description: 'The target (region) where the workspace will be created',
    enum: RunnerRegion,
    example: Object.values(RunnerRegion)[0],
  })
  @IsOptional()
  @IsEnum(RunnerRegion)
  target?: RunnerRegion

  @ApiPropertyOptional({
    description: 'CPU cores allocated to the workspace',
    example: 2,
    type: 'integer',
  })
  @IsOptional()
  @IsNumber()
  cpu?: number

  @ApiPropertyOptional({
    description: 'GPU units allocated to the workspace',
    example: 1,
    type: 'integer',
  })
  @IsOptional()
  @IsNumber()
  gpu?: number

  @ApiPropertyOptional({
    description: 'Memory allocated to the workspace in GB',
    example: 1,
    type: 'integer',
  })
  @IsOptional()
  @IsNumber()
  memory?: number

  @ApiPropertyOptional({
    description: 'Disk space allocated to the workspace in GB',
    example: 3,
    type: 'integer',
  })
  @IsOptional()
  @IsNumber()
  disk?: number

  @ApiPropertyOptional({
    description: 'Auto-stop interval in minutes (0 means disabled)',
    example: 30,
    type: 'integer',
  })
  @IsOptional()
  @IsNumber()
  autoStopInterval?: number

  @ApiPropertyOptional({
    description: 'Array of volumes to attach to the workspace',
    type: [BoxVolume],
    required: false,
  })
  @IsOptional()
  volumes?: BoxVolume[]
}
