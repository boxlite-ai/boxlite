/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiSchema } from '@nestjs/swagger'
import { IsInt, Max, Min, ValidateIf } from 'class-validator'

@ApiSchema({ name: 'UpdateOrganizationDefaultExecTimeout' })
export class UpdateOrganizationDefaultExecTimeoutDto {
  @ApiProperty({
    description: 'Default execution timeout in seconds; null inherits the platform default, zero disables the timer',
    type: 'integer',
    nullable: true,
    minimum: 0,
    maximum: 2147483647,
    example: 1800,
  })
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  defaultExecTimeoutSeconds: number | null
}
