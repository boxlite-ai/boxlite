/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { IsNull } from 'typeorm'
import { BillingService } from './billing.service'

const archivedPeriod = {
  id: 'period-1',
  boxId: 'box-1',
  organizationId: 'org-1',
  region: 'us',
  startAt: new Date('2026-01-01T00:00:00Z'),
  endAt: new Date('2026-01-01T01:00:00Z'),
  cpu: 1,
  gpu: 0,
  mem: 2,
  disk: 10,
}

const openPeriod = {
  id: 'period-2',
  boxId: 'box-2',
  organizationId: 'org-1',
  region: 'us',
  startAt: new Date('2026-01-01T02:00:00Z'),
  endAt: null,
  cpu: 1,
  gpu: 0,
  mem: 2,
  disk: 10,
}

function makeService(affected = 1) {
  const queryBuilder = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected }),
  }
  const archiveRepository = {
    find: jest.fn().mockResolvedValue([archivedPeriod]),
    findOne: jest.fn().mockResolvedValue(archivedPeriod),
    createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
  }
  const openPeriodRepository = {
    find: jest.fn().mockResolvedValue([openPeriod]),
  }

  return {
    service: new BillingService(archiveRepository as any, openPeriodRepository as any),
    archiveRepository,
    openPeriodRepository,
    queryBuilder,
  }
}

describe('BillingService', () => {
  it('lists unbilled periods oldest endAt first and maps them to the wire DTO', async () => {
    const { service, archiveRepository } = makeService()

    const result = await service.listUnbilled(5)

    expect(archiveRepository.find).toHaveBeenCalledWith({
      where: { billingStatus: 'unbilled' },
      order: { endAt: 'ASC' },
      take: 5,
    })
    expect(result).toEqual([
      {
        periodId: 'period-1',
        boxId: 'box-1',
        organizationId: 'org-1',
        region: 'us',
        startAt: archivedPeriod.startAt.toISOString(),
        endAt: archivedPeriod.endAt.toISOString(),
        cpu: 1,
        gpu: 0,
        mem: 2,
        disk: 10,
      },
    ])
  })

  it('reports the transition succeeded when the compare-and-swap update affects a row', async () => {
    const { service, queryBuilder } = makeService(1)

    await expect(service.markBilled('period-1')).resolves.toBe(true)

    expect(queryBuilder.where).toHaveBeenCalledWith('id = :periodId', { periodId: 'period-1' })
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('billing_status = :unbilled', { unbilled: 'unbilled' })
  })

  it('reports no transition when the period was already billed (zero rows affected)', async () => {
    const { service } = makeService(0)

    await expect(service.markBilled('period-1')).resolves.toBe(false)
  })

  it('reports no transition when the update result omits affected entirely', async () => {
    const { service, queryBuilder } = makeService()
    queryBuilder.execute.mockResolvedValue({})

    await expect(service.markBilled('period-1')).resolves.toBe(false)
  })

  it('returns null rather than throwing when no archived period matches the id', async () => {
    const { service, archiveRepository } = makeService()
    archiveRepository.findOne.mockResolvedValue(null)

    await expect(service.fetchArchived('missing')).resolves.toBeNull()
  })

  it('lists only still-open periods for the organization', async () => {
    const { service, openPeriodRepository } = makeService()

    const result = await service.listOpenForOrganization('org-1')

    expect(openPeriodRepository.find).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', endAt: IsNull() },
    })
    expect(result).toEqual([
      {
        periodId: 'period-2',
        boxId: 'box-2',
        organizationId: 'org-1',
        region: 'us',
        startAt: openPeriod.startAt.toISOString(),
        endAt: null,
        cpu: 1,
        gpu: 0,
        mem: 2,
        disk: 10,
      },
    ])
  })
})
