/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsDate, IsEnum, IsOptional } from 'class-validator'

export enum UsageConcurrencyGranularity {
  HOUR = 'hour',
  DAY = 'day',
}

export class UsageConcurrencyQueryDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Inclusive start of the requested timeline. Defaults to 30 days before `to`.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Inclusive end of the requested timeline. Defaults to the current time.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date

  @ApiPropertyOptional({
    enum: UsageConcurrencyGranularity,
    default: UsageConcurrencyGranularity.DAY,
    description: 'Spacing between concurrency snapshots.',
  })
  @IsOptional()
  @IsEnum(UsageConcurrencyGranularity)
  granularity = UsageConcurrencyGranularity.DAY
}

export class UsageConcurrencyPointDto {
  @ApiProperty({ type: String, format: 'date-time' })
  observedAt: Date

  @ApiProperty({ type: 'integer', minimum: 0 })
  runningBoxes: number
}

export class UsageConcurrencySeriesDto {
  @ApiProperty({ type: String, format: 'date-time' })
  from: Date

  @ApiProperty({ type: String, format: 'date-time' })
  to: Date

  @ApiProperty({ enum: UsageConcurrencyGranularity })
  granularity: UsageConcurrencyGranularity

  @ApiProperty({ type: 'integer', minimum: 0 })
  current: number

  @ApiProperty({ type: [UsageConcurrencyPointDto] })
  points: UsageConcurrencyPointDto[]
}
