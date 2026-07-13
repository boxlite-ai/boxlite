/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BillingEnforcementService } from './billing-enforcement.service'

function evaluation(organizationId: string, hasAccess: boolean, activeBoxIds: string[]) {
  return {
    organizationId,
    activeBoxIds,
    walletBalanceCents: '100',
    unbilledUsageCents: hasAccess ? '10' : '100',
    safetyBufferCents: '10',
    availableCents: hasAccess ? '80' : '-10',
    hasAccess,
  }
}

function makeService(options: { leader?: boolean; recheckHasAccess?: boolean } = {}) {
  const access = {
    isEnabled: jest.fn().mockReturnValue(true),
    listActiveOrganizationIds: jest.fn().mockResolvedValue(['org-1', 'org-2']),
    evaluateMany: jest
      .fn()
      .mockResolvedValue([evaluation('org-1', true, ['box-1']), evaluation('org-2', false, ['box-2', 'box-3'])]),
    evaluate: jest.fn().mockResolvedValue(evaluation('org-2', options.recheckHasAccess ?? false, ['box-2', 'box-3'])),
  }
  const boxService = {
    stop: jest.fn().mockResolvedValue(undefined),
  }
  const locks = {
    lock: jest.fn(async (key: string) => (key === 'billing-access:sweep' ? (options.leader ?? true) : true)),
    unlock: jest.fn().mockResolvedValue(undefined),
  }

  return {
    service: new BillingEnforcementService(access as never, boxService as never, locks as never),
    access,
    boxService,
    locks,
  }
}

describe('BillingEnforcementService', () => {
  it('batch-evaluates active organizations and stops only a still-blocked organization after a locked recheck', async () => {
    const { service, access, boxService, locks } = makeService()

    await service.sweep()

    expect(access.evaluateMany).toHaveBeenCalledWith(['org-1', 'org-2'])
    expect(access.evaluate).toHaveBeenCalledWith('org-2')
    expect(boxService.stop).toHaveBeenCalledTimes(2)
    expect(boxService.stop).toHaveBeenCalledWith('box-2', 'org-2')
    expect(boxService.stop).toHaveBeenCalledWith('box-3', 'org-2')
    expect(locks.unlock).toHaveBeenCalledWith('billing-access:sweep', expect.anything())
  })

  it('does not stop after a concurrent top-up restores access before the locked recheck', async () => {
    const { service, boxService } = makeService({ recheckHasAccess: true })

    await service.sweep()

    expect(boxService.stop).not.toHaveBeenCalled()
  })

  it('does no work when another API instance owns the sweep lock', async () => {
    const { service, access } = makeService({ leader: false })

    await service.sweep()

    expect(access.listActiveOrganizationIds).not.toHaveBeenCalled()
    expect(access.evaluateMany).not.toHaveBeenCalled()
  })

  it('continues stopping sibling Boxes when one stop fails', async () => {
    const { service, boxService } = makeService()
    boxService.stop.mockRejectedValueOnce(new Error('runner unavailable')).mockResolvedValueOnce(undefined)

    await service.sweep()

    expect(boxService.stop).toHaveBeenCalledTimes(2)
  })

  it('rechecks one organization immediately after a committed wallet debit', async () => {
    const { service } = makeService()
    const enforce = jest.spyOn(service, 'enforceOrganization').mockResolvedValue(undefined)

    await service.handleWalletBalanceChanged({ organizationId: 'org-1' })

    expect(enforce).toHaveBeenCalledWith('org-1')
  })
})
