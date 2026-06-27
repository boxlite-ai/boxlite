/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common'
import { ApiOAuth2, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { AuthContext as IAuthContext } from '../common/interfaces/auth-context.interface'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { TopUpCheckoutDto, TopUpRequestDto, WalletResponseDto } from './dto/wallet.dto'
import { TopUpService } from './payment/top-up.service'
import { PricingService } from './rating/pricing.service'
import { WalletService } from './wallet/wallet.service'

/**
 * Org-scoped wallet API. The org comes from the authenticated context (not a
 * path param), matching the rest of the API. Read + top-up only: granting free
 * credit is an admin operation and is intentionally NOT exposed here (a member
 * must never be able to credit their own wallet).
 */
@ApiTags('billing')
@Controller('billing')
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard, AuthenticatedRateLimitGuard)
@ApiOAuth2(['openid', 'profile', 'email'])
export class BillingController {
  constructor(
    private readonly wallet: WalletService,
    private readonly pricing: PricingService,
    private readonly topUp: TopUpService,
  ) {}

  @Get('wallet')
  @ApiOperation({ summary: "Get the organization's wallet balance + billing status", operationId: 'getWallet' })
  @ApiResponse({ status: 200, type: WalletResponseDto })
  async getWallet(@AuthContext() ctx: IAuthContext): Promise<WalletResponseDto> {
    const warnThresholdCents = await this.pricing.warnThresholdCents()
    const view = await this.wallet.getView(ctx.organizationId!, warnThresholdCents)
    // TODO: surface the org display name (OrganizationService) instead of the id.
    return WalletResponseDto.fromView(view, ctx.organizationId!)
  }

  @Post('wallet/top-up')
  @ApiOperation({ summary: 'Start a manual wallet top-up (returns a checkout URL)', operationId: 'topUpWallet' })
  @ApiResponse({ status: 201, type: TopUpCheckoutDto })
  async startTopUp(@AuthContext() ctx: IAuthContext, @Body() body: TopUpRequestDto): Promise<TopUpCheckoutDto> {
    return this.topUp.createCheckout(ctx.organizationId!, body.amountCents)
  }
}
