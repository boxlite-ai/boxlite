/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiPropertyOptional } from '@nestjs/swagger'
import { IsDateString, IsOptional } from 'class-validator'

export class GetBoxUsageQueryDto {
  @ApiPropertyOptional({ description: 'ISO start (default: 30d ago)' })
  @IsOptional()
  @IsDateString()
  from?: string

  @ApiPropertyOptional({ description: 'ISO end (default: now)' })
  @IsOptional()
  @IsDateString()
  to?: string
}
