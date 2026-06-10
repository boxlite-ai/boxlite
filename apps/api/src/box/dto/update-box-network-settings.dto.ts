/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { IsOptional, IsString, IsBoolean } from 'class-validator'
import { ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'

@ApiSchema({ name: 'UpdateBoxNetworkSettings' })
export class UpdateBoxNetworkSettingsDto {
  @ApiPropertyOptional({
    description: 'Whether to block all network access for the box',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  networkBlockAll?: boolean

  @ApiPropertyOptional({
    description: 'Comma-separated list of allowed CIDR network addresses for the box',
    example: '192.168.1.0/16,10.0.0.0/24',
  })
  @IsOptional()
  @IsString()
  networkAllowList?: string
}
