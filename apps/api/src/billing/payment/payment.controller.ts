/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOAuth2, ApiTags } from '@nestjs/swagger'
import type { Request } from 'express'
import { randomUUID } from 'node:crypto'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { RequiredOrganizationMemberRole } from '../../organization/decorators/required-organization-member-role.decorator'
import { OrganizationMemberRole } from '../../organization/enums/organization-member-role.enum'
import { OrganizationActionGuard } from '../../organization/guards/organization-action.guard'
import { AutoReloadInput, PaymentService } from './payment.service'

interface TopUpRequest {
  amountCents: string
}

@ApiTags('billing')
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
@Controller('organization/:organizationId/billing')
@UseGuards(CombinedAuthGuard, AuthenticatedRateLimitGuard, OrganizationActionGuard)
export class BillingPaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Get('payment')
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  getPaymentState(@Param('organizationId') organizationId: string) {
    return this.paymentService.getPaymentState(organizationId)
  }

  @Post('payment/setup')
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  setupPaymentMethod(@Param('organizationId') organizationId: string) {
    return this.paymentService.setupPaymentMethod(organizationId)
  }

  @Put('auto-reload')
  @HttpCode(200)
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  setAutoReload(@Param('organizationId') organizationId: string, @Body() input: AutoReloadInput): Promise<void> {
    return this.paymentService.setAutoReload(organizationId, input)
  }

  @Post('top-ups')
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  createTopUp(
    @Param('organizationId') organizationId: string,
    @Body() input: TopUpRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.paymentService.createManualTopUp(organizationId, input.amountCents, idempotencyKey ?? randomUUID())
  }

  @Get('receipts')
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  listReceipts(
    @Param('organizationId') organizationId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('query') query?: string,
  ) {
    return this.paymentService.listReceipts(organizationId, Number(page ?? 1), Number(pageSize ?? 8), query ?? '')
  }
}

@ApiTags('billing')
@Controller('billing/webhooks')
export class PaymentWebhookController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('payment')
  @HttpCode(200)
  async handle(
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature?: string,
  ): Promise<{ received: true }> {
    if (!request.rawBody) throw new BadRequestException('payment webhook raw body is required')
    if (!signature) throw new BadRequestException('payment webhook signature is required')
    await this.paymentService.handleWebhook(request.rawBody, signature)
    return { received: true }
  }
}
