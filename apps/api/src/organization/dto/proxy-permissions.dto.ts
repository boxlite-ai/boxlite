/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiPropertyOptional } from '@nestjs/swagger'
import { IsArray, IsIn, ValidateIf } from 'class-validator'
import { OrganizationResourcePermission as Permission } from '../enums/organization-resource-permission.enum'

const PROXY_PERMISSIONS = [Permission.WRITE_PROXIES, Permission.DELETE_PROXIES] as const
type ProxyPermission = (typeof PROXY_PERMISSIONS)[number]

function isProxyPermission(permission: Permission): permission is ProxyPermission {
  return PROXY_PERMISSIONS.some((value) => value === permission)
}

export const BASE_RESOURCE_PERMISSIONS = Object.values(Permission).filter(
  (permission) => !isProxyPermission(permission),
)

export class ProxyPermissionsDto {
  @ApiPropertyOptional({ description: 'Outbound proxy permissions', enum: [...PROXY_PERMISSIONS], isArray: true })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @IsIn([...PROXY_PERMISSIONS], { each: true })
  proxyPermissions?: ProxyPermission[]
}

export function splitResourcePermissions(permissions: Permission[]) {
  const proxyPermissions = permissions.filter(isProxyPermission)
  return {
    permissions: permissions.filter((permission) => !isProxyPermission(permission)),
    ...(proxyPermissions.length ? { proxyPermissions } : {}),
  }
}
