/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator'
import { SystemRole } from '../enums/system-role.enum'
import { CreateOrganizationQuotaDto } from '../../organization/dto/create-organization-quota.dto'

@ApiSchema({ name: 'CreateUser' })
export class CreateUserDto {
  @ApiProperty()
  @IsString()
  id: string

  @ApiProperty()
  @IsString()
  name: string

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  email?: string

  @ApiPropertyOptional()
  @IsOptional()
  defaultOrganizationQuota?: CreateOrganizationQuotaDto

  @ApiPropertyOptional({
    description: 'Deprecated alias for defaultOrganizationQuota.',
    deprecated: true,
  })
  @IsOptional()
  personalOrganizationQuota?: CreateOrganizationQuotaDto

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  defaultOrganizationDefaultRegionId?: string

  @ApiPropertyOptional({
    description: 'Deprecated alias for defaultOrganizationDefaultRegionId.',
    deprecated: true,
  })
  @IsString()
  @IsOptional()
  personalOrganizationDefaultRegionId?: string

  @ApiPropertyOptional({
    enum: SystemRole,
  })
  @IsEnum(SystemRole)
  @IsOptional()
  role?: SystemRole

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  emailVerified?: boolean
}
