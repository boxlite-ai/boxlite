/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { GUARDS_METADATA } from '@nestjs/common/constants'
import { Request } from 'express'
import { AUDIT_CONTEXT_KEY, AuditContext } from '../../audit/decorators/audit.decorator'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../audit/enums/audit-target.enum'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { SystemActionGuard } from '../../auth/system-action.guard'
import { RequiredApiRole } from '../../common/decorators/required-role.decorator'
import { SystemRole } from '../../user/enums/system-role.enum'
import { AdminBillingController } from './billing.controller'

describe('AdminBillingController', () => {
  const health = { collectHealth: jest.fn() }
  const payments = {
    scheduledPaymentRecovery: jest.fn(),
    reconcileTopUp: jest.fn(),
    reconcilePaymentSetup: jest.fn(),
  }
  const controller = new AdminBillingController(health as never, payments as never)

  beforeEach(() => jest.clearAllMocks())

  it('requires authenticated Admin API access', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminBillingController)).toEqual([CombinedAuthGuard, SystemActionGuard])
    expect(Reflect.getMetadata(RequiredApiRole.KEY, AdminBillingController)).toEqual([SystemRole.ADMIN])
  })

  it('audits targeted top-up reconciliation without exposing provider secrets', async () => {
    payments.reconcileTopUp.mockResolvedValue(true)
    await expect(controller.reconcileTopUp('top-up-1')).resolves.toEqual({ claimed: true })
    expect(payments.reconcileTopUp).toHaveBeenCalledWith('top-up-1', expect.any(Date), true)

    const context = Reflect.getMetadata(
      AUDIT_CONTEXT_KEY,
      AdminBillingController.prototype.reconcileTopUp,
    ) as AuditContext
    expect(context).toMatchObject({ action: AuditAction.UPDATE, targetType: AuditTarget.OBSERVABILITY })
    expect(context.targetIdFromRequest?.({ params: { topUpId: 'top-up-1' } } as unknown as Request)).toBe(
      'billing:top-up:top-up-1',
    )
  })
})
