/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { IsArray, IsDate, IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator'
import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import {
  ASSIGNABLE_ORGANIZATION_RESOURCE_PERMISSIONS,
  OrganizationResourcePermission,
} from '../../organization/enums/organization-resource-permission.enum'
import { Type } from 'class-transformer'

@ApiSchema({ name: 'CreateApiKey' })
export class CreateApiKeyDto {
  @ApiProperty({
    description: 'The name of the API key',
    example: 'My API Key',
    required: true,
  })
  @IsNotEmpty()
  @IsString()
  name: string

  @ApiProperty({
    description: 'The list of organization resource permissions explicitly assigned to the API key',
    enum: ASSIGNABLE_ORGANIZATION_RESOURCE_PERMISSIONS,
    isArray: true,
    required: true,
  })
  @IsArray()
  @IsIn(ASSIGNABLE_ORGANIZATION_RESOURCE_PERMISSIONS, { each: true })
  permissions: OrganizationResourcePermission[]

  @ApiPropertyOptional({
    description: 'When the API key expires',
    example: '2025-06-09T12:00:00.000Z',
    nullable: true,
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  expiresAt?: Date
}
