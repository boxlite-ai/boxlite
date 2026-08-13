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
import { BoxActivityService } from './box-activity.service'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `box_activity_flush_${process.pid}_${randomUUID().replaceAll('-', '')}`
const organizationId = '00000000-0000-4000-8000-0000000000ff'

function box(name: string): Box {
  const created = new Box('us', name)
  created.organizationId = organizationId
  created.osUser = 'boxlite'
  return created
}

// The flush swallows what the upsert throws — a statement Postgres rejects
// leaves no trace beyond a log line — so every case here is asserted on the
// rows the flush left behind rather than on the call.
describeIfDatabase('BoxActivityService.flushActivityToDb (integration, real Postgres)', () => {
  let dataSource: DataSource
  let boxes: Repository<Box>
  let activity: Repository<BoxLastActivity>
  let service: BoxActivityService
  let buffered: Array<{ boxId: string; lastActivityAt: Date }>
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
      // Partial-index predicates reach CREATE INDEX with their enum casts
      // unqualified, so this run's schema has to be on the search_path for
      // synchronize() to build them here.
      extra: { options: `-c search_path=${schemaName},public` },
    }).initialize()

    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    ownsSchema = true
    await dataSource.synchronize()
    boxes = dataSource.getRepository(Box)
    activity = dataSource.getRepository(BoxLastActivity)

    service = new BoxActivityService(
      {
        // What the buffer holds, in the flat member/score shape WITHSCORES returns.
        zrangebyscore: () =>
          Promise.resolve(buffered.flatMap(({ boxId, lastActivityAt }) => [boxId, String(lastActivityAt.getTime())])),
        zremrangebyscore: () => Promise.resolve(0),
      } as any,
      dataSource,
      { lock: () => Promise.resolve(true), unlock: () => Promise.resolve() } as any,
      { getOrThrow: () => 100 } as any,
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
    buffered = []
    await dataSource.query(`DELETE FROM "${schemaName}"."box_last_activity"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."box"`)
  })

  it('writes the buffered timestamp for a box with no activity row', async () => {
    const target = box('first-activity')
    await boxes.insert(target)
    const lastActivityAt = new Date('2026-01-01T00:00:00.000Z')
    buffered = [{ boxId: target.id, lastActivityAt }]

    await service.flushActivityToDb()

    expect((await activity.findOneByOrFail({ boxId: target.id })).lastActivityAt).toEqual(lastActivityAt)
  })

  it('keeps the later of the buffered and stored timestamps', async () => {
    const advanced = box('advanced')
    const stale = box('stale')
    await boxes.insert([advanced, stale])
    const stored = new Date('2026-01-01T00:00:00.000Z')
    await activity.insert([
      { boxId: advanced.id, lastActivityAt: stored },
      { boxId: stale.id, lastActivityAt: stored },
    ])
    const newer = new Date('2026-01-02T00:00:00.000Z')
    const older = new Date('2025-12-31T00:00:00.000Z')
    buffered = [
      { boxId: advanced.id, lastActivityAt: newer },
      { boxId: stale.id, lastActivityAt: older },
    ]

    await service.flushActivityToDb()

    // The guard on the upsert is the whole point of the conditional: a buffered
    // value the database has already moved past must not travel backwards, or
    // an idle box would look freshly used to the auto-stop lifecycle.
    expect((await activity.findOneByOrFail({ boxId: advanced.id })).lastActivityAt).toEqual(newer)
    expect((await activity.findOneByOrFail({ boxId: stale.id })).lastActivityAt).toEqual(stored)
  })

  it('fills a row that has no timestamp yet', async () => {
    const target = box('never-active')
    await boxes.insert(target)
    await activity.insert({ boxId: target.id })
    const lastActivityAt = new Date('2026-01-01T00:00:00.000Z')
    buffered = [{ boxId: target.id, lastActivityAt }]

    await service.flushActivityToDb()

    // Null is not "later than everything" to Postgres — the comparison alone
    // would answer NULL and drop the write, so the guard names this case.
    expect((await activity.findOneByOrFail({ boxId: target.id })).lastActivityAt).toEqual(lastActivityAt)
  })

  it('flushes the boxes that still exist when one in the batch is gone', async () => {
    const live = box('still-here')
    await boxes.insert(live)
    const lastActivityAt = new Date('2026-01-01T00:00:00.000Z')
    // The buffer outlives the box it was written for, so the batch carries a
    // foreign key no box row satisfies.
    buffered = [
      { boxId: 'box-deleted-mid-flush', lastActivityAt },
      { boxId: live.id, lastActivityAt },
    ]

    await service.flushActivityToDb()

    expect((await activity.findOneByOrFail({ boxId: live.id })).lastActivityAt).toEqual(lastActivityAt)
    expect(await activity.count()).toBe(1)
  })
})
