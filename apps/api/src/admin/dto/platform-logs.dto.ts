/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator'
import { LogsQueryParamsDto } from '../../box-telemetry/dto/telemetry-query-params.dto'

export enum PlatformLogSource {
  API = 'api',
  WORKER = 'worker',
  RUNNER = 'runner',
  BOX = 'box',
}

export class PlatformLogsQueryDto extends LogsQueryParamsDto {
  @ApiPropertyOptional({ enum: PlatformLogSource, default: PlatformLogSource.API })
  @IsOptional()
  @IsEnum(PlatformLogSource)
  source: PlatformLogSource = PlatformLogSource.API

  @ApiPropertyOptional({ minimum: 1, maximum: 10_000, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  declare page?: number

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  declare limit?: number

  @ApiPropertyOptional({ description: 'Case-insensitive text search in the log body', maxLength: 256 })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  declare search?: string

  @ApiPropertyOptional({ description: 'Exact Box ID. Required when source is box.', maxLength: 128 })
  @ValidateIf((query: PlatformLogsQueryDto) => query.source === PlatformLogSource.BOX)
  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
  boxId?: string

  @ApiPropertyOptional({ description: 'Exact OpenTelemetry trace ID', maxLength: 32 })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-fA-F]{32}$/)
  traceId?: string
}
