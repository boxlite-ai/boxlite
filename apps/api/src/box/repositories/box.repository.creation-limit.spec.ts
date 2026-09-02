/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { FindOperator, FindOptionsWhere } from 'typeorm'
import { BoxRepository } from './box.repository'
import { Box } from '../entities/box.entity'
import { BoxState } from '../enums/box-state.enum'
import {
  BOX_CREATION_ADMISSION_UNAVAILABLE_CODE,
  BOX_CREATION_LIMIT_EXCEEDED_CODE,
  BoxCreationAdmissionUnavailableError,
  BoxCreationLimitExceededError,
} from '../errors/box-creation-limit.error'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../constants/box.constants'

type TransactionCallback = (entityManager: ReturnType<typeof makeEntityManager>) => Promise<unknown>

function makeEntityManager(currentCount = 0) {
  return {
    count: jest.fn().mockResolvedValue(currentCount),
    insert: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    upsert: jest.fn().mockResolvedValue(undefined),
  }
}

function makeRepository(currentCount = 0) {
  const entityManager = makeEntityManager(currentCount)
  const transaction: jest.Mock = jest.fn(async (...args: unknown[]) => {
    const callback = (typeof args[0] === 'function' ? args[0] : args[1]) as TransactionCallback
    return callback(entityManager)
  })
  const repository = { update: jest.fn(), manager: {} }
  const dataSource = {
    getRepository: jest.fn(() => repository),
    transaction,
  }
  const eventEmitter = { emit: jest.fn() }
  const cacheInvalidation = {
    invalidateOrgId: jest.fn(),
    invalidate: jest.fn(),
  }
  const boxRepository = new BoxRepository(dataSource as never, eventEmitter as never, cacheInvalidation as never)
  return { boxRepository, entityManager, transaction, eventEmitter, cacheInvalidation }
}

function box(organizationId = '11111111-1111-4111-8111-111111111111'): Box {
  const entity = new Box('region-1', 'test-box')
  entity.organizationId = organizationId
  entity.osUser = 'boxlite'
  entity.pending = true
  return entity
}

function responseCode(error: BoxCreationLimitExceededError | BoxCreationAdmissionUnavailableError): string {
  return (error.getResponse() as { code: string }).code
}

describe('BoxRepository creation admission', () => {
  it('counts and inserts with one SERIALIZABLE transactional manager', async () => {
    const { boxRepository, entityManager, transaction, cacheInvalidation } = makeRepository(1)
    const entity = box()

    await expect(boxRepository.insert(entity, 2)).resolves.toBe(entity)

    expect(transaction).toHaveBeenCalledWith('SERIALIZABLE', expect.any(Function))
    expect(entityManager.count).toHaveBeenCalledWith(Box, expect.objectContaining({ where: expect.any(Array) }))
    expect(entityManager.insert).toHaveBeenCalledWith(Box, entity)
    expect(entityManager.upsert).toHaveBeenCalledTimes(1)
    expect(cacheInvalidation.invalidateOrgId).toHaveBeenCalledTimes(1)

    const where = entityManager.count.mock.calls[0][1].where as FindOptionsWhere<Box>[]
    expect(where).toEqual([
      expect.objectContaining({ organizationId: entity.organizationId }),
      {
        organizationId: entity.organizationId,
        state: BoxState.UNKNOWN,
        pending: true,
      },
    ])

    const stateFilter = where[0].state as FindOperator<BoxState>
    expect(stateFilter.type).toBe('not')
    const excludedStates = stateFilter.child as FindOperator<BoxState>
    expect(excludedStates.type).toBe('in')
    expect(excludedStates.value).toEqual([
      BoxState.ERROR,
      BoxState.UNKNOWN,
      BoxState.DESTROYING,
      BoxState.DESTROYED,
      BoxState.ARCHIVING,
      BoxState.ARCHIVED,
    ])
  })

  it('rejects at the limit before persistence or post-commit side effects', async () => {
    const { boxRepository, entityManager, cacheInvalidation, eventEmitter } = makeRepository(2)

    const error = await boxRepository.insert(box(), 2).catch((caught) => caught)

    expect(error).toBeInstanceOf(BoxCreationLimitExceededError)
    expect(responseCode(error)).toBe(BOX_CREATION_LIMIT_EXCEEDED_CODE)
    expect(error.getStatus()).toBe(429)
    expect(error.getResponse()).toEqual(expect.objectContaining({ message: expect.stringContaining('2 of 2') }))
    expect(entityManager.insert).not.toHaveBeenCalled()
    expect(entityManager.upsert).not.toHaveBeenCalled()
    expect(cacheInvalidation.invalidateOrgId).not.toHaveBeenCalled()
    expect(eventEmitter.emit).not.toHaveBeenCalled()
  })

  it('applies the same admission transaction when assigning a warm-pool box', async () => {
    const { boxRepository, entityManager, transaction } = makeRepository(0)
    const warmPoolBox = box(BOX_WARM_POOL_UNASSIGNED_ORGANIZATION)
    warmPoolBox.state = BoxState.STARTED
    warmPoolBox.pending = false
    const organizationId = '22222222-2222-4222-8222-222222222222'

    await boxRepository.update(warmPoolBox.id, {
      updateData: { organizationId },
      entity: warmPoolBox,
      maxCreatedBoxes: 1,
    })

    expect(transaction).toHaveBeenCalledWith('SERIALIZABLE', expect.any(Function))
    expect(entityManager.count).toHaveBeenCalledWith(
      Box,
      expect.objectContaining({ where: expect.arrayContaining([expect.objectContaining({ organizationId })]) }),
    )
    expect(entityManager.update).toHaveBeenCalledTimes(1)
    expect(entityManager.upsert).toHaveBeenCalledTimes(1)
  })

  it('retries the complete count-and-write transaction after SQLSTATE 40001', async () => {
    const { boxRepository, entityManager, transaction } = makeRepository(0)
    let attempts = 0
    transaction.mockImplementation(async (_isolation: string, callback: TransactionCallback) => {
      const result = await callback(entityManager)
      attempts++
      if (attempts < 3) {
        throw Object.assign(new Error('could not serialize access'), { code: '40001' })
      }
      return result
    })

    await boxRepository.insert(box(), 3)

    expect(transaction).toHaveBeenCalledTimes(3)
    expect(entityManager.count).toHaveBeenCalledTimes(3)
    expect(entityManager.insert).toHaveBeenCalledTimes(3)
    expect(entityManager.upsert).toHaveBeenCalledTimes(3)
  })

  it('returns a retryable 503 after five serialization failures', async () => {
    const { boxRepository, entityManager, transaction } = makeRepository(0)
    transaction.mockImplementation(async (_isolation: string, callback: TransactionCallback) => {
      await callback(entityManager)
      throw Object.assign(new Error('could not serialize access'), { code: '40001' })
    })

    const error = await boxRepository.insert(box(), 3).catch((caught) => caught)

    expect(error).toBeInstanceOf(BoxCreationAdmissionUnavailableError)
    expect(responseCode(error)).toBe(BOX_CREATION_ADMISSION_UNAVAILABLE_CODE)
    expect(error.getStatus()).toBe(503)
    expect((error as unknown as { retryAfterSeconds?: number }).retryAfterSeconds).toBe(5)
    expect(transaction).toHaveBeenCalledTimes(5)
  })

  it('does not retry database errors other than serialization failures', async () => {
    const { boxRepository, transaction } = makeRepository(0)
    transaction.mockRejectedValue(Object.assign(new Error('connection lost'), { code: '08006' }))

    await expect(boxRepository.insert(box(), 3)).rejects.toThrow('connection lost')
    expect(transaction).toHaveBeenCalledTimes(1)
  })

  it('preserves the existing non-serializable transaction when admission is disabled', async () => {
    const { boxRepository, transaction, entityManager } = makeRepository()

    await boxRepository.insert(box())

    expect(transaction).toHaveBeenCalledWith(expect.any(Function))
    expect(entityManager.count).not.toHaveBeenCalled()
  })
})
