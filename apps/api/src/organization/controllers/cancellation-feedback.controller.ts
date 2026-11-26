/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { BadRequestException, Body, Controller, ForbiddenException, HttpCode, Put, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { ApiExcludeController } from '@nestjs/swagger'
import { AuthContext } from '../../common/decorators/auth-context.decorator'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { OrganizationAuthContext } from '../../common/interfaces/auth-context.interface'
import { RequiredOrganizationMemberRole } from '../decorators/required-organization-member-role.decorator'
import { cancellationFeedbackInput } from '../dto/cancellation-feedback'
import { OrganizationMemberRole } from '../enums/organization-member-role.enum'
import { OrganizationActionGuard } from '../guards/organization-action.guard'
import { CancellationFeedbackService } from '../services/cancellation-feedback.service'
import { OrganizationUserService } from '../services/organization-user.service'

@ApiExcludeController()
@Controller('organizations/:organizationId/cancellation-feedback')
@UseGuards(AuthGuard('jwt'), AuthenticatedRateLimitGuard, OrganizationActionGuard)
@RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
export class CancellationFeedbackController {
  constructor(
    private readonly feedback: CancellationFeedbackService,
    private readonly memberships: OrganizationUserService,
  ) {}

  @Put()
  @HttpCode(204)
  async save(@AuthContext() actor: OrganizationAuthContext, @Body() body: unknown): Promise<void> {
    if (!actor.userId || actor.apiKey) throw new ForbiddenException('Organization owner required')
    const organizationId = actor.organization.id
    // Recheck current ownership: the shared guard caches membership and exempts administrators.
    const member = await this.memberships.findOne(organizationId, actor.userId)
    if (member?.role !== OrganizationMemberRole.OWNER) throw new ForbiddenException('Organization owner required')
    const input = cancellationFeedbackInput.safeParse(body)
    if (!input.success) throw new BadRequestException('Expected valid cancellation reasons, intent and optional note')
    await this.feedback.save(organizationId, actor.userId, input.data)
  }
}
