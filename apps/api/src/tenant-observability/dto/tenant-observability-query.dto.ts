/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Transform, Type } from 'class-transformer'
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator'

export enum TenantTelemetrySource {
  API = 'api',
  WORKER = 'worker',
  RUNNER = 'runner',
  RUNTIME_WRAPPER = 'runtime-wrapper',
  BOX = 'box',
  COLLECTOR_DELIVERY = 'collector-delivery',
}

export enum TenantTelemetrySeverity {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
  FATAL = 'FATAL',
}

const BOX_METRICS = [
  'boxlite.box.cpu.utilization',
  'boxlite.box.cpu.limit',
  'boxlite.box.memory.utilization',
  'boxlite.box.memory.usage',
  'boxlite.box.memory.limit',
  'boxlite.box.filesystem.utilization',
  'boxlite.box.filesystem.usage',
  'boxlite.box.filesystem.total',
  'boxlite.box.filesystem.available',
] as const

export type BoxMetricName = (typeof BOX_METRICS)[number]
export const ALLOWED_BOX_METRICS = new Set<string>(BOX_METRICS)

function toArray(value: unknown): unknown[] | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => (typeof entry === 'string' ? entry.split(',') : entry))
  }
  return typeof value === 'string' ? value.split(',') : [value]
}

export class TenantTelemetryRangeQueryDto {
  @ApiProperty({ type: String, format: 'date-time' })
  @IsDateString()
  from: string

  @ApiProperty({ type: String, format: 'date-time' })
  @IsDateString()
  to: string

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  page = 1

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50

  @ApiPropertyOptional({ enum: TenantTelemetrySource, isArray: true })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsEnum(TenantTelemetrySource, { each: true })
  sources?: TenantTelemetrySource[]

  @ApiPropertyOptional({ description: 'Exact logical Runner ID', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
  runnerId?: string

  @ApiPropertyOptional({ description: 'Exact Box ID', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
  boxId?: string

  @ApiPropertyOptional({ description: 'Exact Job ID', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
  jobId?: string
}

export class TenantLogsQueryDto extends TenantTelemetryRangeQueryDto {
  @ApiPropertyOptional({ description: 'Case-insensitive literal substring', maxLength: 256 })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  search?: string

  @ApiPropertyOptional({ enum: TenantTelemetrySeverity, isArray: true })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsEnum(TenantTelemetrySeverity, { each: true })
  severities?: TenantTelemetrySeverity[]

  @ApiPropertyOptional({ description: 'Exact OpenTelemetry trace ID' })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-fA-F]{32}$/)
  traceId?: string
}

export class TenantTraceDetailQueryDto {
  @ApiPropertyOptional({ description: 'Optional owned Box filter' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
  boxId?: string
}

export class TenantMetricsQueryDto {
  @ApiProperty({ type: String, format: 'date-time' })
  @IsDateString()
  from: string

  @ApiProperty({ type: String, format: 'date-time' })
  @IsDateString()
  to: string

  @ApiProperty({ description: 'Exact Box ID' })
  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
  boxId: string

  @ApiPropertyOptional({ description: 'Allowlisted metric names', isArray: true })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsString({ each: true })
  metricNames?: string[]
}
