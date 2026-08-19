/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxMigrationManager } from './box-migration.manager'
import { Box } from '../entities/box.entity'
import { BoxMigration } from '../entities/box-migration.entity'
import { BoxMigrationState } from '../enums/box-migration-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { getMigrateJobLockKey } from '../utils/lock-key.util'

const BOX_ID = 'box-1'
const SOURCE_RUNNER = 'runner-a'
const TARGET_RUNNER = 'runner-b'

// The Marker copies the box's own updatedAt into the box_migration row, so the
// two start out equal and ValidCheck holds.
const STAMPED = new Date('2026-01-01T00:00:00.000Z')

function makeBox(overrides: Partial<Box> = {}): Box {
  const box = new Box('us-east')
  box.id = BOX_ID
  box.runnerId = SOURCE_RUNNER
  box.state = BoxState.STOPPED
  box.desiredState = BoxDesiredState.STOPPED
  box.updatedAt = STAMPED
  Object.assign(box, overrides)
  return box
}

function makeMigration(state: BoxMigrationState, overrides: Partial<BoxMigration> = {}): BoxMigration {
  const migration = new BoxMigration()
  migration.boxId = BOX_ID
  migration.state = state
  migration.arcPath = ''
  migration.updatedAt = STAMPED
  migration.box = makeBox()
  Object.assign(migration, overrides)
  return migration
}

type RecordedWrite = { kind: 'update' | 'delete'; values?: any; params: any }

/** Collects the SET/WHERE of the manager's conditional box_migration writes. */
function makeWriteRecorder() {
  const writes: RecordedWrite[] = []
  const createQueryBuilder = () => {
    const recorded: RecordedWrite = { kind: 'update', params: {} }
    const builder: any = {
      update: () => builder,
      delete: () => {
        recorded.kind = 'delete'
        return builder
      },
      from: () => builder,
      set: (values: any) => {
        recorded.values = values
        return builder
      },
      where: (_sql: string, params: any) => {
        Object.assign(recorded.params, params)
        return builder
      },
      andWhere: (_sql: string, params: any) => {
        Object.assign(recorded.params, params)
        return builder
      },
      execute: async () => {
        writes.push(recorded)
        return { affected: 1 }
      },
    }
    return builder
  }
  return { writes, createQueryBuilder }
}

function makeHarness(
  migrations: BoxMigration[],
  locked?: { box?: Box; migration?: BoxMigration },
  archivePrefix = 'box-migrations/',
) {
  const { writes, createQueryBuilder } = makeWriteRecorder()
  const lockedBox = locked?.box ?? migrations[0]?.box
  const lockedMigration = locked?.migration ?? migrations[0]
  const entityManager = {
    findOne: jest.fn().mockImplementation(async (entity: any) => (entity === Box ? lockedBox : lockedMigration)),
    createQueryBuilder,
  }
  const find = jest.fn().mockResolvedValue(migrations)
  // Whether a transaction is open right now, and what each target resolution
  // saw: a resolver that queries from inside the transaction needs a second
  // pool connection while the first is still held, which deadlocks the pool
  // under fan-out.
  let inTransaction = false
  const resolverSawTransaction: boolean[] = []
  const dataSource = {
    getRepository: jest.fn().mockReturnValue({ find }),
    transaction: jest.fn().mockImplementation(async (run: any) => {
      inTransaction = true
      try {
        return await run(entityManager)
      } finally {
        inTransaction = false
      }
    }),
    manager: entityManager,
  } as any
  const runnerService = {
    getRandomAvailableRunner: jest.fn().mockImplementation(async () => {
      resolverSawTransaction.push(inTransaction)
      return { id: TARGET_RUNNER }
    }),
  } as any
  const jobService = {
    createJob: jest.fn().mockResolvedValue(undefined),
  } as any
  const redisLockProvider = {
    lock: jest.fn().mockResolvedValue(true),
    unlock: jest.fn().mockResolvedValue(undefined),
  } as any
  const configService = {
    getOrThrow: jest.fn().mockReturnValue(archivePrefix),
  } as any

  return {
    manager: new BoxMigrationManager(dataSource, runnerService, jobService, redisLockProvider, configService),
    entityManager,
    find,
    runnerService,
    jobService,
    redisLockProvider,
    writes,
    resolverSawTransaction,
  }
}

describe('BoxMigrationManager submitter loop', () => {
  it('submits EXPORT_BOX to the box runner and holds the lock for the job in flight', async () => {
    const migration = makeMigration(BoxMigrationState.PENDING_EXPORT)
    const h = makeHarness([migration])

    await h.manager.submitMigrationJobs()

    expect(h.jobService.createJob).toHaveBeenCalledWith(
      h.entityManager,
      JobType.EXPORT_BOX,
      SOURCE_RUNNER,
      ResourceType.BACKUP,
      BOX_ID,
      { arcPath: 'box-migrations/box-1.boxlite' },
    )
    expect(h.redisLockProvider.unlock).not.toHaveBeenCalledWith(getMigrateJobLockKey(BOX_ID, JobType.EXPORT_BOX))
    expect(h.writes).toHaveLength(0)
  })

  // The archive key is the one thing both runners and the object store have to
  // agree on, so an operator pointing migrations at another bucket or namespace
  // has to reach the payload rather than only the config.
  it('exports to the configured archive prefix', async () => {
    const migration = makeMigration(BoxMigrationState.PENDING_EXPORT)
    const h = makeHarness([migration], undefined, 's3://archives/tenant-a/')

    await h.manager.submitMigrationJobs()

    expect(h.jobService.createJob).toHaveBeenCalledWith(
      h.entityManager,
      JobType.EXPORT_BOX,
      SOURCE_RUNNER,
      ResourceType.BACKUP,
      BOX_ID,
      { arcPath: 's3://archives/tenant-a/box-1.boxlite' },
    )
  })

  it('rolls back instead of exporting when the box was touched mid-migration', async () => {
    // A user started the box: box.updatedAt moved past the copy the marker took.
    const migration = makeMigration(BoxMigrationState.PENDING_EXPORT, {
      box: makeBox({
        desiredState: BoxDesiredState.STARTED,
        updatedAt: new Date('2026-01-01T00:05:00.000Z'),
      }),
    })
    const h = makeHarness([migration])

    await h.manager.submitMigrationJobs()

    expect(h.jobService.createJob).not.toHaveBeenCalled()
    expect(h.writes).toEqual([
      {
        kind: 'update',
        values: { state: BoxMigrationState.PENDING_ROLLBACK },
        params: { boxId: BOX_ID, expected: BoxMigrationState.PENDING_EXPORT },
      },
    ])
    expect(h.redisLockProvider.unlock).toHaveBeenCalledWith(getMigrateJobLockKey(BOX_ID, JobType.EXPORT_BOX))
  })

  it('skips a box whose job lock is already held', async () => {
    const migration = makeMigration(BoxMigrationState.PENDING_EXPORT)
    const h = makeHarness([migration])
    h.redisLockProvider.lock.mockImplementation(
      async (key: string) => key !== getMigrateJobLockKey(BOX_ID, JobType.EXPORT_BOX),
    )

    await h.manager.submitMigrationJobs()

    expect(h.jobService.createJob).not.toHaveBeenCalled()
    expect(h.writes).toHaveLength(0)
  })

  it('submits IMPORT_BOX to a runner other than the one being drained', async () => {
    const migration = makeMigration(BoxMigrationState.PENDING_IMPORT, {
      arcPath: 'box-migrations/box-1.boxlite',
    })
    const h = makeHarness([migration])

    await h.manager.submitMigrationJobs()

    expect(h.runnerService.getRandomAvailableRunner).toHaveBeenCalledWith({
      regions: [migration.box.region],
      boxClass: migration.box.class,
      excludedRunnerIds: [SOURCE_RUNNER],
    })
    expect(h.jobService.createJob).toHaveBeenCalledWith(
      h.entityManager,
      JobType.IMPORT_BOX,
      TARGET_RUNNER,
      ResourceType.BACKUP,
      BOX_ID,
      { arcPath: 'box-migrations/box-1.boxlite' },
    )
  })

  /**
   * The import resolver asks the scheduler for a target runner, which is a
   * query. Issued from inside `submitValidated`'s transaction it needs a
   * *second* pool connection while the transaction still holds the first, and
   * the submit loop fans out over every pending migration at once — so at
   * pool-size concurrency (10 by default, `DB_POOL_MAX` unset) every connection
   * ends up held by a transaction waiting for one only its peers could release.
   *
   * Observed on the local stack: 10 sessions `idle in transaction`, every
   * IMPORT_BOX submission dying with `QueryRunnerAlreadyReleasedError` on the
   * job insert, `GET /v1/{prefix}/boxes` timing out at 60s while
   * `/api/health` answered in 1ms, and the drained runner never emptying.
   */
  it('resolves the import target before opening the transaction', async () => {
    const migration = makeMigration(BoxMigrationState.PENDING_IMPORT, {
      arcPath: 'box-migrations/box-1.boxlite',
    })
    const h = makeHarness([migration])

    await h.manager.submitMigrationJobs()

    expect(h.runnerService.getRandomAvailableRunner).toHaveBeenCalledTimes(1)
    expect(h.resolverSawTransaction).toEqual([false])
    // Still submitted, and still inside the transaction that holds the locks.
    expect(h.jobService.createJob).toHaveBeenCalledWith(
      h.entityManager,
      JobType.IMPORT_BOX,
      TARGET_RUNNER,
      ResourceType.BACKUP,
      BOX_ID,
      { arcPath: 'box-migrations/box-1.boxlite' },
    )
  })

  it('releases the lock and leaves the state alone when submission fails', async () => {
    const migration = makeMigration(BoxMigrationState.PENDING_EXPORT)
    const h = makeHarness([migration])
    h.jobService.createJob.mockRejectedValue(new Error('job conflict'))

    await h.manager.submitMigrationJobs()

    expect(h.writes).toHaveLength(0)
    expect(h.redisLockProvider.unlock).toHaveBeenCalledWith(getMigrateJobLockKey(BOX_ID, JobType.EXPORT_BOX))
  })

  // box_migration.updatedAt is the copy of box.updatedAt the migration took, so
  // the scan has to run newest-first: a box the user touched recently is the one
  // they are likeliest to start again on the runner being drained.
  it('scans the most recently used boxes first', async () => {
    const h = makeHarness([makeMigration(BoxMigrationState.PENDING_EXPORT)])

    await h.manager.submitMigrationJobs()

    expect(h.find).toHaveBeenCalledWith(expect.objectContaining({ order: { updatedAt: 'DESC' } }))
  })

  it('turns a PENDING_IMPORT migration with no archive around', async () => {
    const migration = makeMigration(BoxMigrationState.PENDING_IMPORT)
    const h = makeHarness([migration])

    await h.manager.submitMigrationJobs()

    expect(h.jobService.createJob).not.toHaveBeenCalled()
    expect(h.writes).toEqual([
      {
        kind: 'update',
        values: { state: BoxMigrationState.PENDING_ROLLBACK },
        params: { boxId: BOX_ID, expected: BoxMigrationState.PENDING_IMPORT },
      },
    ])
  })
})

describe('BoxMigrationManager rollback submitter loop', () => {
  it('reclaims both artifacts, each on the runner that holds it', async () => {
    const migration = makeMigration(BoxMigrationState.PENDING_ROLLBACK, {
      arcPath: 'box-migrations/box-1.boxlite',
      runnerId: TARGET_RUNNER,
    })
    const h = makeHarness([migration])

    await h.manager.submitRollbackJobs()

    expect(h.jobService.createJob).toHaveBeenCalledWith(
      null,
      JobType.ROLLBACK_EXPORT_BOX,
      SOURCE_RUNNER,
      ResourceType.BACKUP,
      BOX_ID,
      { arcPath: 'box-migrations/box-1.boxlite' },
    )
    expect(h.jobService.createJob).toHaveBeenCalledWith(
      null,
      JobType.ROLLBACK_IMPORT_BOX,
      TARGET_RUNNER,
      ResourceType.BACKUP,
      BOX_ID,
      undefined,
    )
    expect(h.writes).toHaveLength(0)
  })

  it('drops the migration once nothing is left to reclaim', async () => {
    const migration = makeMigration(BoxMigrationState.PENDING_ROLLBACK)
    const h = makeHarness([migration])

    await h.manager.submitRollbackJobs()

    expect(h.jobService.createJob).not.toHaveBeenCalled()
    // The row is the migration, so ending one deletes it rather than moving it
    // to a "not migrating" state the table does not have.
    expect(h.writes).toEqual([
      {
        kind: 'delete',
        params: { boxId: BOX_ID, expected: BoxMigrationState.PENDING_ROLLBACK },
      },
    ])
  })

  it('discards the exported box on the runner it was migrated away from', async () => {
    const migration = makeMigration(BoxMigrationState.PENDING_DISCARD_EXPORTED, {
      arcPath: 'box-migrations/box-1.boxlite',
      runnerId: SOURCE_RUNNER,
      box: makeBox({ runnerId: TARGET_RUNNER }),
    })
    const h = makeHarness([migration])

    await h.manager.submitRollbackJobs()

    expect(h.jobService.createJob).toHaveBeenCalledWith(
      null,
      JobType.DISCARD_EXPORTED_BOX,
      SOURCE_RUNNER,
      ResourceType.BACKUP,
      BOX_ID,
      { arcPath: 'box-migrations/box-1.boxlite' },
    )
  })
})
