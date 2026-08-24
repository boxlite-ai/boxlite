/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import { RegionType } from '../../region/enums/region-type.enum'
import { RunnerDto } from '../../box/dto/runner.dto'

@ApiSchema({ name: 'AdminRunner' })
export class AdminRunnerDto extends RunnerDto {
  @ApiPropertyOptional({
    description: 'The region type of the runner',
    enum: RegionType,
    enumName: 'RegionType',
    example: Object.values(RegionType)[0],
  })
  regionType?: RegionType
}
