/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Delete, Get, HttpCode, Param, Query, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { Audit } from '../audit/decorators/audit.decorator'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'
import { RequiredOrganizationMemberRole } from '../organization/decorators/required-organization-member-role.decorator'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationUserDto } from '../organization/dto/organization-user.dto'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { OrganizationActionGuard } from '../organization/guards/organization-action.guard'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { AdminPageQuery, adminNextPage } from './dto/admin-page-query.dto'

type RestMember = {
  type: 'user'
  id: string
  email: string | null
  name: string
  role: OrganizationMemberRole
  added_at: string
}

// Spec-first surface: openapi/admin.openapi.yaml.
@Controller('v1/organizations/users')
@ApiExcludeController()
@UseGuards(CombinedAuthGuard, AuthenticatedRateLimitGuard, OrganizationActionGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class BoxliteMemberController {
  constructor(private readonly organizationUserService: OrganizationUserService) {}

  @Get()
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.READ_MEMBERS])
  async list(@AuthContext() authContext: OrganizationAuthContext, @Query() page: AdminPageQuery) {
    const organizationId = authContext.organizationId
    const members = await this.organizationUserService.findPage(
      organizationId,
      page.pageSize,
      page.after(organizationId, 'users'),
    )
    return {
      users: members.slice(0, page.pageSize).map((member) => this.toResponse(member)),
      ...adminNextPage(members, page.pageSize, organizationId, 'users', (member) => member.userId),
    }
  }

  // Also revokes the member's API keys in this organization (OrganizationUserService.delete).
  @Delete(':userId')
  @HttpCode(204)
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_MEMBERS])
  @Audit({
    action: AuditAction.DELETE,
    targetType: AuditTarget.ORGANIZATION_USER,
    targetIdFromRequest: (req) => req.params.userId,
  })
  async remove(@AuthContext() authContext: OrganizationAuthContext, @Param('userId') userId: string): Promise<void> {
    await this.organizationUserService.delete(authContext.organizationId, userId)
  }

  private toResponse(member: OrganizationUserDto): RestMember {
    return {
      type: 'user',
      id: member.userId,
      email: member.email || null,
      name: member.name,
      role: member.role,
      added_at: new Date(member.createdAt).toISOString(),
    }
  }
}
