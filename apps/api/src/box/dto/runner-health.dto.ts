/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator'
import { Type } from 'class-transformer'
import { BoxState } from '../enums/box-state.enum'

@ApiSchema({ name: 'RunnerHealthMetrics' })
export class RunnerHealthMetricsDto {
  @ApiProperty({
    description: 'Current CPU load average',
    example: 0.98,
  })
  @IsNumber()
  currentCpuLoadAverage: number

  @ApiProperty({
    description: 'Current CPU usage percentage',
    example: 45.5,
  })
  @IsNumber()
  currentCpuUsagePercentage: number

  @ApiProperty({
    description: 'Current memory usage percentage',
    example: 60.2,
  })
  @IsNumber()
  currentMemoryUsagePercentage: number

  @ApiProperty({
    description: 'Current disk usage percentage',
    example: 35.8,
  })
  @IsNumber()
  currentDiskUsagePercentage: number

  @ApiProperty({
    description: 'Currently allocated CPU cores',
    example: 8,
  })
  @IsNumber()
  currentAllocatedCpu: number

  @ApiProperty({
    description: 'Currently allocated memory in GiB',
    example: 16,
  })
  @IsNumber()
  currentAllocatedMemoryGiB: number

  @ApiProperty({
    description: 'Currently allocated disk in GiB',
    example: 100,
  })
  @IsNumber()
  currentAllocatedDiskGiB: number

  @ApiProperty({
    description: 'Number of started boxes',
    example: 10,
  })
  @IsNumber()
  currentStartedBoxes: number

  @ApiProperty({
    description: 'Total CPU cores on the runner',
    example: 8,
  })
  @IsNumber()
  cpu: number

  @ApiProperty({
    description: 'Total RAM in GiB on the runner',
    example: 16,
  })
  @IsNumber()
  memoryGiB: number

  @ApiProperty({
    description: 'Total disk space in GiB on the runner',
    example: 100,
  })
  @IsNumber()
  diskGiB: number
}

@ApiSchema({ name: 'RunnerServiceHealth' })
export class RunnerServiceHealthDto {
  @ApiProperty({
    description: 'Name of the service being checked',
    example: 'runner',
  })
  @IsString()
  serviceName: string

  @ApiProperty({
    description: 'Whether the service is healthy',
    example: false,
  })
  @IsBoolean()
  healthy: boolean

  @ApiPropertyOptional({
    description: 'Error reason if the service is unhealthy',
    example: 'Cannot connect to the runner',
  })
  @IsOptional()
  @IsString()
  errorReason?: string
}

@ApiSchema({ name: 'RunnerBoxObservation' })
export class RunnerBoxObservationDto {
  @ApiProperty({
    description: 'Control-plane box ID observed on the runner',
    example: 'box000000001',
  })
  @IsString()
  boxId: string

  @ApiProperty({
    description: 'Actual box state observed by the runner',
    enum: BoxState,
    enumName: 'BoxState',
    example: BoxState.STARTED,
  })
  @IsEnum(BoxState)
  actualState: BoxState

  @ApiProperty({
    description:
      'Control-plane runtime generation associated with the observed instance. Zero means the runner cannot provide generation evidence.',
    type: 'integer',
    format: 'int64',
    minimum: 0,
    example: 12,
  })
  @IsInt()
  @Min(0)
  runtimeGeneration: number
}

@ApiSchema({ name: 'RunnerHealthcheck' })
export class RunnerHealthcheckDto {
  @ApiProperty({
    description: 'Unique epoch generated when the runner process starts',
    format: 'uuid',
    example: '32b49a8e-2cf8-44af-9484-e2f52aa985ea',
  })
  @IsUUID()
  runnerEpoch: string

  @ApiProperty({
    description: 'Monotonically increasing process incarnation persisted by the runner',
    type: 'integer',
    format: 'int64',
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
    example: 3,
  })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  runnerIncarnation: number

  @ApiProperty({
    description: 'Monotonically increasing healthcheck sequence within the runner epoch',
    type: 'integer',
    format: 'int64',
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
    example: 42,
  })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  sequence: number

  @ApiPropertyOptional({
    description:
      'Complete local box inventory. Omitted when inventory collection fails; an empty array is a successful empty snapshot.',
    type: [RunnerBoxObservationDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RunnerBoxObservationDto)
  boxes?: RunnerBoxObservationDto[]

  @ApiPropertyOptional({
    description: 'Runner metrics',
    type: RunnerHealthMetricsDto,
  })
  @IsOptional()
  metrics?: RunnerHealthMetricsDto

  @ApiPropertyOptional({
    description: 'Health status of individual services on the runner',
    type: [RunnerServiceHealthDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RunnerServiceHealthDto)
  serviceHealth?: RunnerServiceHealthDto[]

  @ApiPropertyOptional({
    description: 'Runner domain',
    example: 'runner-123.boxlite.example.com',
  })
  @IsOptional()
  domain?: string

  @ApiPropertyOptional({
    description: 'Runner proxy URL',
    example: 'http://proxy.boxlite.example.com:8080',
  })
  @IsOptional()
  proxyUrl?: string

  @ApiPropertyOptional({
    description: 'Runner API URL',
    example: 'http://api.boxlite.example.com:8080',
  })
  @IsOptional()
  apiUrl?: string

  @ApiProperty({
    description: 'Runner app version',
    example: 'v0.0.0-dev',
  })
  @IsString()
  appVersion: string
}
