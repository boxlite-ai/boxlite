/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { EVENT_LISTENER_METADATA } from '@nestjs/event-emitter/dist/constants'
import { FindOperator } from 'typeorm'
import { BoxEvents } from '../../box/constants/box-events.constants'
import { Box } from '../../box/entities/box.entity'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BoxState } from '../../box/enums/box-state.enum'
import { BoxDesiredStateUpdatedEvent } from '../../box/events/box-desired-state-updated.event'
import { BoxStateUpdatedEvent } from '../../box/events/box-state-updated.event'
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
  const lease = {
    signal: new AbortController().signal,
    release: jest.fn().mockResolvedValue(undefined),
  }
  const transactionalEntityManager = {
    find: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue(undefined),
    save: jest.fn().mockImplementation(async (value) => value),
  }
  const usagePeriodRepository = {
    findOne: jest.fn(async ({ where }: any) =>
      stored.find((period) =>
        Object.entries(where).every(([column, condition]) => satisfies((period as any)[column], condition)),
      ),
    ),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockImplementation(async (period) => period),
    manager: {
      transaction: jest.fn(async (callback) => callback(transactionalEntityManager)),
    },
  }
  const redisLockProvider = {
    acquireLease: jest.fn().mockResolvedValue(lease),
    waitForLease: jest.fn().mockResolvedValue(lease),
  }
  const boxRepository = { findOne: jest.fn() }
  const usageExportOutboxService = { enqueue: jest.fn().mockResolvedValue(0) }
  // The reconcile pass builds a left join through the query builder, which this
  // fake cannot stand in for; its behaviour is covered in
  // usage.service.integration.spec.ts against a real Postgres.
  const runnerRepository = { find: jest.fn().mockResolvedValue([]) }

  const service = new UsageService(
    usagePeriodRepository as any,
    redisLockProvider as any,
    boxRepository as any,
    usageExportOutboxService as any,
    runnerRepository as any,
  )

  return {
    service,
    usagePeriodRepository,
    redisLockProvider,
    usageExportOutboxService,
    lease,
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
  it('cancels a pending lock wait during application shutdown', async () => {
    const { service, redisLockProvider } = makeService()
    redisLockProvider.waitForLease.mockImplementation(
      (_key: string, _ttl: number, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )

    const handling = service.handleBoxStateUpdate(event(BoxState.STARTING)).catch((error) => error)
    await Promise.resolve()
    await service.onApplicationShutdown()

    await expect(handling).resolves.toEqual(expect.objectContaining({ message: 'UsageService is shutting down' }))
    expect(service.activeJobs.size).toBe(0)
  })

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
    const { service, lease } = makeService()

    await service.handleBoxStateUpdate(event(BoxState.STARTING))

    expect(lease.release).toHaveBeenCalledTimes(1)
  })

  it('does not reopen a period after lease ownership is lost while closing it', async () => {
    const open = openPeriod()
    const { service, usagePeriodRepository, lease } = makeService([open])
    const ownershipError = new Error('ownership was lost')
    const controller = new AbortController()
    lease.signal = controller.signal
    usagePeriodRepository.save.mockImplementationOnce(async (period) => {
      controller.abort(ownershipError)
      return period
    })

    await expect(service.handleBoxStateUpdate(event(BoxState.STARTED))).rejects.toBe(ownershipError)

    expect(usagePeriodRepository.save).toHaveBeenCalledTimes(1)
    expect(usagePeriodRepository.save).toHaveBeenCalledWith(open)
    expect(lease.release).toHaveBeenCalledTimes(1)
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
    const { service, lease } = makeService([openPeriod()])

    await service.handleBoxDesiredStateUpdate(
      new BoxDesiredStateUpdatedEvent(box, BoxDesiredState.STARTED, BoxDesiredState.DESTROYED),
    )

    expect(lease.release).toHaveBeenCalledTimes(1)
  })
})

describe('UsageService lease lifecycle', () => {
  it('releases the archive lease when the transaction fails', async () => {
    const { service, usagePeriodRepository, lease } = makeService()
    const transactionError = new Error('archive transaction failed')
    usagePeriodRepository.manager.transaction.mockRejectedValue(transactionError)

    await expect(service.archiveUsagePeriods()).rejects.toBe(transactionError)

    expect(lease.release).toHaveBeenCalledTimes(1)
  })

  it('rolls back archive writes when lease ownership is lost before commit', async () => {
    const { service, usagePeriodRepository, usageExportOutboxService, lease, transactionalEntityManager } =
      makeService()
    const ownershipError = new Error('ownership was lost')
    const controller = new AbortController()
    lease.signal = controller.signal
    const period = { id: 'period-1' } as BoxUsagePeriod
    transactionalEntityManager.find.mockResolvedValue([period])
    usageExportOutboxService.enqueue.mockImplementation(async () => {
      controller.abort(ownershipError)
    })
    let committed = false
    usagePeriodRepository.manager.transaction.mockImplementation(async (callback) => {
      const result = await callback(transactionalEntityManager)
      committed = true
      return result
    })

    await expect(service.archiveUsagePeriods()).rejects.toBe(ownershipError)

    expect(transactionalEntityManager.delete).toHaveBeenCalledWith(BoxUsagePeriod, [period.id])
    expect(transactionalEntityManager.save).toHaveBeenCalledTimes(1)
    expect(usageExportOutboxService.enqueue).toHaveBeenCalledTimes(1)
    expect(committed).toBe(false)
    expect(lease.release).toHaveBeenCalledTimes(1)
  })
})
