/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiSchema } from '@nestjs/swagger'
import { SavedImageDto } from './saved-image.dto'

@ApiSchema({ name: 'PaginatedSavedImages' })
export class PaginatedSavedImagesDto {
  @ApiProperty({ type: [SavedImageDto] })
  items: SavedImageDto[]

  @ApiProperty()
  total: number

  @ApiProperty()
  page: number

  @ApiProperty()
  totalPages: number
}
