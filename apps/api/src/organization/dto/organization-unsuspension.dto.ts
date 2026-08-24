/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import { IsOptional, IsString } from 'class-validator'

@ApiSchema({ name: 'OrganizationUnsuspension' })
export class OrganizationUnsuspensionDto {
  @ApiPropertyOptional({
    description: 'Unsuspend only if the organization is currently suspended with this exact reason',
  })
  @IsOptional()
  @IsString()
  ifReason?: string
}
