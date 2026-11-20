/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { BadRequestException, Body, Controller, ForbiddenException, HttpCode, Post, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { ApiExcludeController } from '@nestjs/swagger'
import { z } from 'zod'
import { AuthContext } from '../../common/decorators/auth-context.decorator'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { OrganizationAuthContext } from '../../common/interfaces/auth-context.interface'
import { UserService } from '../../user/user.service'
import { RequiredOrganizationMemberRole } from '../decorators/required-organization-member-role.decorator'
import { OrganizationMemberRole } from '../enums/organization-member-role.enum'
import { OrganizationActionGuard } from '../guards/organization-action.guard'
import { CouponClaimsService } from '../services/coupon-claims.service'
import { OrganizationUserService } from '../services/organization-user.service'

const claimBody = z.strictObject({
  eventId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  couponCode: z
    .string()
    .trim()
    .refine((code) => /^[A-Z0-9_-]{1,64}$/.test(code.toUpperCase())),
})

@ApiExcludeController()
@Controller('organizations/:organizationId/coupon-claims')
@UseGuards(AuthGuard('jwt'), AuthenticatedRateLimitGuard, OrganizationActionGuard)
@RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
export class CouponClaimsController {
  constructor(
    private readonly claims: CouponClaimsService,
    private readonly users: UserService,
    private readonly memberships: OrganizationUserService,
  ) {}

  @Post()
  @HttpCode(202)
  async claim(@AuthContext() actor: OrganizationAuthContext, @Body() body: unknown) {
    const organizationId = actor.organization.id
    // The guard caches memberships. Billing actions require current ownership.
    const membership = await this.memberships.findOne(organizationId, actor.userId)
    if (membership?.role !== OrganizationMemberRole.OWNER) throw new ForbiddenException('Organization owner required')
    const user = await this.users.findOne(actor.userId)
    if (!user?.emailVerified) {
      throw new ForbiddenException({ code: 'email_verification_required', message: 'Please verify your email address' })
    }

    const input = claimBody.safeParse(body)
    if (!input.success) throw new BadRequestException('Expected a valid eventId and couponCode')
    return this.claims.submit(organizationId, input.data.eventId, input.data.couponCode)
  }
}
