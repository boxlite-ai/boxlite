/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { Audit, TypedRequest } from '../audit/decorators/audit.decorator'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'
import { RequiredOrganizationMemberRole } from '../organization/decorators/required-organization-member-role.decorator'
import { OrganizationInvitation } from '../organization/entities/organization-invitation.entity'
import { OrganizationInvitationStatus } from '../organization/enums/organization-invitation-status.enum'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationActionGuard } from '../organization/guards/organization-action.guard'
import { OrganizationInvitationService } from '../organization/services/organization-invitation.service'
import { CreateInvitationDto } from './dto/create-invitation.dto'

type RestInvitation = {
  id: string
  email: string
  status: OrganizationInvitationStatus
  invited_by: string
  created_at: string
  expires_at: string
}

// Spec-first surface: the contract is openapi/tenant.openapi.yaml (cloud-only, not the Box API).
@Controller(['v1/invitations', 'v1/:prefix/invitations'])
@ApiExcludeController()
@UseGuards(CombinedAuthGuard, AuthenticatedRateLimitGuard, OrganizationActionGuard)
export class BoxliteInvitationController {
  constructor(private readonly organizationInvitationService: OrganizationInvitationService) {}

  // Members carry no roles yet, so every invitation makes the invitee an owner.
  @Post()
  @HttpCode(201)
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  @Audit({
    action: AuditAction.CREATE,
    targetType: AuditTarget.ORGANIZATION_INVITATION,
    targetIdFromResult: (result: RestInvitation) => result?.id,
    requestMetadata: {
      body: (req: TypedRequest<CreateInvitationDto>) => ({
        email: req.body?.email,
        expires_at: req.body?.expires_at,
      }),
    },
  })
  async create(
    @AuthContext() authContext: OrganizationAuthContext,
    @Body() dto: CreateInvitationDto,
  ): Promise<RestInvitation> {
    const invitation = await this.organizationInvitationService.create(
      authContext.organizationId,
      { email: dto.email, role: OrganizationMemberRole.OWNER, assignedRoleIds: [], expiresAt: dto.expires_at },
      authContext.email,
    )
    return this.toResponse(invitation)
  }

  @Get()
  async list(@AuthContext() authContext: OrganizationAuthContext): Promise<{ invitations: RestInvitation[] }> {
    const invitations = await this.organizationInvitationService.findPending(authContext.organizationId)
    return { invitations: invitations.map((invitation) => this.toResponse(invitation)) }
  }

  @Delete(':invitationId')
  @HttpCode(204)
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  @Audit({
    action: AuditAction.DELETE,
    targetType: AuditTarget.ORGANIZATION_INVITATION,
    targetIdFromRequest: (req) => req.params.invitationId,
  })
  async cancel(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('invitationId') invitationId: string,
  ): Promise<void> {
    await this.organizationInvitationService.cancel(authContext.organizationId, invitationId)
  }

  private toResponse(invitation: OrganizationInvitation): RestInvitation {
    return {
      id: invitation.id,
      email: invitation.email,
      status: invitation.status,
      invited_by: invitation.invitedBy,
      created_at: new Date(invitation.createdAt).toISOString(),
      expires_at: new Date(invitation.expiresAt).toISOString(),
    }
  }
}
