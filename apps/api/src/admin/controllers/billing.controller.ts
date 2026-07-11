/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOAuth2, ApiOperation, ApiTags } from '@nestjs/swagger'
import { Audit } from '../../audit/decorators/audit.decorator'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../audit/enums/audit-target.enum'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { SystemActionGuard } from '../../auth/system-action.guard'
import { BillingOpsService } from '../../billing/billing-ops.service'
import { PaymentService } from '../../billing/payment/payment.service'
import { RequiredApiRole } from '../../common/decorators/required-role.decorator'
import { SystemRole } from '../../user/enums/system-role.enum'

@ApiTags('admin')
@Controller('admin/billing')
@UseGuards(CombinedAuthGuard, SystemActionGuard)
@RequiredApiRole([SystemRole.ADMIN])
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
export class AdminBillingController {
  constructor(
    private readonly billingOps: BillingOpsService,
    private readonly payments: PaymentService,
  ) {}

  @Get('health')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get Billing recovery and ledger health', operationId: 'adminGetBillingHealth' })
  @Audit({
    action: AuditAction.READ,
    targetType: AuditTarget.OBSERVABILITY,
    targetIdFromRequest: () => 'billing:health',
  })
  health() {
    return this.billingOps.collectHealth()
  }

  @Post('reconcile')
  @HttpCode(200)
  @ApiOperation({ summary: 'Run due Billing recovery work', operationId: 'adminReconcileBilling' })
  @Audit({
    action: AuditAction.UPDATE,
    targetType: AuditTarget.OBSERVABILITY,
    targetIdFromRequest: () => 'billing:reconcile',
  })
  async reconcile() {
    await this.payments.scheduledPaymentRecovery()
    return this.billingOps.collectHealth()
  }

  @Post('reconcile/top-up/:topUpId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Force provider reconciliation for one top-up', operationId: 'adminReconcileTopUp' })
  @Audit({
    action: AuditAction.UPDATE,
    targetType: AuditTarget.OBSERVABILITY,
    targetIdFromRequest: (request) => `billing:top-up:${request.params.topUpId}`,
  })
  async reconcileTopUp(@Param('topUpId', ParseUUIDPipe) topUpId: string) {
    return { claimed: await this.payments.reconcileTopUp(topUpId, new Date(), true) }
  }

  @Post('reconcile/setup/:organizationId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Force provider reconciliation for one payment setup', operationId: 'adminReconcileSetup' })
  @Audit({
    action: AuditAction.UPDATE,
    targetType: AuditTarget.OBSERVABILITY,
    targetIdFromRequest: (request) => `billing:setup:${request.params.organizationId}`,
  })
  async reconcileSetup(@Param('organizationId', ParseUUIDPipe) organizationId: string) {
    return { claimed: await this.payments.reconcilePaymentSetup(organizationId, new Date(), true) }
  }
}
