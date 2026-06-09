/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { IsBoolean, IsOptional, IsString } from 'class-validator'
import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'

@ApiSchema({ name: 'CreateRunner' })
export class CreateRunnerDto {
  @IsString()
  @ApiProperty()
  regionId: string

  @IsString()
  @ApiProperty()
  name: string

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({
    description:
      'Declare that this runner binary supports the security-options payload. ' +
      'Defaults to false — must be explicitly set to true only for runner builds ' +
      'that handle the security field in CreateSandboxDTO.',
    default: false,
  })
  supportsSecurityOptions?: boolean
}
