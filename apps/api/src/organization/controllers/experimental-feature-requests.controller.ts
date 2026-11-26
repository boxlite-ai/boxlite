/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { ApiExcludeController } from '@nestjs/swagger'
import { z } from 'zod'
import { AuthContext } from '../../common/decorators/auth-context.decorator'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { OrganizationAuthContext } from '../../common/interfaces/auth-context.interface'
import { OrganizationAccessGuard } from '../guards/organization-access.guard'

const requestBody = z.strictObject({
  feature: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[^\r\n]+$/),
})

@ApiExcludeController()
@Controller('organizations/:organizationId/experimental-feature-requests')
@UseGuards(AuthGuard('jwt'), AuthenticatedRateLimitGuard, OrganizationAccessGuard)
export class ExperimentalFeatureRequestsController {
  private readonly logger = new Logger(ExperimentalFeatureRequestsController.name)

  @Post()
  @HttpCode(204)
  requestAccess(@AuthContext() actor: OrganizationAuthContext, @Body() body: unknown): void {
    const input = requestBody.safeParse(body)
    if (!input.success) throw new BadRequestException('Expected a single-line feature name of 1 to 80 characters')
    const email = actor.email?.trim()
    if (!email) throw new UnprocessableEntityException('Your account needs a contact email to request access')
    const organizationId = actor.organization.id
    const { feature } = input.data
    this.logger.warn(
      `${email} is requesting access to the experimental feature ${feature} for organization ${organizationId}.`,
      {
        'event.name': 'experimental_feature.requested',
        'organization.id': organizationId,
        'user.id': actor.userId,
        'user.email': email,
        'feature.name': feature,
        'event.timestamp': new Date().toISOString(),
      },
    )
  }
}
