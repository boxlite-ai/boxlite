/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Type } from 'class-transformer'
import { IsDefined, IsInt, IsOptional, Max, Min, ValidateIf } from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'

export class OrganizationConcurrencyQueryDto {
  @ApiPropertyOptional({
    description: 'Rolling history window in hours',
    type: Number,
    default: 24,
    minimum: 1,
    maximum: 168,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(168)
  hours = 24
}

export class UpdateOrganizationConcurrencyEntitlementDto {
  @ApiProperty({
    description: 'Maximum concurrent boxes. Null means unlimited.',
    nullable: true,
    minimum: 1,
  })
  @IsDefined()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  maxConcurrentBoxes: number | null
}

export class OrganizationConcurrencyPointDto {
  @ApiProperty({ description: 'When the concurrency count was observed' })
  observedAt: Date

  @ApiProperty({ description: 'Boxes occupying a concurrency slot', minimum: 0 })
  runningBoxes: number
}

export class OrganizationConcurrencyDto {
  @ApiProperty({ description: 'Boxes occupying a concurrency slot now', minimum: 0 })
  current: number

  @ApiProperty({ description: 'Effective concurrency entitlement. Null means unlimited.', nullable: true })
  limit: number | null

  @ApiProperty({
    description: 'Concurrency changes during the requested rolling window',
    type: [OrganizationConcurrencyPointDto],
  })
  points: OrganizationConcurrencyPointDto[]
}
