/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiSchema } from '@nestjs/swagger'
import { IsArray, IsIn, IsString } from 'class-validator'
import { OrganizationResourcePermission } from '../enums/organization-resource-permission.enum'
import { BASE_RESOURCE_PERMISSIONS, ProxyPermissionsDto } from './proxy-permissions.dto'

@ApiSchema({ name: 'UpdateOrganizationRole' })
export class UpdateOrganizationRoleDto extends ProxyPermissionsDto {
  @ApiProperty({
    description: 'The name of the role',
    example: 'Maintainer',
    required: true,
  })
  @IsString()
  name: string

  @ApiProperty({
    description: 'The description of the role',
    example: 'Can manage all resources',
  })
  @IsString()
  description: string

  @ApiProperty({
    description: 'The list of permissions assigned to the role',
    enum: BASE_RESOURCE_PERMISSIONS,
    isArray: true,
    required: true,
  })
  @IsArray()
  @IsIn(BASE_RESOURCE_PERMISSIONS, { each: true })
  permissions: OrganizationResourcePermission[]
}
