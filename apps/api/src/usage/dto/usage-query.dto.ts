/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import { IsOptional, IsRFC3339, IsString, ValidateBy, ValidationArguments } from 'class-validator'

export const MAX_USAGE_RANGE_MS = 366 * 24 * 60 * 60 * 1000

function IsValidUsageRange() {
  return ValidateBy({
    name: 'isValidUsageRange',
    validator: {
      validate(to: unknown, args: ValidationArguments): boolean {
        if (typeof to !== 'string') {
          return false
        }

        const from = (args.object as UsageRangeQueryDto).from
        if (typeof from !== 'string') {
          return false
        }

        const fromMs = Date.parse(from)
        const toMs = Date.parse(to)
        return Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs < toMs && toMs - fromMs <= MAX_USAGE_RANGE_MS
      },
      defaultMessage(): string {
        return 'to must be after from and the usage range must not exceed 366 days'
      },
    },
  })
}

@ApiSchema({ name: 'UsageRangeQuery' })
export class UsageRangeQueryDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Inclusive range start as an RFC3339 timestamp',
  })
  @IsRFC3339()
  from!: string

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Exclusive range end as an RFC3339 timestamp',
  })
  @IsRFC3339()
  @IsValidUsageRange()
  to!: string

  toDateRange(): { from: Date; to: Date } {
    return {
      from: new Date(this.from),
      to: new Date(this.to),
    }
  }
}

@ApiSchema({ name: 'UsageChartQuery' })
export class UsageChartQueryDto extends UsageRangeQueryDto {
  @ApiPropertyOptional({
    type: String,
    description: 'Only include usage recorded in this region',
  })
  @IsOptional()
  @IsString()
  region?: string
}
