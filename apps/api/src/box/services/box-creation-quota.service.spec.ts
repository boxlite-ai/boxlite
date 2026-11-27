/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { EntityManager } from 'typeorm'
import { BoxCreationAdmissionUnavailableError, BoxCreationLimitExceededError } from '../errors/box-creation-limit.error'
import { BoxConflictError } from '../errors/box-conflict.error'
import { Box } from '../entities/box.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxStateUpdatedEvent } from '../events/box-state-updated.event'
import { BoxCreationQuotaService } from './box-creation-quota.service'

const organizationId = '11111111-1111-4111-8111-111111111111'

function makeService() {
  const redis = {
    eval: jest.fn().mockResolvedValue([1, 1]),
    hgetall: jest.fn().mockResolvedValue({}),
  }
  const entityManager = { insert: jest.fn() }
  const dataSource = {
    transaction: jest.fn(async (callback: (manager: unknown) => Promise<void>) => callback(entityManager)),
    getRepository: jest.fn(),
  }
  const config = { get: jest.fn(() => true) }
  const service = new BoxCreationQuotaService(redis as never, dataSource as never, config as never)
  return { service, redis, dataSource, entityManager, config }
}

function box() {
  const value = new Box('us', 'quota')
  value.organizationId = organizationId
  value.state = BoxState.STARTED
  return value
}

describe('BoxCreationQuotaService', () => {
  it('does not run persistence when atomic admission rejects the request', async () => {
    const { service, redis, dataSource } = makeService()
    redis.eval.mockResolvedValue([0, 10])
    const persist = jest.fn()

    await expect(service.run(organizationId, 'box-1', 10, persist)).rejects.toBeInstanceOf(
      BoxCreationLimitExceededError,
    )
    expect(persist).not.toHaveBeenCalled()
    expect(dataSource.transaction).not.toHaveBeenCalled()
  })

  it('rejects a duplicate Box ID without releasing the existing reservation', async () => {
    const { service, redis, dataSource } = makeService()
    redis.eval.mockResolvedValue([2, 1])
    const persist = jest.fn()

    await expect(service.run(organizationId, 'box-1', 10, persist)).rejects.toBeInstanceOf(BoxConflictError)

    expect(persist).not.toHaveBeenCalled()
    expect(dataSource.transaction).not.toHaveBeenCalled()
    expect(redis.eval).toHaveBeenCalledTimes(1)
  })

  it('initializes an organization once and retries admission after a not-ready result', async () => {
    const { service, redis } = makeService()
    redis.eval.mockResolvedValueOnce([-1, 0]).mockResolvedValueOnce([1, 1])
    const reconcile = jest.spyOn(service, 'reconcileOrganization').mockResolvedValue()
    const persist = jest.fn().mockResolvedValue(undefined)

    await service.run(organizationId, 'box-1', 10, persist)

    expect(reconcile).toHaveBeenCalledWith(organizationId)
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('fails closed when Redis admission is unavailable', async () => {
    const { service, redis } = makeService()
    redis.eval.mockRejectedValue(new Error('redis unavailable'))
    const persist = jest.fn()

    await expect(service.run(organizationId, 'box-1', 10, persist)).rejects.toBeInstanceOf(
      BoxCreationAdmissionUnavailableError,
    )
    expect(persist).not.toHaveBeenCalled()
  })

  it('releases the reservation when the persistence callback fails before commit', async () => {
    const { service, redis, dataSource } = makeService()
    const failure = new Error('duplicate box name')
    dataSource.transaction.mockImplementation(async (callback: (manager: unknown) => Promise<void>) => {
      await callback({})
      throw failure
    })

    await expect(service.run(organizationId, 'box-1', 10, jest.fn().mockRejectedValue(failure))).rejects.toBe(failure)

    const release = redis.eval.mock.calls.find(([script]) => String(script).includes("redis.call('HDEL'"))
    expect(release).toBeDefined()
  })

  it('retains the reservation when persistence fails after the callback completes', async () => {
    const { service, redis, dataSource } = makeService()
    const failure = new Error('commit outcome unknown')
    dataSource.transaction.mockImplementation(async (callback: (manager: EntityManager) => Promise<void>) => {
      await callback({} as EntityManager)
      throw failure
    })

    await expect(service.run(organizationId, 'box-1', 10, jest.fn().mockResolvedValue(undefined))).rejects.toBe(failure)

    expect(redis.eval).toHaveBeenCalledTimes(1)
  })

  it('releases a counted Box entering an excluded state', async () => {
    const { service, redis } = makeService()
    const value = box()

    await service.handleBoxStateUpdated(new BoxStateUpdatedEvent(value, BoxState.STARTED, BoxState.ERROR))

    expect(String(redis.eval.mock.calls[0][0])).toContain("redis.call('HDEL'")
  })

  it('tracks a Box recovering from an excluded state', async () => {
    const { service, redis } = makeService()
    const value = box()
    value.state = BoxState.STOPPED

    await service.handleBoxStateUpdated(new BoxStateUpdatedEvent(value, BoxState.ERROR, BoxState.STOPPED))

    expect(String(redis.eval.mock.calls[0][0])).toContain("redis.call('INCR'")
  })

  it('does no Redis work when the POC is disabled', async () => {
    const { service, redis, config } = makeService()
    config.get.mockReturnValue(false)
    const value = box()
    value.state = BoxState.ERROR

    await service.trackCommitted(organizationId, value.id)
    await service.handleBoxStateUpdated(new BoxStateUpdatedEvent(value, BoxState.STARTED, BoxState.ERROR))

    expect(redis.eval).not.toHaveBeenCalled()
  })

  it('ignores state changes that do not cross the quota boundary', async () => {
    const { service, redis } = makeService()
    const value = box()
    value.state = BoxState.STOPPED

    await service.handleBoxStateUpdated(new BoxStateUpdatedEvent(value, BoxState.STARTED, BoxState.STOPPED))

    expect(redis.eval).not.toHaveBeenCalled()
  })
})
