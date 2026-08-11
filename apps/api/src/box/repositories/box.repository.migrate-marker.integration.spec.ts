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
import { BoxMigrationState } from '../enums/box-migration-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { BoxRepository } from './box.repository'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `box_migrate_marker_${process.pid}_${randomUUID().replaceAll('-', '')}`
const drainingRunnerId = '00000000-0000-4000-8000-00000000000a'
const healthyRunnerId = '00000000-0000-4000-8000-00000000000b'
const organizationId = '00000000-0000-4000-8000-0000000000ff'

function parkedBox(
  name: string,
  overrides: Partial<Pick<Box, 'runnerId' | 'state' | 'desiredState' | 'pending'>> = {},
): Box {
  const box = new Box('us', name)
  box.organizationId = organizationId
  box.osUser = 'boxlite'
  box.runnerId = drainingRunnerId
  box.state = BoxState.STOPPED
  box.desiredState = BoxDesiredState.STOPPED
  box.pending = false
  Object.assign(box, overrides)
  return box
}

describeIfDatabase('BoxRepository.markParkedBoxesForExport (integration, real Postgres)', () => {
  let dataSource: DataSource
  let boxes: Repository<Box>
  let migrations: Repository<BoxMigration>
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
      entities: [Box, BoxLastActivity, BoxMigration],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      synchronize: false,
      // TypeORM creates the enum types inside `schema` but copies partial-index
      // predicates into CREATE INDEX verbatim, so box_active_only_idx's
      // `::box_state_enum` cast arrives unqualified and would resolve against
      // the default search_path instead of this run's schema. Putting the schema
      // on the search_path is what lets synchronize() build that index here.
      extra: { options: `-c search_path=${schemaName},public` },
    }).initialize()

    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    ownsSchema = true
    await dataSource.synchronize()
    boxes = dataSource.getRepository(Box)
    migrations = dataSource.getRepository(BoxMigration)
    repository = new BoxRepository(
      dataSource,
      { emit: jest.fn() } as any,
      {
        invalidate: jest.fn(),
        invalidateOrgId: jest.fn(),
      } as any,
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
    await dataSource.query(`DELETE FROM "${schemaName}"."box_migration"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."box_last_activity"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."box"`)
  })

  it('opens the migration on a copy of the box stamp, leaving the box alone', async () => {
    const box = parkedBox('parked')
    await boxes.insert(box)
    const untouched = await boxes.findOneByOrFail({ id: box.id })

    expect(await repository.markParkedBoxesForExport([drainingRunnerId])).toBe(1)

    const migration = await migrations.findOneByOrFail({ boxId: box.id })
    expect(migration.state).toBe(BoxMigrationState.PENDING_EXPORT)
    // The equality every later validity check reads — and the box row it is
    // measured against is the one that was already there. A claim that wrote the
    // box would be indistinguishable from the interference it is watching for.
    expect((await boxes.findOneByOrFail({ id: box.id })).updatedAt).toEqual(untouched.updatedAt)
    expect(migration.updatedAt).toEqual(untouched.updatedAt)
  })

  it('breaks the timestamp equality on the next write from outside the migration', async () => {
    const box = parkedBox('started-underneath')
    await boxes.insert(box)
    await repository.markParkedBoxesForExport([drainingRunnerId])

    // What a user starting the box does to the row, minus the entity-level
    // guards: it moves updatedAt and nothing else.
    await repository.update(box.id, { updateData: { desiredState: BoxDesiredState.STARTED } }, true)

    const interfered = await boxes.findOneByOrFail({ id: box.id })
    const migration = await migrations.findOneByOrFail({ boxId: box.id })
    expect(migration.state).toBe(BoxMigrationState.PENDING_EXPORT)
    expect(migration.updatedAt).not.toEqual(interfered.updatedAt)
    // Both stamps come from the server — TypeORM's update builder writes
    // updatedAt as CURRENT_TIMESTAMP too — so the later write is strictly newer
    // and this ordering carries no dependence on the test machine's clock.
    expect(migration.updatedAt.getTime()).toBeLessThan(interfered.updatedAt.getTime())
  })

  it('claims a box a previous drain already migrated', async () => {
    const box = parkedBox('re-drained')
    await boxes.insert(box)
    const finished = await boxes.findOneByOrFail({ id: box.id })
    await migrations.insert({ boxId: box.id, state: BoxMigrationState.COMPLETED, updatedAt: finished.updatedAt })
    // Someone stopped the box again between the two drains, so the stamp the
    // finished migration copied is now behind the box's.
    await repository.update(box.id, { updateData: { desiredState: BoxDesiredState.STOPPED } }, true)

    expect(await repository.markParkedBoxesForExport([drainingRunnerId])).toBe(1)

    const reclaimed = await migrations.findOneByOrFail({ boxId: box.id })
    expect(reclaimed.state).toBe(BoxMigrationState.PENDING_EXPORT)
    // The finished migration's stamp has to be replaced, not kept: the second
    // migration is validated against the box row as it stands now, and keeping
    // the old copy would open a migration that reads as already disturbed.
    expect(reclaimed.updatedAt).toEqual((await boxes.findOneByOrFail({ id: box.id })).updatedAt)
    expect(reclaimed.updatedAt.getTime()).toBeGreaterThan(finished.updatedAt.getTime())
  })

  it('passes over a box another transaction is holding', async () => {
    const box = parkedBox('locked-elsewhere')
    await boxes.insert(box)

    const holder = dataSource.createQueryRunner()
    await holder.connect()
    await holder.startTransaction()
    try {
      await holder.query(`SELECT "id" FROM "${schemaName}"."box" WHERE "id" = $1 FOR UPDATE`, [box.id])

      // Waiting for that transaction would park the whole tick — and the Redis
      // lock it runs under — behind it, so the box is left for the next tick.
      expect(await repository.markParkedBoxesForExport([drainingRunnerId])).toBe(0)
      expect(await migrations.count()).toBe(0)
    } finally {
      await holder.rollbackTransaction()
      await holder.release()
    }

    expect(await repository.markParkedBoxesForExport([drainingRunnerId])).toBe(1)
  })

  it('leaves alone every box the migration must not move', async () => {
    const alreadyExporting = parkedBox('already-exporting')
    const rollingBack = parkedBox('rolling-back')
    await boxes.insert([
      parkedBox('on-healthy-runner', { runnerId: healthyRunnerId }),
      parkedBox('still-running', { state: BoxState.STARTED, desiredState: BoxDesiredState.STARTED }),
      parkedBox('wants-to-start', { desiredState: BoxDesiredState.STARTED, pending: true }),
      parkedBox('mid-transition', { pending: true }),
      alreadyExporting,
      rollingBack,
    ])

    const inFlight = [
      { box: alreadyExporting, state: BoxMigrationState.PENDING_EXPORT },
      { box: rollingBack, state: BoxMigrationState.PENDING_ROLLBACK },
    ]
    for (const { box, state } of inFlight) {
      const stored = await boxes.findOneByOrFail({ id: box.id })
      await migrations.insert({ boxId: box.id, state, updatedAt: stored.updatedAt })
    }
    const before = await boxes.find({ order: { name: 'ASC' } })

    expect(await repository.markParkedBoxesForExport([drainingRunnerId])).toBe(0)

    // No migration opened on the four that are not parked on a draining
    // runner, and the two already migrating kept the state and the stamp their
    // own migration is being validated against.
    expect(await migrations.count()).toBe(inFlight.length)
    for (const { box, state } of inFlight) {
      const migration = await migrations.findOneByOrFail({ boxId: box.id })
      expect(migration.state).toBe(state)
      expect(migration.updatedAt).toEqual((await boxes.findOneByOrFail({ id: box.id })).updatedAt)
    }
    // A box left out of the claim must not have its updatedAt moved either: a
    // bumped stamp on a box a migration already owns reads as interference.
    expect((await boxes.find({ order: { name: 'ASC' } })).map((box) => box.updatedAt)).toEqual(
      before.map((box) => box.updatedAt),
    )
  })

  it('marks nothing when no runner is draining', async () => {
    await boxes.insert(parkedBox('parked'))

    expect(await repository.markParkedBoxesForExport([])).toBe(0)
    expect(await migrations.count()).toBe(0)
  })

  it('drops the migration with the box it belongs to', async () => {
    const box = parkedBox('deleted-mid-migration')
    await boxes.insert(box)
    await repository.markParkedBoxesForExport([drainingRunnerId])

    await boxes.delete({ id: box.id })

    // Nothing outside this table has to remember to clean it up.
    expect(await migrations.count()).toBe(0)
  })
})
