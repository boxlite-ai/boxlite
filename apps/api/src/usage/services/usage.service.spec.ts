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
    save: jest.fn().mockImplementation(async (period) => period),
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

  const service = new UsageService(
    usagePeriodRepository as any,
    redisLockProvider as any,
    boxRepository as any,
    runnerRepository as any,
  )

  return {
    service,
    usagePeriodRepository,
    redisLockProvider,
    boxRepository,
    runnerRepository,
    transactionalEntityManager,
  }
}

const OTHER_BOX_ID = 'box-2'

const openPeriod = (cpu = box.cpu, boxId = box.id) => ({ boxId, cpu, endAt: null }) as unknown as BoxUsagePeriod
const closedPeriod = (cpu = box.cpu, boxId = box.id) => ({ boxId, cpu, endAt: new Date() }) as unknown as BoxUsagePeriod

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

describe('UsageService.handleBoxStateUpdate', () => {
  it('opens a full-resource period when the box starts', async () => {
    const { service, usagePeriodRepository } = makeService()

    await service.handleBoxStateUpdate(event(BoxState.STARTED))

    expect(usagePeriodRepository.save).toHaveBeenCalledTimes(1)
    expect(usagePeriodRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        boxId: 'box-1',
        organizationId: 'org-1',
        region: 'us',
        cpu: 2,
        gpu: 1,
        mem: 4,
        disk: 10,
        endAt: null,
      }),
    )
    // billing starts now, not at some inherited timestamp
    const [[opened]] = usagePeriodRepository.save.mock.calls
    expect(opened.startAt).toBeInstanceOf(Date)
    expect(Date.now() - opened.startAt.getTime()).toBeLessThan(5_000)
  })

  it('closes the previous period before opening a new one when the box starts', async () => {
    const stale = openPeriod()
    const { service, usagePeriodRepository } = makeService([stale])

    await service.handleBoxStateUpdate(event(BoxState.STARTED))

    const [closed, opened] = usagePeriodRepository.save.mock.calls.map(([period]) => period)
    expect(closed).toBe(stale)
    expect(stale.endAt).toBeInstanceOf(Date)
    expect(opened).toEqual(expect.objectContaining({ cpu: 2, endAt: null }))
  })

  it('never closes a period belonging to a different box', async () => {
    const otherBoxPeriod = openPeriod(box.cpu, OTHER_BOX_ID)
    const { service, usagePeriodRepository } = makeService([otherBoxPeriod])

    await service.handleBoxStateUpdate(event(BoxState.STARTED))

    // only the newly opened period is written; the other box keeps accruing
    expect(usagePeriodRepository.save).toHaveBeenCalledTimes(1)
    expect(otherBoxPeriod.endAt).toBeNull()
  })

  it('ignores a still-billing period owned by another box when this box lands in STOPPED', async () => {
    const otherBoxPeriod = openPeriod(box.cpu, OTHER_BOX_ID)
    const { service, usagePeriodRepository } = makeService([otherBoxPeriod])

    await service.handleBoxStateUpdate(event(BoxState.STOPPED))

    expect(usagePeriodRepository.save).not.toHaveBeenCalled()
    expect(otherBoxPeriod.endAt).toBeNull()
  })

  it('does not re-close an already closed period when the box is destroyed', async () => {
    const alreadyClosed = closedPeriod()
    const closedAt = alreadyClosed.endAt
    const { service, usagePeriodRepository } = makeService([alreadyClosed])

    await service.handleBoxStateUpdate(event(BoxState.DESTROYED))

    expect(usagePeriodRepository.save).not.toHaveBeenCalled()
    expect(alreadyClosed.endAt).toBe(closedAt)
  })

  it('closes the open period and reopens it disk-only when the box stops', async () => {
    const open = openPeriod()
    const { service, usagePeriodRepository } = makeService([open])

    await service.handleBoxStateUpdate(event(BoxState.STOPPING))

    const [closed, reopened] = usagePeriodRepository.save.mock.calls.map(([period]) => period)
    expect(closed).toBe(open)
    expect(closed.endAt).toBeInstanceOf(Date)
    // a stopped box keeps paying for disk, but not for cpu/gpu/mem
    expect(reopened).toEqual(expect.objectContaining({ cpu: 0, gpu: 0, mem: 0, disk: 10, endAt: null }))
  })

  it('closes the open period without reopening when the box is destroyed', async () => {
    const open = openPeriod()
    const { service, usagePeriodRepository } = makeService([open])

    await service.handleBoxStateUpdate(event(BoxState.DESTROYED))

    expect(usagePeriodRepository.save).toHaveBeenCalledTimes(1)
    expect(usagePeriodRepository.save).toHaveBeenCalledWith(open)
    expect(open.endAt).toBeInstanceOf(Date)
  })

  it('closes a still-billing period when the box lands in STOPPED without passing through STOPPING', async () => {
    const open = openPeriod()
    const { service, usagePeriodRepository } = makeService([open])

    await service.handleBoxStateUpdate(event(BoxState.STOPPED))

    const [closed, reopened] = usagePeriodRepository.save.mock.calls.map(([period]) => period)
    expect(closed).toBe(open)
    expect(closed.endAt).toBeInstanceOf(Date)
    expect(reopened).toEqual(expect.objectContaining({ cpu: 0, gpu: 0, mem: 0, disk: 10, endAt: null }))
  })

  it('leaves an already disk-only period alone when the box lands in STOPPED', async () => {
    // the box passed through STOPPING normally, so its open period already
    // charges no compute — reopening it would only add a spurious row
    const { service, usagePeriodRepository } = makeService([openPeriod(0)])

    await service.handleBoxStateUpdate(event(BoxState.STOPPED))

    expect(usagePeriodRepository.save).not.toHaveBeenCalled()
  })

  it('ignores a compute period that is already closed when the box lands in STOPPED', async () => {
    // only open periods are still accruing; a closed one must not be reopened
    const { service, usagePeriodRepository } = makeService([closedPeriod()])

    await service.handleBoxStateUpdate(event(BoxState.STOPPED))

    expect(usagePeriodRepository.save).not.toHaveBeenCalled()
  })

  it('closes the period when the box is destroyed but has not reached DESTROYED yet', async () => {
    const open = openPeriod()
    const { service, usagePeriodRepository } = makeService([open])

    await service.handleBoxStateUpdate(event(BoxState.DESTROYING))

    expect(usagePeriodRepository.save).toHaveBeenCalledTimes(1)
    expect(open.endAt).toBeInstanceOf(Date)
  })

  it.each([
    ['ERROR', BoxState.ERROR],
    ['ARCHIVED', BoxState.ARCHIVED],
    ['DESTROYED', BoxState.DESTROYED],
    ['DESTROYING', BoxState.DESTROYING],
  ])('stops billing when the box reaches %s', async (_label, state) => {
    const open = openPeriod()
    const { service, usagePeriodRepository } = makeService([open])

    await service.handleBoxStateUpdate(event(state))

    expect(usagePeriodRepository.save).toHaveBeenCalledTimes(1)
    expect(open.endAt).toBeInstanceOf(Date)
  })

  it('releases the per-box lock even when the transition is not billable', async () => {
    const { service, redisLockProvider } = makeService()

    await service.handleBoxStateUpdate(event(BoxState.STARTING))

    expect(redisLockProvider.unlock).toHaveBeenCalledWith(`usage-period-${box.id}`)
  })
})

describe('UsageService.handleBoxDesiredStateUpdate', () => {
  it('stops billing as soon as deletion is requested', async () => {
    const open = openPeriod()
    const { service, usagePeriodRepository } = makeService([open])

    await service.handleBoxDesiredStateUpdate(
      new BoxDesiredStateUpdatedEvent(box, BoxDesiredState.STARTED, BoxDesiredState.DESTROYED),
    )

    expect(usagePeriodRepository.save).toHaveBeenCalledWith(open)
    expect(open.endAt).toBeInstanceOf(Date)
  })

  it('keeps billing for a desired state that is not deletion', async () => {
    const { service, usagePeriodRepository } = makeService([openPeriod()])

    await service.handleBoxDesiredStateUpdate(
      new BoxDesiredStateUpdatedEvent(box, BoxDesiredState.STARTED, BoxDesiredState.STOPPED),
    )

    expect(usagePeriodRepository.save).not.toHaveBeenCalled()
  })

  it('releases the per-box lock it took', async () => {
    const { service, redisLockProvider } = makeService([openPeriod()])

    await service.handleBoxDesiredStateUpdate(
      new BoxDesiredStateUpdatedEvent(box, BoxDesiredState.STARTED, BoxDesiredState.DESTROYED),
    )

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

  it('repairs a missing running-box period inside the per-box lock and transaction', async () => {
    const { service, boxRepository, redisLockProvider, usagePeriodRepository, transactionalEntityManager } =
      makeService()
    const startedAt = new Date('2026-08-06T00:00:00.000Z')
    boxRepository.findOne.mockResolvedValue({
      ...box,
      state: BoxState.STARTED,
      pending: false,
      billingChangedAt: startedAt,
    })

    await (service as any).repairDrift(candidate)

    expect(redisLockProvider.lock).toHaveBeenCalledWith(`usage-period-${box.id}`, 60)
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

  it('closes a lost terminal transition at the durable box update time', async () => {
    const periodStartAt = new Date('2026-08-06T00:00:00.000Z')
    const destroyedAt = new Date('2026-08-06T00:05:00.000Z')
    const open = {
      ...box,
      boxId: box.id,
      startAt: periodStartAt,
      endAt: null,
    } as unknown as BoxUsagePeriod
    const { service, boxRepository, transactionalEntityManager } = makeService([open])
    boxRepository.findOne.mockResolvedValue({
      ...box,
      state: BoxState.DESTROYED,
      pending: false,
      billingChangedAt: destroyedAt,
    })

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
    const { service, boxRepository, transactionalEntityManager } = makeService([stale])
    boxRepository.findOne.mockResolvedValue({
      ...box,
      state: BoxState.STARTED,
      pending: false,
      billingChangedAt: resizedAt,
    })

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
    const { service, boxRepository, transactionalEntityManager } = makeService([stale])
    boxRepository.findOne.mockResolvedValue({
      ...box,
      state: BoxState.STARTED,
      pending: false,
      billingChangedAt,
      updatedAt: unrelatedUpdatedAt,
    })

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
      const { service, boxRepository, transactionalEntityManager } = makeService()
      boxRepository.findOne.mockResolvedValue({
        ...box,
        state: BoxState.STARTED,
        pending: false,
        billingChangedAt: null,
        updatedAt: unrelatedUpdatedAt,
      })

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
    const { service, boxRepository } = makeService([open])
    boxRepository.findOne.mockResolvedValue({
      ...box,
      state: BoxState.DESTROYED,
      pending: false,
      billingChangedAt: boxUpdatedAt,
    })

    await (service as any).repairDrift({ ...candidate, box_state: BoxState.DESTROYED, period_id: 'period-1' })

    expect(open.endAt).toEqual(periodStartAt)
  })

  it('never starts a repaired period after the time reconciliation observed it', async () => {
    const observedAt = new Date('2026-08-06T00:05:00.000Z')
    const futureBoxUpdate = new Date('2026-08-06T00:10:00.000Z')
    jest.useFakeTimers().setSystemTime(observedAt)

    try {
      const { service, boxRepository, transactionalEntityManager } = makeService()
      boxRepository.findOne.mockResolvedValue({
        ...box,
        state: BoxState.STARTED,
        pending: false,
        billingChangedAt: futureBoxUpdate,
      })

      await (service as any).repairDrift(candidate)

      expect(transactionalEntityManager.save).toHaveBeenCalledWith(
        expect.objectContaining({ startAt: observedAt, endAt: null }),
      )
    } finally {
      jest.useRealTimers()
    }
  })

  it('does not create or rewrite a period for an unassigned warm-pool box', async () => {
    const { service, boxRepository, usagePeriodRepository, transactionalEntityManager } = makeService()
    boxRepository.findOne.mockResolvedValue({
      ...box,
      organizationId: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
      state: BoxState.STARTED,
      pending: false,
    })

    await (service as any).repairDrift(candidate)

    expect(usagePeriodRepository.manager.transaction).not.toHaveBeenCalled()
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
