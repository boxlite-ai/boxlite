/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiSchema } from '@nestjs/swagger'
import { BoxDto } from './box.dto'

@ApiSchema({ name: 'PaginatedBoxes' })
export class PaginatedBoxesDto {
  @ApiProperty({ type: [BoxDto] })
  items: BoxDto[]

  @ApiProperty()
  total: number

  @ApiProperty()
  page: number

  @ApiProperty()
  totalPages: number
}
