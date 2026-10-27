/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { isUUID } from 'class-validator'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { Audit, TypedRequest } from '../audit/decorators/audit.decorator'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'
import { RequiredOrganizationMemberRole } from '../organization/decorators/required-organization-member-role.decorator'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationInvitation } from '../organization/entities/organization-invitation.entity'
import { OrganizationInvitationStatus } from '../organization/enums/organization-invitation-status.enum'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { OrganizationActionGuard } from '../organization/guards/organization-action.guard'
import { OrganizationInvitationService } from '../organization/services/organization-invitation.service'
import { CreateInvitationDto } from './dto/create-invitation.dto'
import { AdminPageQuery, adminNextPage } from './dto/admin-page-query.dto'

type RestInvitation = {
  type: 'invite'
  id: string
  email: string
  role: OrganizationMemberRole
  status: OrganizationInvitationStatus | 'expired'
  added_at: string
  expires_at: string
}

// Spec-first surface: openapi/admin.openapi.yaml.
@Controller('v1/organizations/invites')
@ApiExcludeController()
@UseGuards(CombinedAuthGuard, AuthenticatedRateLimitGuard, OrganizationActionGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class BoxliteInvitationController {
  constructor(private readonly organizationInvitationService: OrganizationInvitationService) {}

  // Members carry no roles yet, so every invitation makes the invitee an owner.
  @Post()
  @HttpCode(201)
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_MEMBERS])
  @Audit({
    action: AuditAction.CREATE,
    targetType: AuditTarget.ORGANIZATION_INVITATION,
    targetIdFromResult: (result: RestInvitation) => result?.id,
    requestMetadata: {
      body: (req: TypedRequest<CreateInvitationDto>) => ({
        email: req.body?.email,
        role: req.body?.role,
        expires_at: req.body?.expires_at,
      }),
    },
  })
  async create(
    @AuthContext() authContext: OrganizationAuthContext,
    @Body() dto: CreateInvitationDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<RestInvitation> {
    if (idempotencyKey !== undefined && !isUUID(idempotencyKey)) {
      throw new BadRequestException('Idempotency-Key must be a UUID')
    }
    const invitation = await this.organizationInvitationService.create(
      authContext.organizationId,
      {
        email: dto.email,
        role: dto.role,
        assignedRoleIds: [],
        expiresAt: dto.expires_at ? new Date(dto.expires_at) : undefined,
      },
      authContext.email,
      { userId: authContext.userId, idempotencyKey },
    )
    // A retry returns the creation snapshot, even if its deadline has since passed.
    return this.toResponse(invitation, new Date(invitation.createdAt))
  }

  @Get()
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.READ_MEMBERS])
  async list(@AuthContext() authContext: OrganizationAuthContext, @Query() page: AdminPageQuery) {
    const organizationId = authContext.organizationId
    const invitations = await this.organizationInvitationService.findPage(
      organizationId,
      page.pageSize,
      page.after(organizationId, 'invites'),
    )
    return {
      invites: invitations.slice(0, page.pageSize).map((invitation) => this.toResponse(invitation)),
      ...adminNextPage(invitations, page.pageSize, organizationId, 'invites', (invitation) => invitation.id),
    }
  }

  @Delete(':invitationId')
  @HttpCode(204)
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_MEMBERS])
  @Audit({
    action: AuditAction.DELETE,
    targetType: AuditTarget.ORGANIZATION_INVITATION,
    targetIdFromRequest: (req) => req.params.invitationId,
  })
  async cancel(
    @AuthContext() authContext: OrganizationAuthContext,
    // Ids are UUIDs: any other string names no invitation, and Postgres rejects it as a bad cast.
    @Param('invitationId', new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND })) invitationId: string,
  ): Promise<void> {
    await this.organizationInvitationService.cancel(authContext.organizationId, invitationId)
  }

  private toResponse(invitation: OrganizationInvitation, at = new Date()): RestInvitation {
    return {
      type: 'invite',
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status:
        invitation.status === OrganizationInvitationStatus.PENDING && new Date(invitation.expiresAt) <= at
          ? 'expired'
          : invitation.status,
      added_at: new Date(invitation.createdAt).toISOString(),
      expires_at: new Date(invitation.expiresAt).toISOString(),
    }
  }
}
