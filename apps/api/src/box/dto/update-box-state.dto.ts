/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator'
import { BoxState } from '../enums/box-state.enum'

export class UpdateBoxStateDto {
  @IsEnum(BoxState)
  @ApiProperty({
    description: 'The new state for the box',
    enum: BoxState,
    example: BoxState.STARTED,
  })
  state: BoxState

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description: 'Optional error message when reporting an error state',
    example: 'Failed to pull artifact image',
  })
  errorReason?: string

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({
    description: 'Whether the box is recoverable',
    example: true,
  })
  recoverable?: boolean
}
