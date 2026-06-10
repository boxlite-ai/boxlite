/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiPropertyOptional } from '@nestjs/swagger'
import { Transform, Type } from 'class-transformer'
import { IsArray, IsDateString, IsIn, IsNumber, IsOptional, IsString, Min } from 'class-validator'

export const OBSERVABILITY_LAYERS = ['api', 'runner', 'ec2_host', 'box'] as const
export type ObservabilityLayer = (typeof OBSERVABILITY_LAYERS)[number]

export class AdminObservabilityQueryParamsDto {
  @ApiPropertyOptional({ type: String, format: 'date-time', description: 'Start of time range (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  from?: string

  @ApiPropertyOptional({ type: String, format: 'date-time', description: 'End of time range (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  to?: string

  @ApiPropertyOptional({ type: Number, default: 1, description: 'Page number (1-indexed)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1

  @ApiPropertyOptional({ type: Number, default: 100, description: 'Number of items per page' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number = 100

  @ApiPropertyOptional({ enum: OBSERVABILITY_LAYERS, description: 'Telemetry producer layer' })
  @IsOptional()
  @IsIn(OBSERVABILITY_LAYERS)
  layer?: ObservabilityLayer

  @ApiPropertyOptional({ type: String, description: 'OpenTelemetry service.name filter' })
  @IsOptional()
  @IsString()
  serviceName?: string

  @ApiPropertyOptional({ type: String, description: 'Organization ID filter' })
  @IsOptional()
  @IsString()
  orgId?: string

  @ApiPropertyOptional({ type: String, description: 'User ID filter' })
  @IsOptional()
  @IsString()
  userId?: string

  @ApiPropertyOptional({ type: String, description: 'Box ID filter' })
  @IsOptional()
  @IsString()
  boxId?: string

  @ApiPropertyOptional({ type: String, description: 'Runner ID filter' })
  @IsOptional()
  @IsString()
  runnerId?: string

  @ApiPropertyOptional({ type: String, description: 'Machine or host ID filter' })
  @IsOptional()
  @IsString()
  machineId?: string

  @ApiPropertyOptional({ type: String, description: 'Trace ID filter' })
  @IsOptional()
  @IsString()
  traceId?: string

  @ApiPropertyOptional({ type: String, description: 'Request ID filter' })
  @IsOptional()
  @IsString()
  requestId?: string

  @ApiPropertyOptional({ type: String, description: 'Operation ID filter' })
  @IsOptional()
  @IsString()
  operationId?: string

  @ApiPropertyOptional({ type: String, description: 'Execution ID filter' })
  @IsOptional()
  @IsString()
  executionId?: string

  @ApiPropertyOptional({ type: String, description: 'Job ID filter' })
  @IsOptional()
  @IsString()
  jobId?: string
}

export class AdminObservabilityLogsQueryParamsDto extends AdminObservabilityQueryParamsDto {
  @ApiPropertyOptional({
    type: [String],
    description: 'Filter by severity levels (DEBUG, INFO, WARN, ERROR)',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => (Array.isArray(value) ? value : [value]))
  severities?: string[]

  @ApiPropertyOptional({ type: String, description: 'Search in log body' })
  @IsOptional()
  @IsString()
  search?: string
}

export class AdminObservabilityMetricsQueryParamsDto extends AdminObservabilityQueryParamsDto {
  @ApiPropertyOptional({
    type: [String],
    description: 'Filter by metric names',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => (Array.isArray(value) ? value : [value]))
  metricNames?: string[]
}
