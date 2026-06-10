/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiSchema } from '@nestjs/swagger'
import { IsNotEmpty, IsString, MaxLength } from 'class-validator'

@ApiSchema({ name: 'UpdateOrganizationName' })
export class UpdateOrganizationNameDto {
  @ApiProperty({
    description: 'The public name of the organization',
    example: 'Default Organization',
    required: true,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string
}
