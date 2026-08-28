/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { DataSource, Repository } from 'typeorm'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../constants/box.constants'
import { BoxInventoryLimitExceededError } from '../errors/box-inventory-limit-exceeded.error'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { BoxRepository } from './box.repository'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `box_inventory_limit_${process.pid}_${randomUUID().replaceAll('-', '')}`
const organizationId = '00000000-0000-4000-8000-000000000140'

function quotaBox(name: string, boxOrganizationId = organizationId): Box {
  const box = new Box('us', name)
  box.organizationId = boxOrganizationId
  box.osUser = 'boxlite'
  return box
}

describeIfDatabase('BoxRepository inventory commit fence (integration, real Postgres)', () => {
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
      { emit: jest.fn() } as any,
      { invalidateOrgId: jest.fn(), invalidate: jest.fn() } as any,
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

  it('admits exactly one of two concurrent creates from limit minus one', async () => {
    await boxes.insert(quotaBox('existing'))

    const results = await Promise.allSettled([
      repository.insert(quotaBox('candidate-a'), { inventoryLimit: 2 }),
      repository.insert(quotaBox('candidate-b'), { inventoryLimit: 2 }),
    ])

    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected') as PromiseRejectedResult[]
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBeInstanceOf(BoxInventoryLimitExceededError)
    expect(await repository.countQuotaBoxes(organizationId)).toBe(2)
  })

  it('uses the same commit fence for a fresh insert and warm-pool assignment', async () => {
    const warmPoolBox = quotaBox('warm-pool', BOX_WARM_POOL_UNASSIGNED_ORGANIZATION)
    await boxes.insert(warmPoolBox)

    const results = await Promise.allSettled([
      repository.insert(quotaBox('fresh'), { inventoryLimit: 1 }),
      repository.update(warmPoolBox.id, {
        updateData: { organizationId },
        entity: warmPoolBox,
        inventoryLimit: 1,
      }),
    ])

    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected') as PromiseRejectedResult[]
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBeInstanceOf(BoxInventoryLimitExceededError)
    expect(await repository.countQuotaBoxes(organizationId)).toBe(1)
  })
})
