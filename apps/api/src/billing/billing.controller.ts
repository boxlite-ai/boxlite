/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, NotFoundException, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { CommerceServiceGuard } from '../auth/commerce-service.guard'
import { BillingService } from './billing.service'
import { BillingPeriodDto, BillingPeriodListDto, MarkBilledResultDto } from './dto/billing-period.dto'

/**
 * Internal, service-to-service surface for commerce-rs: it reads and writes
 * billing progress on this app's own usage-period tables over HTTP instead of
 * a second, direct database connection (see the boxlite-commerce PR review
 * this replaces). Every route here requires the commerce-service credential,
 * never an end-user OIDC token.
 */
@ApiTags('internal-billing')
@Controller('internal/billing')
@UseGuards(CombinedAuthGuard, CommerceServiceGuard)
@ApiBearerAuth()
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Get('unbilled-periods')
  @ApiOperation({ summary: 'List unbilled archived usage periods, oldest endAt first' })
  @ApiQuery({ name: 'limit', type: Number })
  @ApiResponse({ status: 200, type: BillingPeriodListDto })
  async listUnbilled(@Query('limit', ParseIntPipe) limit: number): Promise<BillingPeriodListDto> {
    return { periods: await this.billingService.listUnbilled(limit) }
  }

  @Get('periods/:periodId')
  @ApiOperation({ summary: 'Fetch one archived usage period by id' })
  @ApiParam({ name: 'periodId' })
  @ApiResponse({ status: 200, type: BillingPeriodDto })
  async fetchArchived(@Param('periodId') periodId: string): Promise<BillingPeriodDto> {
    const period = await this.billingService.fetchArchived(periodId)
    if (!period) {
      throw new NotFoundException('no archived period with this id')
    }
    return period
  }

  @Post('periods/:periodId/mark-billed')
  @ApiOperation({
    summary: 'Compare-and-swap the period from unbilled to billed',
    description: 'Returns marked=false if the period was already billed or does not exist -- never an error.',
  })
  @ApiParam({ name: 'periodId' })
  @ApiResponse({ status: 200, type: MarkBilledResultDto })
  async markBilled(@Param('periodId') periodId: string): Promise<MarkBilledResultDto> {
    return { marked: await this.billingService.markBilled(periodId) }
  }

  @Get('organizations/:organizationId/open-periods')
  @ApiOperation({ summary: 'List still-running (hot table) usage periods for an organization' })
  @ApiParam({ name: 'organizationId' })
  @ApiResponse({ status: 200, type: BillingPeriodListDto })
  async listOpenForOrganization(@Param('organizationId') organizationId: string): Promise<BillingPeriodListDto> {
    return { periods: await this.billingService.listOpenForOrganization(organizationId) }
  }
}
