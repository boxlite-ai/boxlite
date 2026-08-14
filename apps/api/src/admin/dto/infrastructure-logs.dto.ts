/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsDateString, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator'
import { LogEntryDto } from '../../box-telemetry/dto/log-entry.dto'

export enum InfrastructureLogSource {
  RUNNER = 'runner',
  COLLECTOR = 'collector',
}

export class InfrastructureLogsQueryDto {
  @ApiPropertyOptional({ enum: InfrastructureLogSource, default: InfrastructureLogSource.RUNNER })
  @IsOptional()
  @IsEnum(InfrastructureLogSource)
  source?: InfrastructureLogSource

  @ApiProperty({ type: String, format: 'date-time' })
  @IsDateString()
  from: string

  @ApiProperty({ type: String, format: 'date-time' })
  @IsDateString()
  to: string

  @ApiPropertyOptional({ description: 'Case-sensitive literal phrase to find in a log message', maxLength: 256 })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  search?: string

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50

  @ApiPropertyOptional({ description: 'Opaque CloudWatch pagination cursor' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  nextToken?: string
}

@ApiSchema({ name: 'InfrastructureLogs' })
export class InfrastructureLogsDto {
  @ApiProperty({ type: [LogEntryDto] })
  items: LogEntryDto[]

  @ApiPropertyOptional({ description: 'Opaque cursor for the next CloudWatch page' })
  nextToken?: string
}
