/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Delete, Get, HttpCode, Param, UseGuards } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { Audit } from '../audit/decorators/audit.decorator'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'
import { RequiredOrganizationMemberRole } from '../organization/decorators/required-organization-member-role.decorator'
import { OrganizationUserDto } from '../organization/dto/organization-user.dto'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationActionGuard } from '../organization/guards/organization-action.guard'
import { OrganizationUserService } from '../organization/services/organization-user.service'

type RestMember = {
  user_id: string
  email: string
  name: string
  role: OrganizationMemberRole
  joined_at: string
}

// Spec-first surface: the contract is openapi/tenant.openapi.yaml (cloud-only, not the Box API).
@Controller(['v1/members', 'v1/:prefix/members'])
@ApiExcludeController()
@UseGuards(CombinedAuthGuard, OrganizationActionGuard)
export class BoxliteMemberController {
  constructor(private readonly organizationUserService: OrganizationUserService) {}

  @Get()
  async list(@AuthContext() authContext: OrganizationAuthContext): Promise<{ members: RestMember[] }> {
    const members = await this.organizationUserService.findAll(authContext.organizationId)
    return { members: members.map((member) => this.toResponse(member)) }
  }

  // Also revokes the member's API keys in this organization (OrganizationUserService.delete).
  @Delete(':userId')
  @HttpCode(204)
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
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
      user_id: member.userId,
      email: member.email,
      name: member.name,
      role: member.role,
      joined_at: new Date(member.createdAt).toISOString(),
    }
  }
}
