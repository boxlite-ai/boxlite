/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator'
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

  // What the runner's image reference actually resolved to. Sent once, with the
  // report that the box is up, and only by the runner that pulled it — the
  // control plane never contacts a registry itself, so this is the only way a
  // digest enters the catalog.
  @IsOptional()
  @IsString()
  // Shape-checked by the registrar rather than here. This is a side channel on
  // a state report: refusing the whole report over it would leave the control
  // plane believing a running box is still starting, which is a worse failure
  // than not recording an image.
  @ApiPropertyOptional({
    description: 'Registry digest of the image the box booted from',
    example: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  })
  imageDigest?: string

  @IsOptional()
  @IsInt()
  @Min(0)
  @ApiPropertyOptional({
    description: 'Declared on-registry size of that image, in bytes',
    example: 123456789,
  })
  imageSizeBytes?: number
}
