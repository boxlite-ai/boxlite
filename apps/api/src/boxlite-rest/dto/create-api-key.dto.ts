/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Type } from 'class-transformer'
import {
  ArrayNotEmpty,
  IsArray,
  IsDate,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Matches,
} from 'class-validator'
import { OrganizationResourcePermission } from '../../organization/enums/organization-resource-permission.enum'

// Keys are addressed by name on this surface (`DELETE /v1/api-keys/{name}`),
// so the name has to survive a path segment. A `/` would split into two
// segments and leave the key unrevokable by the code that minted it.
export const MAX_API_KEY_NAME_LENGTH = 128
const API_KEY_NAME_PATTERN = /^[^/]+$/

/**
 * `POST /v1/api-keys` request body. Snake_case to match the rest of the
 * BoxLite REST surface; the dashboard's own `/api-keys` controller keeps its
 * camelCase shape.
 */
export class RestCreateApiKeyDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(MAX_API_KEY_NAME_LENGTH)
  @Matches(API_KEY_NAME_PATTERN, { message: 'name must not contain "/"' })
  name: string

  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(OrganizationResourcePermission, { each: true })
  permissions: OrganizationResourcePermission[]

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  expires_at?: Date
}
