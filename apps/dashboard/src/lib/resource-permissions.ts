/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CreateApiKeyPermissionsEnum, CreateApiKeyProxyPermissionsEnum } from '@boxlite-ai/api-client'

export type ResourcePermission = CreateApiKeyPermissionsEnum | CreateApiKeyProxyPermissionsEnum

function isProxyPermission(permission: ResourcePermission): permission is CreateApiKeyProxyPermissionsEnum {
  return Object.values(CreateApiKeyProxyPermissionsEnum).some((value) => value === permission)
}

export function splitResourcePermissions(selection: ResourcePermission[]) {
  return {
    permissions: selection.filter((permission) => !isProxyPermission(permission)),
    proxyPermissions: selection.filter(isProxyPermission),
  }
}
