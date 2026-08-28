/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxMigrationJobReceiver } from './box-migration-job-receiver.service'
import { Box } from '../entities/box.entity'
import { BoxMigration } from '../entities/box-migration.entity'
import { Job } from '../entities/job.entity'
import { Runner } from '../entities/runner.entity'
import { BoxMigrationState } from '../enums/box-migration-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { getMigrateJobLockKey } from '../utils/lock-key.util'

const BOX_ID = 'box-1'
const ORG_ID = 'org-1'
const SOURCE_RUNNER = 'runner-a'
const TARGET_RUNNER = 'runner-b'
const ARC_PATH = 'box-migrations/box-1.boxlite'

// The marker copied the box's own updatedAt into the migrate row, so the two
// start out equal and ValidCheck holds.
const STAMPED = new Date('2026-01-01T00:00:00.000Z')

function makeBox(overrides: Partial<Box> = {}): Box {
  const box = new Box('us-east')
  box.id = BOX_ID
  box.organizationId = ORG_ID
  box.name = 'box-one'
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
  Object.assign(migration, overrides)
  return migration
}

function makeRunner(draining: boolean): Runner {
  const runner = new Runner({ region: 'us-east', name: 'runner-a', apiKey: 'k', apiVersion: '1' })
  runner.id = SOURCE_RUNNER
  runner.draining = draining
  return runner
}

function makeJob(type: JobType, overrides: Partial<ConstructorParameters<typeof Job>[0]> = {}): Job {
  return new Job({
    id: 'job-1',
    type,
    status: JobStatus.COMPLETED,
    runnerId: TARGET_RUNNER,
    resourceType: ResourceType.BACKUP,
    resourceId: BOX_ID,
    ...overrides,
  })
}

type RecordedWrite = { table: 'box' | 'migrate'; values: any; params: any }

/** Collects the SET/WHERE of the receiver's conditional writes, per table. */
function makeWriteRecorder() {
  const writes: RecordedWrite[] = []
  const createQueryBuilder = () => {
    const recorded: RecordedWrite = { table: 'migrate', values: undefined, params: {} }
    const builder: any = {
      update: (target: any) => {
        recorded.table = target === Box ? 'box' : 'migrate'
        return builder
      },
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

function makeHarness(row?: { box?: Box | null; migration?: BoxMigration | null; sourceDraining?: boolean }) {
  const { writes, createQueryBuilder } = makeWriteRecorder()
  const box = row?.box === undefined ? makeBox() : row.box
  const migration = row?.migration === undefined ? makeMigration(BoxMigrationState.PENDING_EXPORT) : row.migration
  // The marker only claims boxes off draining runners, so a migration that
  // reaches its receiver started out on one.
  const sourceRunner = makeRunner(row?.sourceDraining ?? true)

  const entityManager = {
    findOne: jest.fn().mockImplementation(async (entity: any) => {
      if (entity === Box) {
        return box
      }
      return entity === Runner ? sourceRunner : migration
    }),
    createQueryBuilder,
  }
  const dataSource = {
    transaction: jest.fn().mockImplementation((run: any) => run(entityManager)),
    manager: entityManager,
  } as any
  const redisLockProvider = {
    unlock: jest.fn().mockResolvedValue(undefined),
  } as any
  const boxLookupCacheInvalidationService = {
    invalidate: jest.fn(),
  } as any

  return {
    receiver: new BoxMigrationJobReceiver(dataSource, redisLockProvider, boxLookupCacheInvalidationService),
    writes,
    redisLockProvider,
    boxLookupCacheInvalidationService,
  }
}

/** An export carries the key the control plane assigned it. */
function makeExportJob(overrides: Partial<ConstructorParameters<typeof Job>[0]> = {}): Job {
  return makeJob(JobType.EXPORT_BOX, {
    runnerId: SOURCE_RUNNER,
    payload: JSON.stringify({ arcPath: ARC_PATH }),
    ...overrides,
  })
}

describe('BoxMigrationJobReceiver EXPORT_BOX', () => {
  it('records the archive and moves an undisturbed migration on to the import', async () => {
    const h = makeHarness()
    const job = makeExportJob()
    job.resultMetadata = JSON.stringify({ arcPath: ARC_PATH })

    await h.receiver.handleJobCompletion(job)

    expect(h.writes).toEqual([
      {
        table: 'migrate',
        values: { state: BoxMigrationState.PENDING_IMPORT, arcPath: ARC_PATH },
        params: { boxId: BOX_ID, expected: BoxMigrationState.PENDING_EXPORT },
      },
    ])
    expect(h.redisLockProvider.unlock).toHaveBeenCalledWith(getMigrateJobLockKey(BOX_ID, JobType.EXPORT_BOX))
  })

  // The archive is on the object store whether or not the migration stayed
  // valid, so the key is recorded on both branches — without it the rollback
  // has nothing to delete and the object is stranded.
  it('records the archive and turns the migration around when the box was touched', async () => {
    const h = makeHarness({
      box: makeBox({ desiredState: BoxDesiredState.STARTED, updatedAt: new Date('2026-01-01T00:05:00.000Z') }),
    })
    const job = makeExportJob()
    job.resultMetadata = JSON.stringify({ arcPath: ARC_PATH })

    await h.receiver.handleJobCompletion(job)

    expect(h.writes).toEqual([
      {
        table: 'migrate',
        values: { state: BoxMigrationState.PENDING_ROLLBACK, arcPath: ARC_PATH },
        params: { boxId: BOX_ID, expected: BoxMigrationState.PENDING_EXPORT },
      },
    ])
  })

  // The drain is the migration's only reason to exist; an operator calling it
  // off mid-export takes that reason away, so the archive is recorded and the
  // migration turned around instead of the box being moved anyway.
  it('records the archive and turns the migration around when the runner stopped draining', async () => {
    const h = makeHarness({ sourceDraining: false })
    const job = makeExportJob()
    job.resultMetadata = JSON.stringify({ arcPath: ARC_PATH })

    await h.receiver.handleJobCompletion(job)

    expect(h.writes).toEqual([
      {
        table: 'migrate',
        values: { state: BoxMigrationState.PENDING_ROLLBACK, arcPath: ARC_PATH },
        params: { boxId: BOX_ID, expected: BoxMigrationState.PENDING_EXPORT },
      },
    ])
  })

  // The recorded key is later handed to another runner to download and delete,
  // so a runner that names someone else's object must not get it recorded.
  it('records the key the control plane assigned, not the one the runner reported', async () => {
    const h = makeHarness()
    const job = makeExportJob()
    job.resultMetadata = JSON.stringify({ arcPath: 's3://other-tenant/secrets.boxlite' })

    await h.receiver.handleJobCompletion(job)

    expect(h.writes[0].values).toEqual({ state: BoxMigrationState.PENDING_IMPORT, arcPath: ARC_PATH })
  })

  it('records an empty key when the job carries none, so the import leg rolls back', async () => {
    const h = makeHarness()
    const job = makeExportJob({ payload: undefined })
    job.resultMetadata = JSON.stringify({ arcPath: ARC_PATH })

    await h.receiver.handleJobCompletion(job)

    expect(h.writes[0].values).toEqual({ state: BoxMigrationState.PENDING_IMPORT, arcPath: '' })
  })

  it('leaves the state alone when the job failed, so the submitter retries', async () => {
    const h = makeHarness()
    const job = makeExportJob({ status: JobStatus.FAILED, errorMessage: 'upload timed out' })

    await h.receiver.handleJobCompletion(job)

    expect(h.writes).toHaveLength(0)
    expect(h.redisLockProvider.unlock).toHaveBeenCalledWith(getMigrateJobLockKey(BOX_ID, JobType.EXPORT_BOX))
  })

  // A status redelivered after a restart finds the migration already moved on.
  it('ignores a status that does not match the state the job was submitted from', async () => {
    const h = makeHarness({ migration: makeMigration(BoxMigrationState.PENDING_IMPORT) })
    const job = makeExportJob()
    job.resultMetadata = JSON.stringify({ arcPath: ARC_PATH })

    await h.receiver.handleJobCompletion(job)

    expect(h.writes).toHaveLength(0)
  })
})

describe('BoxMigrationJobReceiver IMPORT_BOX', () => {
  it('moves ownership to the target runner and leaves the source to be discarded', async () => {
    const h = makeHarness({ migration: makeMigration(BoxMigrationState.PENDING_IMPORT, { arcPath: ARC_PATH }) })

    await h.receiver.handleJobCompletion(makeJob(JobType.IMPORT_BOX))

    expect(h.writes).toEqual([
      {
        table: 'box',
        values: { runnerId: TARGET_RUNNER },
        params: { id: BOX_ID },
      },
      {
        table: 'migrate',
        values: { state: BoxMigrationState.PENDING_DISCARD_EXPORTED, runnerId: SOURCE_RUNNER },
        params: { boxId: BOX_ID, expected: BoxMigrationState.PENDING_IMPORT },
      },
    ])
    expect(h.redisLockProvider.unlock).toHaveBeenCalledWith(getMigrateJobLockKey(BOX_ID, JobType.IMPORT_BOX))
  })

  it('invalidates the cached box, which still names the runner that gave it up', async () => {
    const h = makeHarness({ migration: makeMigration(BoxMigrationState.PENDING_IMPORT, { arcPath: ARC_PATH }) })

    await h.receiver.handleJobCompletion(makeJob(JobType.IMPORT_BOX))

    expect(h.boxLookupCacheInvalidationService.invalidate).toHaveBeenCalledWith({
      id: BOX_ID,
      organizationId: ORG_ID,
      name: 'box-one',
    })
  })

  it('records the copy on the target runner and rolls back when the box was touched', async () => {
    const h = makeHarness({
      box: makeBox({ desiredState: BoxDesiredState.STARTED, updatedAt: new Date('2026-01-01T00:05:00.000Z') }),
      migration: makeMigration(BoxMigrationState.PENDING_IMPORT, { arcPath: ARC_PATH }),
    })

    await h.receiver.handleJobCompletion(makeJob(JobType.IMPORT_BOX))

    // The box keeps its runner: ownership only moves on the validated branch.
    expect(h.writes).toEqual([
      {
        table: 'migrate',
        values: { state: BoxMigrationState.PENDING_ROLLBACK, runnerId: TARGET_RUNNER },
        params: { boxId: BOX_ID, expected: BoxMigrationState.PENDING_IMPORT },
      },
    ])
    expect(h.boxLookupCacheInvalidationService.invalidate).not.toHaveBeenCalled()
  })

  // Past this point ownership would move for good, so a drain called off while
  // the import ran has to be caught here — the copy on the target runner is
  // recorded and reclaimed rather than becoming the box's new home.
  it('records the copy on the target runner and rolls back when the runner stopped draining', async () => {
    const h = makeHarness({
      migration: makeMigration(BoxMigrationState.PENDING_IMPORT, { arcPath: ARC_PATH }),
      sourceDraining: false,
    })

    await h.receiver.handleJobCompletion(makeJob(JobType.IMPORT_BOX))

    expect(h.writes).toEqual([
      {
        table: 'migrate',
        values: { state: BoxMigrationState.PENDING_ROLLBACK, runnerId: TARGET_RUNNER },
        params: { boxId: BOX_ID, expected: BoxMigrationState.PENDING_IMPORT },
      },
    ])
    expect(h.boxLookupCacheInvalidationService.invalidate).not.toHaveBeenCalled()
  })
})

describe('BoxMigrationJobReceiver reclaim jobs', () => {
  it('clears the archive once the rollback deleted it', async () => {
    const h = makeHarness({ migration: makeMigration(BoxMigrationState.PENDING_ROLLBACK, { arcPath: ARC_PATH }) })

    await h.receiver.handleJobCompletion(makeJob(JobType.ROLLBACK_EXPORT_BOX, { runnerId: SOURCE_RUNNER }))

    expect(h.writes).toEqual([
      {
        table: 'migrate',
        values: { arcPath: '' },
        params: { boxId: BOX_ID, expected: BoxMigrationState.PENDING_ROLLBACK },
      },
    ])
    expect(h.redisLockProvider.unlock).toHaveBeenCalledWith(getMigrateJobLockKey(BOX_ID, JobType.ROLLBACK_EXPORT_BOX))
  })

  it('clears the second runner once the rollback destroyed the copy on it', async () => {
    const h = makeHarness({ migration: makeMigration(BoxMigrationState.PENDING_ROLLBACK, { runnerId: TARGET_RUNNER }) })

    await h.receiver.handleJobCompletion(makeJob(JobType.ROLLBACK_IMPORT_BOX))

    expect(h.writes).toEqual([
      {
        table: 'migrate',
        values: { runnerId: null },
        params: { boxId: BOX_ID, expected: BoxMigrationState.PENDING_ROLLBACK },
      },
    ])
  })

  it('completes the migration once the exported copy is discarded', async () => {
    const h = makeHarness({
      migration: makeMigration(BoxMigrationState.PENDING_DISCARD_EXPORTED, {
        arcPath: ARC_PATH,
        runnerId: SOURCE_RUNNER,
      }),
    })

    await h.receiver.handleJobCompletion(makeJob(JobType.DISCARD_EXPORTED_BOX, { runnerId: SOURCE_RUNNER }))

    expect(h.writes).toEqual([
      {
        table: 'migrate',
        values: { state: BoxMigrationState.COMPLETED, arcPath: '', runnerId: null },
        params: { boxId: BOX_ID, expected: BoxMigrationState.PENDING_DISCARD_EXPORTED },
      },
    ])
    expect(h.redisLockProvider.unlock).toHaveBeenCalledWith(getMigrateJobLockKey(BOX_ID, JobType.DISCARD_EXPORTED_BOX))
  })
})
