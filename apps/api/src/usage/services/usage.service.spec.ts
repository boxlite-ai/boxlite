/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { EVENT_LISTENER_METADATA } from '@nestjs/event-emitter/dist/constants'
import { FindOperator } from 'typeorm'
import { BoxEvents } from '../../box/constants/box-events.constants'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../../box/constants/box.constants'
import { Box } from '../../box/entities/box.entity'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BoxState } from '../../box/enums/box-state.enum'
import { BoxDesiredStateUpdatedEvent } from '../../box/events/box-desired-state-updated.event'
import { BoxStateUpdatedEvent } from '../../box/events/box-state-updated.event'
import { BoxUsagePeriodArchive } from '../entities/box-usage-period-archive.entity'
import { BoxBillingTransition } from '../entities/box-billing-transition.entity'
import { BoxUsagePeriod } from '../entities/box-usage-period.entity'
import { UsageService } from './usage.service'

const box = {
  id: 'box-1',
  organizationId: 'org-1',
  region: 'us',
  cpu: 2,
  gpu: 1,
  mem: 4,
  disk: 10,
} as Box

const event = (newState: BoxState) => new BoxStateUpdatedEvent(box, BoxState.UNKNOWN, newState)

// Evaluates the operators the service actually queries with, so a changed
// predicate changes what the fake returns. Anything else throws rather than
// quietly matching — a silent default would let a query drift past these tests.
const satisfies = (actual: unknown, condition: unknown): boolean => {
  if (condition instanceof FindOperator) {
    switch (condition.type) {
      case 'isNull':
        return actual === null
      case 'not':
        return !satisfies(actual, condition.child ?? condition.value)
      default:
        throw new Error(`usage.service.spec: unsupported find operator "${condition.type}"`)
    }
  }
  return actual === condition
}

const makeService = (stored: BoxUsagePeriod[] = []) => {
  const transactionalEntityManager = {
    find: jest.fn(),
    findOne: jest.fn(async (entity: unknown, { where }: any) =>
      entity === BoxUsagePeriod
        ? (stored.find((period) =>
            Object.entries(where).every(([column, condition]) => satisfies((period as any)[column], condition)),
          ) ?? null)
        : null,
    ),
    query: jest.fn().mockResolvedValue([]),
    exists: jest.fn().mockResolvedValue(false),
    save: jest.fn().mockImplementation(async (...args) => args.at(-1)),
  }
  const usagePeriodRepository = {
    find: jest.fn().mockResolvedValue(stored),
    findOne: jest.fn(async ({ where }: any) =>
      stored.find((period) =>
        Object.entries(where).every(([column, condition]) => satisfies((period as any)[column], condition)),
      ),
    ),
    save: jest.fn().mockImplementation(async (period) => period),
    manager: {
      transaction: jest.fn().mockImplementation(async (callback) => callback(transactionalEntityManager)),
    },
  }
  const redisLockProvider = {
    lock: jest.fn().mockResolvedValue(true),
    unlock: jest.fn().mockResolvedValue(undefined),
  }
  const boxRepository = { findOne: jest.fn(), createQueryBuilder: jest.fn() }
  const runnerRepository = { find: jest.fn().mockResolvedValue([]) }
  const billingTransitionQueryBuilder: any = {}
  for (const method of ['select', 'addSelect', 'where', 'andWhere', 'groupBy', 'orderBy', 'limit']) {
    billingTransitionQueryBuilder[method] = jest.fn(() => billingTransitionQueryBuilder)
  }
  billingTransitionQueryBuilder.getRawMany = jest.fn().mockResolvedValue([])
  const billingTransitionRepository = {
    exists: jest.fn().mockResolvedValue(false),
    createQueryBuilder: jest.fn(() => billingTransitionQueryBuilder),
  }

  const service = new UsageService(
    usagePeriodRepository as any,
    redisLockProvider as any,
    boxRepository as any,
    runnerRepository as any,
    billingTransitionRepository as any,
  )

  return {
    service,
    usagePeriodRepository,
    redisLockProvider,
    boxRepository,
    runnerRepository,
    billingTransitionRepository,
    billingTransitionQueryBuilder,
    transactionalEntityManager,
  }
}

const openPeriod = () => ({ boxId: box.id, cpu: box.cpu, endAt: null }) as unknown as BoxUsagePeriod

// Every handler below is reached only through an @OnEvent subscription; calling
// them directly proves the body, not that anything ever calls it.
describe('UsageService event subscriptions', () => {
  it.each([
    ['handleBoxStateUpdate', BoxEvents.STATE_UPDATED],
    ['handleBoxDesiredStateUpdate', BoxEvents.DESIRED_STATE_UPDATED],
  ])('subscribes %s to %s', (handler, expectedEvent) => {
    const subscriptions = Reflect.getMetadata(EVENT_LISTENER_METADATA, (UsageService.prototype as any)[handler])

    expect(subscriptions).toEqual([expect.objectContaining({ event: expectedEvent })])
  })
})

describe('UsageService event handling', () => {
  it.each([
    ['state', (service: UsageService) => service.handleBoxStateUpdate(event(BoxState.STARTED))],
    [
      'desired state',
      (service: UsageService) =>
        service.handleBoxDesiredStateUpdate(
          new BoxDesiredStateUpdatedEvent(box, BoxDesiredState.STARTED, BoxDesiredState.DESTROYED),
        ),
    ],
  ])('uses the durable outbox as the only ledger writer for a %s event', async (_label, invoke) => {
    const { service, usagePeriodRepository, billingTransitionRepository, redisLockProvider } = makeService([
      openPeriod(),
    ])
    // Reconciliation won the race and marked this event's transition before
    // Nest delivered the in-process event listener.
    billingTransitionRepository.exists.mockResolvedValue(false)

    await invoke(service)

    expect(usagePeriodRepository.save).not.toHaveBeenCalled()
    expect(usagePeriodRepository.manager.transaction).not.toHaveBeenCalled()
    expect(redisLockProvider.unlock).toHaveBeenCalledWith(`usage-period-${box.id}`)
  })

  it('drains a pending transition while holding the event lock', async () => {
    const { service, billingTransitionRepository, transactionalEntityManager, redisLockProvider } = makeService()
    const transition = {
      id: '1',
      boxId: box.id,
      organizationId: box.organizationId,
      region: box.region,
      runnerId: null,
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STARTED,
      cpu: box.cpu,
      gpu: box.gpu,
      mem: box.mem,
      disk: box.disk,
      pending: false,
      occurredAt: new Date('2026-08-06T00:00:00.000Z'),
      processedAt: null,
    } as BoxBillingTransition
    billingTransitionRepository.exists.mockResolvedValue(true)
    transactionalEntityManager.find.mockResolvedValue([transition])
    transactionalEntityManager.findOne.mockResolvedValue(null)

    await service.handleBoxStateUpdate(event(BoxState.STARTED))

    expect(transactionalEntityManager.save).toHaveBeenCalledWith(
      expect.objectContaining({ boxId: box.id, startAt: transition.occurredAt }),
    )
    expect(transition.processedAt).toBeInstanceOf(Date)
    expect(redisLockProvider.unlock).toHaveBeenCalledWith(`usage-period-${box.id}`)
  })
})

describe('UsageService reconciliation', () => {
  const candidate = {
    box_id: box.id,
    box_state: BoxState.STARTED,
    box_cpu: box.cpu,
    box_gpu: box.gpu,
    box_mem: box.mem,
    box_disk: box.disk,
    box_org: box.organizationId,
    box_region: box.region,
    period_id: null,
  }

  it('opens the ledger for the transition box, never the outbox sequence id', async () => {
    const transition = {
      id: '42',
      boxId: box.id,
      organizationId: box.organizationId,
      region: box.region,
      runnerId: null,
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STARTED,
      cpu: box.cpu,
      gpu: box.gpu,
      mem: box.mem,
      disk: box.disk,
      pending: false,
      occurredAt: new Date('2026-08-06T00:05:00.000Z'),
      processedAt: null,
    } as BoxBillingTransition
    const { service, billingTransitionRepository, transactionalEntityManager } = makeService()
    billingTransitionRepository.exists.mockResolvedValue(true)
    transactionalEntityManager.find.mockResolvedValue([transition])
    transactionalEntityManager.findOne.mockResolvedValue(null)

    await (service as any).processPendingBillingTransitionsForBox(box.id)

    expect(transactionalEntityManager.save).toHaveBeenCalledWith(
      expect.objectContaining({ boxId: box.id, startAt: transition.occurredAt }),
    )
    expect(transactionalEntityManager.save).not.toHaveBeenCalledWith(expect.objectContaining({ boxId: transition.id }))
  })

  it('repairs a missing running-box period inside the per-box lock and transaction', async () => {
    const { service, boxRepository, redisLockProvider, usagePeriodRepository, transactionalEntityManager } =
      makeService()
    const startedAt = new Date('2026-08-06T00:00:00.000Z')
    transactionalEntityManager.query.mockResolvedValue([
      {
        ...box,
        state: BoxState.STARTED,
        desiredState: BoxDesiredState.STARTED,
        pending: false,
        billingChangedAt: startedAt,
      },
    ])

    await (service as any).repairDrift(candidate)

    expect(redisLockProvider.lock).toHaveBeenCalledWith(`usage-period-${box.id}`, 60)
    expect(boxRepository.findOne).not.toHaveBeenCalled()
    expect(usagePeriodRepository.manager.transaction).toHaveBeenCalledTimes(1)
    expect(transactionalEntityManager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        boxId: box.id,
        organizationId: box.organizationId,
        cpu: box.cpu,
        gpu: box.gpu,
        mem: box.mem,
        disk: box.disk,
        endAt: null,
        startAt: startedAt,
      }),
    )
    expect(redisLockProvider.unlock).toHaveBeenCalledWith(`usage-period-${box.id}`)
  })

  it('rechecks the durable outbox after locking the box and defers ledger repair when a transition appeared', async () => {
    const { service, transactionalEntityManager } = makeService()
    transactionalEntityManager.query.mockResolvedValue([
      {
        ...box,
        state: BoxState.STARTED,
        desiredState: BoxDesiredState.STARTED,
        pending: false,
        billingChangedAt: new Date('2026-08-06T00:00:00.000Z'),
      },
    ])
    transactionalEntityManager.exists.mockResolvedValue(true)
    const drainTransitions = jest
      .spyOn(service as any, 'processPendingBillingTransitionsForBox')
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)

    await (service as any).repairDrift(candidate)

    expect(transactionalEntityManager.query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), [box.id])
    expect(transactionalEntityManager.exists).toHaveBeenCalledWith(
      BoxBillingTransition,
      expect.objectContaining({ where: expect.objectContaining({ boxId: box.id }) }),
    )
    expect(transactionalEntityManager.findOne).not.toHaveBeenCalled()
    expect(transactionalEntityManager.save).not.toHaveBeenCalled()
    expect(drainTransitions).toHaveBeenCalledTimes(2)
  })

  it('closes a lost terminal transition at the durable box update time', async () => {
    const periodStartAt = new Date('2026-08-06T00:00:00.000Z')
    const destroyedAt = new Date('2026-08-06T00:05:00.000Z')
    const open = {
      ...box,
      boxId: box.id,
      startAt: periodStartAt,
      endAt: null,
    } as unknown as BoxUsagePeriod
    const { service, transactionalEntityManager } = makeService([open])
    transactionalEntityManager.query.mockResolvedValue([
      {
        ...box,
        state: BoxState.DESTROYED,
        desiredState: BoxDesiredState.DESTROYED,
        pending: false,
        billingChangedAt: destroyedAt,
      },
    ])

    await (service as any).repairDrift({ ...candidate, box_state: BoxState.DESTROYED, period_id: 'period-1' })

    expect(open.endAt).toEqual(destroyedAt)
    expect(transactionalEntityManager.save).toHaveBeenCalledWith(open)
  })

  it('cuts a stale resource shape over at the durable box update time', async () => {
    const periodStartAt = new Date('2026-08-06T00:00:00.000Z')
    const resizedAt = new Date('2026-08-06T00:05:00.000Z')
    const stale = {
      ...box,
      boxId: box.id,
      disk: 5,
      startAt: periodStartAt,
      endAt: null,
    } as unknown as BoxUsagePeriod
    const { service, transactionalEntityManager } = makeService([stale])
    transactionalEntityManager.query.mockResolvedValue([
      {
        ...box,
        state: BoxState.STARTED,
        desiredState: BoxDesiredState.STARTED,
        pending: false,
        billingChangedAt: resizedAt,
      },
    ])

    await (service as any).repairDrift({ ...candidate, period_id: 'period-1' })

    expect(stale.endAt).toEqual(resizedAt)
    expect(transactionalEntityManager.save).toHaveBeenNthCalledWith(1, stale)
    expect(transactionalEntityManager.save).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ startAt: resizedAt, endAt: null, disk: box.disk }),
    )
  })

  it('ignores an unrelated box update when choosing the billing cutover', async () => {
    const periodStartAt = new Date('2026-08-06T00:00:00.000Z')
    const billingChangedAt = new Date('2026-08-06T00:05:00.000Z')
    const unrelatedUpdatedAt = new Date('2026-08-06T00:10:00.000Z')
    const stale = {
      ...box,
      boxId: box.id,
      disk: 5,
      startAt: periodStartAt,
      endAt: null,
    } as unknown as BoxUsagePeriod
    const { service, transactionalEntityManager } = makeService([stale])
    transactionalEntityManager.query.mockResolvedValue([
      {
        ...box,
        state: BoxState.STARTED,
        desiredState: BoxDesiredState.STARTED,
        pending: false,
        billingChangedAt,
        updatedAt: unrelatedUpdatedAt,
      },
    ])

    await (service as any).repairDrift({ ...candidate, period_id: 'period-1' })

    expect(stale.endAt).toEqual(billingChangedAt)
    expect(transactionalEntityManager.save).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ startAt: billingChangedAt, endAt: null, disk: box.disk }),
    )
  })

  it('uses observation time for an explicit null boundary without consulting updatedAt', async () => {
    const observedAt = new Date('2026-08-06T00:15:00.000Z')
    const unrelatedUpdatedAt = new Date('2026-08-06T00:10:00.000Z')
    jest.useFakeTimers().setSystemTime(observedAt)

    try {
      const { service, transactionalEntityManager } = makeService()
      transactionalEntityManager.query.mockResolvedValue([
        {
          ...box,
          state: BoxState.STARTED,
          desiredState: BoxDesiredState.STARTED,
          pending: false,
          billingChangedAt: null,
          updatedAt: unrelatedUpdatedAt,
        },
      ])

      await (service as any).repairDrift(candidate)

      expect(transactionalEntityManager.save).toHaveBeenCalledWith(
        expect.objectContaining({ startAt: observedAt, endAt: null }),
      )
      expect(transactionalEntityManager.save).not.toHaveBeenCalledWith(
        expect.objectContaining({ startAt: unrelatedUpdatedAt }),
      )
    } finally {
      jest.useRealTimers()
    }
  })

  it('never closes an open period before its start when the box timestamp is older', async () => {
    const boxUpdatedAt = new Date('2026-08-06T00:00:00.000Z')
    const periodStartAt = new Date('2026-08-06T00:05:00.000Z')
    const open = {
      ...box,
      boxId: box.id,
      startAt: periodStartAt,
      endAt: null,
    } as unknown as BoxUsagePeriod
    const { service, transactionalEntityManager } = makeService([open])
    transactionalEntityManager.query.mockResolvedValue([
      {
        ...box,
        state: BoxState.DESTROYED,
        desiredState: BoxDesiredState.DESTROYED,
        pending: false,
        billingChangedAt: boxUpdatedAt,
      },
    ])

    await (service as any).repairDrift({ ...candidate, box_state: BoxState.DESTROYED, period_id: 'period-1' })

    expect(open.endAt).toEqual(periodStartAt)
  })

  it('never starts a repaired period after the time reconciliation observed it', async () => {
    const observedAt = new Date('2026-08-06T00:05:00.000Z')
    const futureBoxUpdate = new Date('2026-08-06T00:10:00.000Z')
    jest.useFakeTimers().setSystemTime(observedAt)

    try {
      const { service, transactionalEntityManager } = makeService()
      transactionalEntityManager.query.mockResolvedValue([
        {
          ...box,
          state: BoxState.STARTED,
          desiredState: BoxDesiredState.STARTED,
          pending: false,
          billingChangedAt: futureBoxUpdate,
        },
      ])

      await (service as any).repairDrift(candidate)

      expect(transactionalEntityManager.save).toHaveBeenCalledWith(
        expect.objectContaining({ startAt: observedAt, endAt: null }),
      )
    } finally {
      jest.useRealTimers()
    }
  })

  it('does not create or rewrite a period for an unassigned warm-pool box', async () => {
    const { service, usagePeriodRepository, transactionalEntityManager } = makeService()
    transactionalEntityManager.query.mockResolvedValue([
      {
        ...box,
        organizationId: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
        state: BoxState.STARTED,
        desiredState: BoxDesiredState.STARTED,
        pending: false,
      },
    ])

    await (service as any).repairDrift(candidate)

    expect(usagePeriodRepository.manager.transaction).toHaveBeenCalledTimes(1)
    expect(transactionalEntityManager.save).not.toHaveBeenCalled()
  })

  it('releases the global reconcile lock when a shard scan fails', async () => {
    const { service, runnerRepository, redisLockProvider } = makeService()
    runnerRepository.find.mockResolvedValue([{ id: 'runner-1' }])
    jest.spyOn(service as any, 'findDriftCandidates').mockRejectedValue(new Error('scan failed'))

    await expect(service.reconcileUsagePeriods()).rejects.toThrow('scan failed')

    expect(redisLockProvider.lock).toHaveBeenCalledWith('reconcile-usage-periods', 300)
    expect(redisLockProvider.unlock).toHaveBeenCalledWith('reconcile-usage-periods')
  })
})

describe('UsageService archive isolation', () => {
  const closed = (id: string, startAt: Date, overrides: Partial<BoxUsagePeriod> = {}) =>
    ({
      id,
      boxId: box.id,
      organizationId: box.organizationId,
      region: box.region,
      cpu: box.cpu,
      gpu: box.gpu,
      mem: box.mem,
      disk: box.disk,
      startAt,
      endAt: new Date(startAt.getTime() + 1_000),
      ...overrides,
    }) as BoxUsagePeriod

  it('continues with later candidates and releases the lock when one row fails', async () => {
    const poison = closed('period-poison', new Date('2026-08-06T00:00:00.000Z'))
    const later = closed('period-later', new Date('2026-08-06T00:01:00.000Z'))
    const { service, usagePeriodRepository, redisLockProvider } = makeService()
    usagePeriodRepository.find = jest.fn().mockResolvedValue([poison, later])
    const archiveOne = jest
      .spyOn(service as any, 'archiveUsagePeriod')
      .mockRejectedValueOnce(new Error('divergent snapshot'))
      .mockResolvedValueOnce(undefined)
    jest.spyOn(service as any, 'isIsolatableArchiveError').mockReturnValue(true)

    await expect(service.archiveUsagePeriods()).rejects.toThrow(/period-poison/)

    expect(archiveOne).toHaveBeenNthCalledWith(1, poison.id)
    expect(archiveOne).toHaveBeenNthCalledWith(2, later.id)
    expect(redisLockProvider.unlock).toHaveBeenCalledWith('archive-usage-periods')
  })

  it('aborts the batch on infrastructure errors instead of hammering every candidate', async () => {
    const first = closed('period-1', new Date('2026-08-06T00:00:00.000Z'))
    const later = closed('period-2', new Date('2026-08-06T00:01:00.000Z'))
    const { service, usagePeriodRepository, redisLockProvider } = makeService()
    usagePeriodRepository.find = jest.fn().mockResolvedValue([first, later])
    const archiveOne = jest.spyOn(service as any, 'archiveUsagePeriod').mockRejectedValue(new Error('connection lost'))

    await expect(service.archiveUsagePeriods()).rejects.toThrow('connection lost')

    expect(archiveOne).toHaveBeenCalledTimes(1)
    expect(redisLockProvider.unlock).toHaveBeenCalledWith('archive-usage-periods')
  })

  it('does not delete a source whose UUID points at a divergent archived snapshot', async () => {
    const source = closed('period-1', new Date('2026-08-06T00:00:00.000Z'))
    const divergent = BoxUsagePeriodArchive.fromUsagePeriod(source)
    divergent.id = 'archive-1'
    divergent.cpu += 1
    const { service, usagePeriodRepository } = makeService()
    const builder: any = {}
    builder.insert = jest.fn(() => builder)
    builder.into = jest.fn(() => builder)
    builder.values = jest.fn(() => builder)
    builder.orIgnore = jest.fn(() => builder)
    builder.execute = jest.fn().mockResolvedValue({ identifiers: [] })
    const manager = {
      findOne: jest.fn(async (entity: unknown) => (entity === BoxUsagePeriod ? source : divergent)),
      createQueryBuilder: jest.fn(() => builder),
      delete: jest.fn(),
    }
    usagePeriodRepository.manager.transaction.mockImplementation(async (callback: any) => callback(manager))

    await expect((service as any).archiveUsagePeriod(source.id)).rejects.toThrow(/different archived snapshot/)

    expect(manager.delete).not.toHaveBeenCalled()
  })

  it('deletes the source only after an exact existing archive has been confirmed', async () => {
    const source = closed('period-1', new Date('2026-08-06T00:00:00.000Z'))
    const archived = BoxUsagePeriodArchive.fromUsagePeriod(source)
    archived.id = 'archive-1'
    const { service, usagePeriodRepository } = makeService()
    const builder: any = {}
    builder.insert = jest.fn(() => builder)
    builder.into = jest.fn(() => builder)
    builder.values = jest.fn(() => builder)
    builder.orIgnore = jest.fn(() => builder)
    builder.execute = jest.fn().mockResolvedValue({ identifiers: [] })
    const manager = {
      findOne: jest.fn(async (entity: unknown) => (entity === BoxUsagePeriod ? source : archived)),
      createQueryBuilder: jest.fn(() => builder),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    }
    usagePeriodRepository.manager.transaction.mockImplementation(async (callback: any) => callback(manager))

    await expect((service as any).archiveUsagePeriod(source.id)).resolves.toBeUndefined()

    expect(manager.findOne).toHaveBeenNthCalledWith(
      2,
      BoxUsagePeriodArchive,
      expect.objectContaining({ where: { sourceUsagePeriodId: source.id } }),
    )
    expect(manager.delete).toHaveBeenCalledWith(BoxUsagePeriod, source.id)
  })
})
