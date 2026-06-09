/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiSchema } from '@nestjs/swagger'
import { BoxTemplateDto } from './box-template.dto'

@ApiSchema({ name: 'PaginatedBoxTemplates' })
export class PaginatedBoxTemplatesDto {
  @ApiProperty({ type: [BoxTemplateDto] })
  items: BoxTemplateDto[]

  @ApiProperty()
  total: number

  @ApiProperty()
  page: number

  @ApiProperty()
  totalPages: number
}
