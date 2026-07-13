/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException } from '@nestjs/common'
import { BillingAccessService } from './billing-access.service'

const now = new Date('2026-07-13T00:00:00.000Z')

function queryBuilder(rows: unknown[]) {
  const builder = {
    leftJoin: jest.fn(),
    select: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    getRawMany: jest.fn().mockResolvedValue(rows),
    getMany: jest.fn().mockResolvedValue(rows),
  }
  builder.leftJoin.mockReturnValue(builder)
  builder.select.mockReturnValue(builder)
  builder.where.mockReturnValue(builder)
  builder.andWhere.mockReturnValue(builder)
  builder.orderBy.mockReturnValue(builder)
  return builder
}

function makeService(
  overrides: {
    wallets?: any[]
    periods?: any[]
    archives?: any[]
    ratedPeriods?: any[]
    boxes?: any[]
    activeOrganizationIds?: string[]
    enabled?: boolean
  } = {},
) {
  const wallets = {
    findBy: jest.fn().mockResolvedValue(
      overrides.wallets ?? [
        {
          organizationId: 'org-1',
          freeBalanceCents: '1000',
          paidBalanceCents: '0',
          settlementRemainderCents: '0.5',
        },
      ],
    ),
  }
  const walletService = {
    getOrCreateWallet: jest.fn(async (organizationId: string) => ({
      organizationId,
      freeBalanceCents: '1000',
      paidBalanceCents: '0',
      settlementRemainderCents: '0',
    })),
  }
  const periods = {
    findBy: jest.fn().mockResolvedValue(
      overrides.periods ?? [
        {
          id: 'period-open',
          organizationId: 'org-1',
          boxId: 'box-1',
          startAt: new Date('2026-07-12T23:59:50.000Z'),
          endAt: null,
          cpu: 1,
          mem: 0,
          disk: 0,
          gpu: 0,
        },
      ],
    ),
  }
  const archives = {
    createQueryBuilder: jest.fn().mockReturnValue(
      queryBuilder(
        overrides.archives ?? [
          {
            id: 'archive-unrated',
            organizationId: 'org-1',
            boxId: 'box-2',
            startAt: new Date('2026-07-12T23:59:55.000Z'),
            endAt: now,
            cpu: 1,
            mem: 0,
            disk: 0,
            gpu: 0,
          },
        ],
      ),
    ),
  }
  const ratedPeriods = {
    createQueryBuilder: jest
      .fn()
      .mockReturnValue(queryBuilder(overrides.ratedPeriods ?? [{ organizationId: 'org-1', preciseCents: '3' }])),
  }
  const pricingPlans = {
    find: jest.fn().mockResolvedValue([
      {
        version: 1,
        cpuRateCentsPerSec: '1',
        memRateCentsPerSec: '0',
        diskRateCentsPerSec: '0',
        gpuRateCentsPerSec: '0',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: null,
      },
    ]),
  }
  const boxes = {
    findBy: jest
      .fn()
      .mockResolvedValue(
        overrides.boxes ?? [{ id: 'box-1', organizationId: 'org-1', cpu: 1, mem: 0, disk: 0, gpu: 0 }],
      ),
    createQueryBuilder: jest
      .fn()
      .mockReturnValue(
        queryBuilder((overrides.activeOrganizationIds ?? []).map((organizationId) => ({ organizationId }))),
      ),
  }
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'billing.enforcementEnabled') return overrides.enabled ?? true
      if (key === 'billing.enforcementRiskWindowSeconds') return 10
      return undefined
    }),
  }

  return {
    service: new BillingAccessService(
      wallets as never,
      walletService as never,
      periods as never,
      archives as never,
      ratedPeriods as never,
      pricingPlans as never,
      boxes as never,
      config as never,
    ),
    wallets,
    walletService,
    periods,
    archives,
    ratedPeriods,
    pricingPlans,
    boxes,
  }
}

describe('BillingAccessService', () => {
  it('calculates one organization from every unsettled pipeline stage without duplicating its open allocation', async () => {
    const { service } = makeService()

    const result = await service.evaluate('org-1', null, now)

    expect(result).toMatchObject({
      organizationId: 'org-1',
      activeBoxIds: ['box-1'],
      walletBalanceCents: '1000',
      unbilledUsageCents: '18.5',
      safetyBufferCents: '10',
      availableCents: '971.5',
      hasAccess: true,
    })
  })

  it('loads multiple organizations in batches and initializes only a missing wallet', async () => {
    const { service, wallets, walletService, periods, boxes } = makeService({
      wallets: [
        {
          organizationId: 'org-1',
          freeBalanceCents: '100',
          paidBalanceCents: '0',
          settlementRemainderCents: '0',
        },
      ],
      periods: [],
      archives: [],
      ratedPeriods: [],
      boxes: [],
    })

    const results = await service.evaluateMany(['org-1', 'org-2'], new Map(), now)

    expect(results).toHaveLength(2)
    expect(wallets.findBy).toHaveBeenCalledTimes(1)
    expect(periods.findBy).toHaveBeenCalledTimes(1)
    expect(boxes.findBy).toHaveBeenCalledTimes(1)
    expect(walletService.getOrCreateWallet).toHaveBeenCalledTimes(1)
    expect(walletService.getOrCreateWallet).toHaveBeenCalledWith('org-2')
  })

  it('throws HTTP 402 when enforcement is enabled and a requested allocation cannot be funded', async () => {
    const { service } = makeService({
      wallets: [
        {
          organizationId: 'org-1',
          freeBalanceCents: '1',
          paidBalanceCents: '0',
          settlementRemainderCents: '0',
        },
      ],
      periods: [],
      archives: [],
      ratedPeriods: [],
      boxes: [],
    })

    const error = await service
      .assertHasAccess('org-1', { boxId: 'candidate', cpu: 1, mem: 0, disk: 0, gpu: 0 }, now)
      .catch((caught) => caught)

    expect(error).toBeInstanceOf(HttpException)
    expect(error.getStatus()).toBe(402)
    expect(error.getResponse()).toMatchObject({ code: 'BILLING_BALANCE_REQUIRED' })
  })

  it('does not count an expired trial balance as available funds', async () => {
    const { service } = makeService({
      wallets: [
        {
          organizationId: 'org-1',
          freeBalanceCents: '1000',
          paidBalanceCents: '0',
          settlementRemainderCents: '0',
          freeExpiresAt: new Date('2026-07-12T23:59:59.000Z'),
        },
      ],
      periods: [],
      archives: [],
      ratedPeriods: [],
      boxes: [],
    })

    const result = await service.evaluate('org-1', null, now)

    expect(result.walletBalanceCents).toBe('0')
    expect(result.hasAccess).toBe(false)
  })

  it('does not gate requests while enforcement is disabled', async () => {
    const { service, wallets } = makeService({ enabled: false })

    await expect(
      service.assertHasAccess('org-1', { boxId: 'candidate', cpu: 100, mem: 0, disk: 0, gpu: 0 }, now),
    ).resolves.toBeNull()
    expect(wallets.findBy).not.toHaveBeenCalled()
  })

  it('lists each organization with a desired running Box once for the sweep', async () => {
    const { service } = makeService({ activeOrganizationIds: ['org-1', 'org-2'] })

    await expect(service.listActiveOrganizationIds()).resolves.toEqual(['org-1', 'org-2'])
  })
})
