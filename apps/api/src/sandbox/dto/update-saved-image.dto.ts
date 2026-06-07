/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiSchema } from '@nestjs/swagger'
import { IsBoolean } from 'class-validator'

@ApiSchema({ name: 'SetSavedImageGeneralStatus' })
export class SetSavedImageGeneralStatusDto {
  @ApiProperty({
    description: 'Whether the savedImage is general',
    example: true,
  })
  @IsBoolean()
  general: boolean
}
