/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BillingController } from './billing.controller'
import { Reflector } from '@nestjs/core'
import { RequiredOrganizationMemberRole } from '../organization/decorators/required-organization-member-role.decorator'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'

describe('BillingController', () => {
  it('passes a validated range to the organization overview', async () => {
    const billingReadService = {
      getOverview: jest.fn().mockResolvedValue({ wallet: {}, usage: {} }),
    }
    const controller = new BillingController(billingReadService as never)

    await controller.getOverview('org-1', '2026-07-10T10:00:00.000Z', '2026-07-10T11:00:00.000Z')

    expect(billingReadService.getOverview).toHaveBeenCalledWith(
      'org-1',
      new Date('2026-07-10T10:00:00.000Z'),
      new Date('2026-07-10T11:00:00.000Z'),
    )
  })

  it('exposes pricing and organization-scoped box usage', async () => {
    const billingReadService = {
      getPricing: jest.fn().mockResolvedValue({ version: 1 }),
      getBoxUsage: jest.fn().mockResolvedValue({ costPreciseCents: '2.778' }),
    }
    const controller = new BillingController(billingReadService as never)

    await expect(controller.getPricing()).resolves.toEqual({ version: 1 })
    await expect(controller.getBoxUsage('org-1', 'box-1')).resolves.toEqual({ costPreciseCents: '2.778' })
    expect(billingReadService.getBoxUsage).toHaveBeenCalledWith('org-1', 'box-1')
  })

  it('allows organization members to see rates while keeping balances and spend owner-only', () => {
    const reflector = new Reflector()

    expect(reflector.get(RequiredOrganizationMemberRole, BillingController.prototype.getPricing)).toBeUndefined()
    expect(reflector.get(RequiredOrganizationMemberRole, BillingController.prototype.getOverview)).toBe(
      OrganizationMemberRole.OWNER,
    )
    expect(reflector.get(RequiredOrganizationMemberRole, BillingController.prototype.getBoxUsage)).toBe(
      OrganizationMemberRole.OWNER,
    )
  })
})
