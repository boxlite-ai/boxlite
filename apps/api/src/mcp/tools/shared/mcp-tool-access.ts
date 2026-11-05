/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import type { AuthContext, OrganizationAuthContext } from '../../../common/interfaces/auth-context.interface'
import { BoxService } from '../../../box/services/box.service'
import { OrganizationService } from '../../../organization/services/organization.service'
import { OrganizationUserService } from '../../../organization/services/organization-user.service'
import { OrganizationResourcePermission } from '../../../organization/enums/organization-resource-permission.enum'
import { hasOrganizationResourcePermissions } from '../../../organization/guards/organization-resource-action.guard'
import { assertMcpActive, McpToolError } from './mcp-tool'

@Injectable()
export class McpToolAccess {
  constructor(
    private readonly memberships: OrganizationUserService,
    private readonly organizations: OrganizationService,
    private readonly boxes: BoxService,
  ) {}

  async organization(
    caller: AuthContext,
    organizationId: string,
    permissions: OrganizationResourcePermission[] = [],
    signal?: AbortSignal,
  ): Promise<OrganizationAuthContext> {
    assertMcpActive(signal)
    // Membership is mandatory even when the shared permission policy admits an administrator.
    const organizationUser = await this.memberships.findOne(organizationId, caller.userId)
    assertMcpActive(signal)
    if (!organizationUser || (caller.apiKey && caller.apiKey.organizationId !== organizationId)) {
      throw new McpToolError('Organization not found or not accessible')
    }
    const organization = await this.organizations.findOne(organizationId)
    assertMcpActive(signal)
    if (!organization) throw new McpToolError('Organization not found or not accessible')
    const auth = { ...caller, organizationId, organization, organizationUser }
    if (!hasOrganizationResourcePermissions(auth, permissions)) throw new McpToolError('Operation not permitted')
    return auth
  }

  async box(auth: OrganizationAuthContext, boxId: string, signal?: AbortSignal) {
    assertMcpActive(signal)
    const box = await this.boxes.findOneByIdOrName(boxId, auth.organizationId)
    assertMcpActive(signal)
    if (!box || box.organizationId !== auth.organizationId) {
      throw new McpToolError('Resource not found or not accessible')
    }
    return box
  }
}
