/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { DataSource, Repository } from 'typeorm'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { BoxMigration } from '../entities/box-migration.entity'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { BoxRepository } from '../repositories/box.repository'
import { BoxManager } from './box.manager'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `box_manager_snapshot_${process.pid}_${randomUUID().replaceAll('-', '')}`

function boxIn(name: string, state: BoxState, desiredState: BoxDesiredState, pending: boolean): Box {
  const box = new Box('us', name)
  box.organizationId = '00000000-0000-4000-8000-0000000000ff'
  box.osUser = 'boxlite'
  box.runnerId = '00000000-0000-4000-8000-00000000000a'
  box.state = state
  box.desiredState = desiredState
  box.pending = pending
  return box
}

describeIfDatabase('BoxManager.syncStates and snapshot states (integration, real Postgres)', () => {
  let dataSource: DataSource
  let boxes: Repository<Box>
  let manager: BoxManager
  let synced: string[]
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
      entities: [Box, BoxLastActivity, BoxMigration],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      synchronize: false,
      // See box.repository.migrate-marker.integration.spec.ts: partial-index
      // predicates reach CREATE INDEX unqualified.
      extra: { options: `-c search_path=${schemaName},public` },
    }).initialize()

    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    ownsSchema = true
    await dataSource.synchronize()
    boxes = dataSource.getRepository(Box)

    const repository = new BoxRepository(
      dataSource,
      { emit: jest.fn() } as never,
      { invalidate: jest.fn(), invalidateOrgId: jest.fn() } as never,
    )
    const locks = {
      lock: jest.fn().mockResolvedValue(true),
      unlock: jest.fn().mockResolvedValue(undefined),
      isLocked: jest.fn().mockResolvedValue(false),
    }
    manager = new BoxManager(
      repository,
      {} as never,
      {} as never,
      locks as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )
    // Record which boxes the scan hands on, rather than syncing them.
    jest.spyOn(manager, 'syncInstanceState').mockImplementation(async (boxId: string) => {
      synced.push(boxId)
    })
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
    synced = []
    await dataSource.query(`DELETE FROM "${schemaName}"."box_last_activity"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."box"`)
  })

  it('skips a stopped box a snapshot job holds, and still syncs its deletion', async () => {
    const exporting = boxIn('exporting', BoxState.EXPORTING, BoxDesiredState.STOPPED, false)
    const importing = boxIn('importing', BoxState.IMPORTING, BoxDesiredState.STOPPED, false)
    const deleted = boxIn('deleted', BoxState.EXPORTING, BoxDesiredState.DESTROYED, true)
    const stopping = boxIn('stopping', BoxState.STARTED, BoxDesiredState.STOPPED, true)
    await boxes.insert([exporting, importing, deleted, stopping])

    await manager.syncStates()

    expect([...synced].sort()).toEqual([deleted.id, stopping.id].sort())
  })
})
