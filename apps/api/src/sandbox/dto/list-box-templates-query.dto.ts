/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiSchema } from '@nestjs/swagger'
import { IsOptional, IsString, IsEnum } from 'class-validator'
import { PageNumber } from '../../common/decorators/page-number.decorator'
import { PageLimit } from '../../common/decorators/page-limit.decorator'

export enum BoxTemplateSortField {
  NAME = 'name',
  STATE = 'state',
  LAST_USED_AT = 'lastUsedAt',
  CREATED_AT = 'createdAt',
}

export enum BoxTemplateSortDirection {
  ASC = 'asc',
  DESC = 'desc',
}

@ApiSchema({ name: 'ListBoxTemplatesQuery' })
export class ListBoxTemplatesQueryDto {
  @PageNumber(1)
  page = 1

  @PageLimit(100)
  limit = 100

  @ApiProperty({
    name: 'name',
    description: 'Filter by partial name match',
    required: false,
    type: String,
    example: 'ubuntu',
  })
  @IsOptional()
  @IsString()
  name?: string

  @ApiProperty({
    name: 'sort',
    description: 'Field to sort by',
    required: false,
    enum: BoxTemplateSortField,
    default: BoxTemplateSortField.LAST_USED_AT,
  })
  @IsOptional()
  @IsEnum(BoxTemplateSortField)
  sort = BoxTemplateSortField.LAST_USED_AT

  @ApiProperty({
    name: 'order',
    description: 'Direction to sort by',
    required: false,
    enum: BoxTemplateSortDirection,
    default: BoxTemplateSortDirection.DESC,
  })
  @IsOptional()
  @IsEnum(BoxTemplateSortDirection)
  order = BoxTemplateSortDirection.DESC
}
