/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { IsArray, IsDate, IsEnum, IsNotEmpty, IsOptional, IsString, ValidateIf } from 'class-validator'
import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import { OrganizationResourcePermission } from '../../organization/enums/organization-resource-permission.enum'
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

  @ApiPropertyOptional({
    description:
      'When omitted, requests all non-App permissions and the App Hosting permissions enabled for the organization. The caller must be allowed to grant every requested permission.',
    enum: OrganizationResourcePermission,
    isArray: true,
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @IsEnum(OrganizationResourcePermission, { each: true })
  permissions?: OrganizationResourcePermission[]

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
