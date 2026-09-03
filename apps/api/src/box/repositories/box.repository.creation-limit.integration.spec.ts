/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { DataSource, EntityManager, Repository } from 'typeorm'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../constants/box.constants'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxCreationLimitExceededError } from '../errors/box-creation-limit.error'
import { BoxRepository } from './box.repository'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `box_creation_limit_${process.pid}_${randomUUID().replaceAll('-', '')}`
const organizationId = '00000000-0000-4000-8000-0000000000aa'

const excludedStates = new Set([
  BoxState.ERROR,
  BoxState.DESTROYING,
  BoxState.DESTROYED,
  BoxState.ARCHIVING,
  BoxState.ARCHIVED,
])

function newBox(name: string, owner = organizationId): Box {
  const box = new Box('us', name)
  box.organizationId = owner
  box.osUser = 'boxlite'
  box.labels = {}
  box.pending = true
  return box
}

function installInitialCountBarrier(dataSource: DataSource): jest.SpyInstance {
  const transaction = dataSource.transaction.bind(dataSource)
  let initialCountCalls = 0
  let releaseBarrier!: () => void
  const barrier = new Promise<void>((resolve) => (releaseBarrier = resolve))

  return jest.spyOn(dataSource, 'transaction').mockImplementation(async (...args: unknown[]) => {
    if (args[0] !== 'SERIALIZABLE' || typeof args[1] !== 'function') {
      return transaction(args[0] as (entityManager: EntityManager) => Promise<unknown>)
    }

    const callback = args[1] as (entityManager: EntityManager) => Promise<unknown>
    return transaction('SERIALIZABLE', async (entityManager) => {
      const count = entityManager.count.bind(entityManager)
      entityManager.count = async (...countArgs: Parameters<EntityManager['count']>) => {
        const result = await count(...countArgs)
        initialCountCalls++
        if (initialCountCalls <= 2) {
          if (initialCountCalls === 2) {
            releaseBarrier()
          }
          await barrier
        }
        return result
      }
      return callback(entityManager)
    })
  })
}

function expectOneSuccessAndOneLimitFailure(results: PromiseSettledResult<unknown>[]): void {
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  expect(failures).toHaveLength(1)
  expect(failures[0].reason).toBeInstanceOf(BoxCreationLimitExceededError)
}

describeIfDatabase('BoxRepository creation admission (integration, real Postgres)', () => {
  let dataSource: DataSource
  let boxes: Repository<Box>
  let repository: BoxRepository
  let ownsSchema = false

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema: schemaName,
      entities: [Box, BoxLastActivity],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      synchronize: false,
      extra: { options: `-c search_path=${schemaName},public` },
    }).initialize()

    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    ownsSchema = true
    await dataSource.synchronize()
    boxes = dataSource.getRepository(Box)
    repository = new BoxRepository(
      dataSource,
      { emit: jest.fn() } as never,
      { invalidate: jest.fn(), invalidateOrgId: jest.fn() } as never,
    )
  })

  afterAll(async () => {
    if (!dataSource?.isInitialized) {
      return
    }
    try {
      if (ownsSchema) {
        await dataSource.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
      }
    } finally {
      await dataSource.destroy()
    }
  })

  beforeEach(async () => {
    await dataSource.query(`DELETE FROM "${schemaName}"."box_last_activity"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."box"`)
  })

  it('allows exactly one of two fresh creates competing for the final slot', async () => {
    const barrier = installInitialCountBarrier(dataSource)
    try {
      const results = await Promise.allSettled([
        repository.insert(newBox('fresh-a'), 1),
        repository.insert(newBox('fresh-b'), 1),
      ])

      expectOneSuccessAndOneLimitFailure(results)
      expect(await boxes.countBy({ organizationId })).toBe(1)
    } finally {
      barrier.mockRestore()
    }
  })

  it('serializes a fresh create against a warm-pool ownership assignment', async () => {
    const warmPoolBox = newBox('warm', BOX_WARM_POOL_UNASSIGNED_ORGANIZATION)
    warmPoolBox.state = BoxState.STARTED
    warmPoolBox.pending = false
    await boxes.insert(warmPoolBox)

    const barrier = installInitialCountBarrier(dataSource)
    try {
      const results = await Promise.allSettled([
        repository.insert(newBox('fresh'), 1),
        repository.update(warmPoolBox.id, {
          updateData: { organizationId, name: 'claimed-warm' },
          entity: warmPoolBox,
          maxCreatedBoxes: 1,
        }),
      ])

      expectOneSuccessAndOneLimitFailure(results)
      expect(await boxes.countBy({ organizationId })).toBe(1)
    } finally {
      barrier.mockRestore()
    }
  })

  it.each(Object.values(BoxState))('applies the creation-count policy to state %s', async (state) => {
    const existing = newBox(`existing-${state}`)
    existing.state = state
    await repository.insert(existing)

    const creating = repository.insert(newBox(`candidate-${state}`), 1)
    if (excludedStates.has(state)) {
      await expect(creating).resolves.toBeInstanceOf(Box)
      expect(await boxes.countBy({ organizationId })).toBe(2)
    } else {
      await expect(creating).rejects.toBeInstanceOf(BoxCreationLimitExceededError)
      expect(await boxes.countBy({ organizationId })).toBe(1)
    }
  })
})
