/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException, HttpException, Logger, NotFoundException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { DataSource, Repository } from 'typeorm'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { BoxEvents } from '../constants/box-events.constants'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { BoxMigration } from '../entities/box-migration.entity'
import { BoxSnapshot } from '../entities/box-snapshot.entity'
import { BoxSnapshotRestore } from '../entities/box-snapshot-restore.entity'
import { Job } from '../entities/job.entity'
import { Runner } from '../entities/runner.entity'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxMigrationState } from '../enums/box-migration-state.enum'
import { BoxSnapshotRestoreState } from '../enums/box-snapshot-restore-state.enum'
import { BoxSnapshotState } from '../enums/box-snapshot-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { BoxRepository } from '../repositories/box.repository'
import * as boxNames from '../utils/box-name-generator'
import { BoxSnapshotService, SNAPSHOT_ADMISSION_LOCK_NAMESPACE } from './box-snapshot.service'
import { BoxSnapshotSettler } from './box-snapshot-settler.service'
import { JobService } from './job.service'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `box_snapshot_${process.pid}_${randomUUID().replaceAll('-', '')}`
const organizationId = '00000000-0000-4000-8000-0000000000ff'
const runnerId = '00000000-0000-4000-8000-00000000000a'
const prefix = 'gs://snapshots/box-snapshots/'

function stoppedBox(name: string, overrides: Partial<Box> = {}): Box {
  const box = new Box('us', name)
  box.organizationId = organizationId
  box.osUser = 'boxlite'
  box.runnerId = runnerId
  box.state = BoxState.STOPPED
  box.desiredState = BoxDesiredState.STOPPED
  box.pending = false
  box.disk = 10
  Object.assign(box, overrides)
  return box
}

describeIfDatabase('BoxSnapshotService and BoxSnapshotSettler (integration, real Postgres)', () => {
  let dataSource: DataSource
  let boxes: Repository<Box>
  let snapshots: Repository<BoxSnapshot>
  let restores: Repository<BoxSnapshotRestore>
  let jobs: Repository<Job>
  let runners: Repository<Runner>
  let notifications: { lpush: jest.Mock }
  let events: { emit: jest.Mock }
  let service: BoxSnapshotService
  let boxRepository: BoxRepository
  let settler: BoxSnapshotSettler
  let archiveStore: { delete: jest.Mock }
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
      entities: [Box, BoxLastActivity, BoxMigration, BoxSnapshot, BoxSnapshotRestore, Job, Runner],
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
    snapshots = dataSource.getRepository(BoxSnapshot)
    restores = dataSource.getRepository(BoxSnapshotRestore)
    jobs = dataSource.getRepository(Job)
    runners = dataSource.getRepository(Runner)
    notifications = { lpush: jest.fn() }
    events = { emit: jest.fn() }

    boxRepository = new BoxRepository(
      dataSource,
      events as any,
      { invalidate: jest.fn(), invalidateOrgId: jest.fn() } as any,
    )
    const boxService = {
      findOneByIdOrName: (id: string) => boxes.findOneByOrFail({ id }),
    }
    const jobService = new JobService(jobs, notifications as any, {} as any)
    const config: Record<string, unknown> = {
      'boxSnapshot.archivePrefix': prefix,
      'boxSnapshot.maxPerOrganization': 3,
    }
    service = new BoxSnapshotService(dataSource, boxRepository, boxService as any, jobService, {
      get: (key: string) => config[key],
    } as any)
    archiveStore = { delete: jest.fn().mockResolvedValue(undefined) }
    settler = new BoxSnapshotSettler(
      dataSource,
      boxRepository,
      { lock: jest.fn().mockResolvedValue(true), unlock: jest.fn() } as any,
      archiveStore,
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
    archiveStore.delete.mockClear()
    await dataSource.query(`DELETE FROM "${schemaName}"."box_snapshot_restore"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."box_snapshot"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."job"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."box_migration"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."box_last_activity"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."box"`)
    await runners.clear()
    await runners.insert({
      id: runnerId,
      region: 'us',
      name: 'snapshot-runner',
      apiKey: 'integration-test-only',
      apiUrl: 'http://runner.invalid',
      apiVersion: '2',
    })
    notifications.lpush.mockClear()
    events.emit.mockClear()
  })

  async function insert(box: Box): Promise<Box> {
    await boxes.insert(box)
    return boxes.findOneByOrFail({ id: box.id })
  }

  /** Report a job finished the way the runner would, then settle it. */
  async function finish(jobId: string, status: JobStatus, resultMetadata?: object, errorMessage?: string) {
    await jobs.update(
      { id: jobId },
      {
        status,
        completedAt: new Date(),
        resultMetadata: resultMetadata ? JSON.stringify(resultMetadata) : null,
        errorMessage,
      },
    )
    await settler.settle(await jobs.findOneByOrFail({ id: jobId }))
  }

  it('stores snapshots only where an archive prefix is configured', () => {
    const noPrefix = { get: () => undefined } as any
    const unconfigured = new BoxSnapshotService(dataSource, {} as any, {} as any, {} as any, noPrefix)

    expect(service.isEnabled()).toBe(true)
    expect(unconfigured.isEnabled()).toBe(false)
  })

  it('gives later archives a turn when an entire cleanup batch keeps failing', async () => {
    const rows = Array.from({ length: 101 }, (_, index) =>
      snapshots.create({
        id: randomUUID(),
        organizationId,
        name: `cleanup-${index}`,
        sourceBoxId: 'gone-source',
        region: 'us',
        diskGb: 10,
        state: BoxSnapshotState.DELETING,
        archiveUri: `${prefix}cleanup-${index}`,
        updatedAt: new Date(1000 + index),
      }),
    )
    await snapshots.insert(rows)
    const eligible = rows[100]
    archiveStore.delete.mockImplementation(async (uri: string) => {
      if (uri !== eligible.archiveUri) throw new Error('archive temporarily unavailable')
    })
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    try {
      await settler.reconcile()
      await settler.reconcile()
      expect(archiveStore.delete).toHaveBeenCalledWith(eligible.archiveUri)
      expect(await snapshots.existsBy({ id: eligible.id })).toBe(false)
      expect(await snapshots.count()).toBe(100)
      expect(await snapshots.findOneByOrFail({ id: rows[0].id })).toMatchObject({
        state: BoxSnapshotState.DELETING,
        archiveUri: rows[0].archiveUri,
      })
    } finally {
      log.mockRestore()
      archiveStore.delete.mockReset().mockResolvedValue(undefined)
    }
  })

  it('rotates a failing completion batch even when one retry timestamp cannot be written', async () => {
    const box = await insert(stoppedBox('later-source', { state: BoxState.EXPORTING }))
    const completed = Array.from({ length: 101 }, (_, index) => {
      const job = new Job({
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        type: JobType.CREATE_SNAPSHOT,
        status: JobStatus.COMPLETED,
        runnerId,
        resourceType: ResourceType.BOX,
        resourceId: index === 100 ? box.id : 'gone-source',
        completedAt: new Date(),
      })
      job.updatedAt = new Date(1000 + index)
      return job
    })
    await jobs.insert(completed)
    const waiting = completed.map((job, index) =>
      snapshots.create({
        id: randomUUID(),
        organizationId,
        name: index === 100 ? 'eligible' : `blocked-${index}`,
        sourceBoxId: job.resourceId,
        region: 'us',
        diskGb: 10,
        state: BoxSnapshotState.CREATING,
        jobId: job.id,
        archiveUri: '',
      }),
    )
    await snapshots.insert(waiting)
    await dataSource.query(`CREATE FUNCTION "${schemaName}".reject_settlement() RETURNS trigger AS $$
      BEGIN IF NEW.name LIKE 'blocked-%' THEN RAISE EXCEPTION 'settlement unavailable'; END IF;
      RETURN NEW; END; $$ LANGUAGE plpgsql`)
    await dataSource.query(`CREATE TRIGGER reject_settlement BEFORE UPDATE ON "${schemaName}".box_snapshot
      FOR EACH ROW EXECUTE FUNCTION "${schemaName}".reject_settlement()`)
    await dataSource.query(`CREATE FUNCTION "${schemaName}".reject_rotation() RETURNS trigger AS $$
      BEGIN IF NEW.id = '00000000-0000-4000-8000-000000000001' THEN RAISE EXCEPTION 'rotation unavailable'; END IF;
      RETURN NEW; END; $$ LANGUAGE plpgsql`)
    await dataSource.query(`CREATE TRIGGER reject_rotation BEFORE UPDATE ON "${schemaName}".job
      FOR EACH ROW EXECUTE FUNCTION "${schemaName}".reject_rotation()`)
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    try {
      await settler.reconcile()
      await settler.reconcile()
      expect((await snapshots.findOneByOrFail({ id: waiting[100].id })).state).toBe(BoxSnapshotState.READY)
      expect((await boxes.findOneByOrFail({ id: box.id })).state).toBe(BoxState.STOPPED)
      expect(await snapshots.countBy({ state: BoxSnapshotState.CREATING })).toBe(100)
      await dataSource.query(`DROP TRIGGER reject_settlement ON "${schemaName}".box_snapshot`)
      await dataSource.query(`DROP TRIGGER reject_rotation ON "${schemaName}".job`)
      await settler.reconcile()
      expect(await snapshots.countBy({ state: BoxSnapshotState.CREATING })).toBe(0)
      expect(await snapshots.countBy({ state: BoxSnapshotState.FAILED })).toBe(100)
    } finally {
      await dataSource.query(`DROP TRIGGER IF EXISTS reject_settlement ON "${schemaName}".box_snapshot`)
      await dataSource.query(`DROP TRIGGER IF EXISTS reject_rotation ON "${schemaName}".job`)
      await dataSource.query(`DROP FUNCTION "${schemaName}".reject_settlement()`)
      await dataSource.query(`DROP FUNCTION "${schemaName}".reject_rotation()`)
      log.mockRestore()
    }
  })

  it.each(['capture', 'restore'])('persists a decoded NUL in a %s failure safely', async (operation) => {
    const source = await insert(stoppedBox('nul-source'))
    const snapshot = await service.create(source.id, 'nul-snapshot', organizationId)
    let record: BoxSnapshot | BoxSnapshotRestore = snapshot
    if (operation === 'restore') {
      await finish(snapshot.jobId, JobStatus.COMPLETED, { sizeBytes: 1 })
      record = await service.restore(source.id, snapshot.name, organizationId)
    }
    await jobs.update(record.jobId, {
      status: JobStatus.FAILED,
      completedAt: new Date(),
      errorMessage: JSON.stringify({ errorReason: 'failed\0disk', recoverable: false }),
    })
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    try {
      await settler.reconcile()
      const failed =
        operation === 'restore'
          ? await restores.findOneByOrFail({ id: record.id })
          : await snapshots.findOneByOrFail({ id: record.id })
      expect(failed).toMatchObject({ state: 'failed', errorReason: 'failed\\0disk' })
      expect((await boxes.findOneByOrFail({ id: source.id })).state).toBe(BoxState.STOPPED)
    } finally {
      log.mockRestore()
    }
  })

  it('records the snapshot, its job and the EXPORTING box in one step', async () => {
    const box = await insert(stoppedBox('source'))

    const snapshot = await service.create(box.id, 'golden', organizationId)

    expect(snapshot).toMatchObject({
      state: BoxSnapshotState.CREATING,
      sourceBoxId: box.id,
      diskGb: 10,
      archiveUri: `${prefix}${organizationId}/${snapshot.id}.boxlite`,
    })
    const job = await jobs.findOneByOrFail({ id: snapshot.jobId })
    expect(job).toMatchObject({
      type: JobType.CREATE_SNAPSHOT,
      resourceType: ResourceType.BACKUP,
      resourceId: box.id,
      runnerId,
    })
    expect(JSON.parse(job.payload)).toEqual({ archiveUri: snapshot.archiveUri })
    expect(notifications.lpush).toHaveBeenCalledWith(expect.any(String), job.id)
    expect(events.emit).toHaveBeenCalledWith(
      BoxEvents.STATE_UPDATED,
      expect.objectContaining({ oldState: BoxState.STOPPED, newState: BoxState.EXPORTING }),
    )
    // pending stays false: deleting the box must still be accepted.
    expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({
      state: BoxState.EXPORTING,
      desiredState: BoxDesiredState.STOPPED,
      pending: false,
    })
  })

  it.each([undefined, '', '   '])('generates a snapshot name when supplied %j', async (name) => {
    const source = await insert(stoppedBox('default-name'))
    const snapshot = await service.create(source.id, name, organizationId)
    expect(snapshot.name).toMatch(/^[a-z]+-[a-z]+$/)
    expect(snapshot.name).not.toBe(source.name)
  })

  it.each([JobStatus.COMPLETED, JobStatus.FAILED])(
    'keeps a generated name collision after %s intact',
    async (status) => {
      const source = await insert(stoppedBox('source'))
      const previous = await service.create(source.id, 'cozy-otter', organizationId)
      await finish(previous.jobId, status, { sizeBytes: 1 }, 'export failed')
      const generate = jest.spyOn(boxNames, 'generateBoxName').mockReturnValue('cozy-otter')
      try {
        const created = await service.create(source.id, undefined, organizationId)
        expect(created.name).toBe(`cozy-otter-${created.id}`)
        expect((await snapshots.findOneByOrFail({ id: previous.id })).state).toBe(
          status === JobStatus.COMPLETED ? BoxSnapshotState.READY : BoxSnapshotState.FAILED,
        )
      } finally {
        generate.mockRestore()
      }
    },
  )

  async function readySnapshot() {
    const source = await insert(stoppedBox('source'))
    const snapshot = await service.create(source.id, 'golden', organizationId)
    await finish(snapshot.jobId, JobStatus.COMPLETED, { sizeBytes: 1 })
    return snapshot
  }

  it('rejects a UUID-shaped name before it can shadow another snapshot ID', async () => {
    const snapshot = await readySnapshot()
    const box = await insert(stoppedBox('uuid-name'))
    await expect(service.create(box.id, snapshot.id, organizationId)).rejects.toThrow(HttpException)
    expect(await snapshots.count()).toBe(1)
  })

  it.each(Object.values(BoxMigrationState))(
    'admits only completed migrations for snapshot operations: %s',
    async (state) => {
      const snapshot = await readySnapshot()
      const box = await insert(stoppedBox('migrated'))
      await dataSource.getRepository(BoxMigration).insert({ boxId: box.id, state, updatedAt: box.updatedAt })
      if (state !== BoxMigrationState.COMPLETED) {
        await expect(service.create(box.id, 'migrated', organizationId)).rejects.toThrow(/being moved/)
        await expect(service.restore(box.id, snapshot.id, organizationId)).rejects.toThrow(/being moved/)
        return
      }
      const created = await service.create(box.id, 'migrated', organizationId)
      await finish(created.jobId, JobStatus.COMPLETED)
      await expect(service.restore(box.id, snapshot.id, organizationId)).resolves.toMatchObject({ boxId: box.id })
    },
  )

  it('releases failed children beyond a batch of active create jobs', async () => {
    const snapshot = await readySnapshot()
    for (let index = 0; index < 100; index++) {
      const child = await insert(childBox(snapshot.id, `active-${index}`))
      await boxes.update(child.id, { state: BoxState.ERROR })
      await jobs.insert(
        new Job({ type: JobType.CREATE_BOX, runnerId, resourceType: ResourceType.BOX, resourceId: child.id }),
      )
    }
    const eligible = await insert(childBox(snapshot.id, 'eligible'))
    await boxes.update(eligible.id, { state: BoxState.ERROR })
    await settler.reconcile()
    expect((await boxes.findOneByOrFail({ id: eligible.id })).initialSnapshotId).toBeNull()
    expect(await boxes.countBy({ initialSnapshotId: snapshot.id })).toBe(100)
  })

  it('warns when archive cleanup is pending without a store', async () => {
    const snapshot = await readySnapshot()
    await service.remove(organizationId, snapshot.id)
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    try {
      const disabled = new BoxSnapshotSettler(
        dataSource,
        boxRepository,
        { lock: async () => true, unlock: async () => undefined } as any,
        null,
      )
      await disabled.reconcile()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('archive cleanup'))
      expect(await snapshots.findOneBy({ id: snapshot.id })).not.toBeNull()
    } finally {
      warn.mockRestore()
    }
  })

  function childBox(snapshotId: string, name = 'child') {
    return stoppedBox(name, {
      initialSnapshotId: snapshotId,
      state: BoxState.UNKNOWN,
      desiredState: BoxDesiredState.STARTED,
    })
  }

  it('pins a snapshot until its child starts and then allows deletion', async () => {
    const snapshot = await readySnapshot()
    const child = await boxRepository.insert(childBox(snapshot.id))
    await expect(service.remove(organizationId, snapshot.id)).rejects.toThrow(/used to create/)

    await boxRepository.update(child.id, { updateData: { state: BoxState.STARTED } })
    expect((await boxes.findOneByOrFail({ id: child.id })).initialSnapshotId).toBeNull()
    await service.remove(organizationId, snapshot.id)
  })

  it('admits snapshot children under the ordinary concurrent box quota', async () => {
    const snapshot = await readySnapshot()
    const outcomes = await Promise.allSettled(
      ['one', 'two'].map((name) => boxRepository.insert(childBox(snapshot.id, name), 2)),
    )
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(await boxes.count()).toBe(2)
  })

  it('cannot delete a snapshot concurrently with admitting a dependent child', async () => {
    const snapshot = await readySnapshot()
    const child = childBox(snapshot.id)
    const outcomes = await Promise.allSettled([
      boxRepository.insert(child),
      service.remove(organizationId, snapshot.id),
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const persistedChild = await boxes.findOneBy({ id: child.id })
    const persistedSnapshot = await snapshots.findOneByOrFail({ id: snapshot.id })
    expect(persistedSnapshot.state).toBe(persistedChild ? BoxSnapshotState.READY : BoxSnapshotState.DELETING)
  })

  it.each([{ organizationId: '00000000-0000-4000-8000-000000000001' }, { region: 'eu' }, { disk: 20 }])(
    'refuses an incompatible snapshot child %j without inserting it',
    async (overrides) => {
      const snapshot = await readySnapshot()
      const child = childBox(snapshot.id)
      Object.assign(child, overrides)
      await expect(boxRepository.insert(child)).rejects.toThrow(ConflictException)
      expect(await boxes.findOneBy({ id: child.id })).toBeNull()
    },
  )

  it('releases a failed child only after its creation job is terminal', async () => {
    const snapshot = await readySnapshot()
    const child = await boxRepository.insert(childBox(snapshot.id))
    const job = new Job({
      type: JobType.CREATE_BOX,
      runnerId,
      resourceType: ResourceType.BOX,
      resourceId: child.id,
      status: JobStatus.IN_PROGRESS,
    })
    await jobs.save(job)
    await boxRepository.update(child.id, { updateData: { state: BoxState.ERROR, recoverable: true } })
    await settler.reconcile()
    expect((await boxes.findOneByOrFail({ id: child.id })).initialSnapshotId).toBe(snapshot.id)

    await jobs.update(job.id, { status: JobStatus.FAILED })
    await settler.reconcile()
    expect(await boxes.findOneByOrFail({ id: child.id })).toMatchObject({ initialSnapshotId: null, recoverable: false })
  })

  it('refuses a box that is not stopped and leaves nothing behind', async () => {
    const box = await insert(stoppedBox('running', { state: BoxState.STARTED, desiredState: BoxDesiredState.STARTED }))

    await expect(service.create(box.id, 'golden', organizationId)).rejects.toBeInstanceOf(ConflictException)

    expect(await snapshots.count()).toBe(0)
    expect(await jobs.count()).toBe(0)
  })

  it('refuses a second operation on a box that is already exporting', async () => {
    const box = await insert(stoppedBox('busy'))
    await service.create(box.id, 'first', organizationId)

    await expect(service.create(box.id, 'second', organizationId)).rejects.toThrow(/is exporting a snapshot/)
  })

  it('makes a finished export ready, returns the box, and ignores a redelivery', async () => {
    const box = await insert(stoppedBox('exported'))
    const snapshot = await service.create(box.id, 'golden', organizationId)

    await finish(snapshot.jobId, JobStatus.COMPLETED, { sizeBytes: 4096 })
    await settler.settle(await jobs.findOneByOrFail({ id: snapshot.jobId }))

    expect(await snapshots.findOneByOrFail({ id: snapshot.id })).toMatchObject({
      state: BoxSnapshotState.READY,
      sizeBytes: 4096,
    })
    expect((await boxes.findOneByOrFail({ id: box.id })).state).toBe(BoxState.STOPPED)
  })

  it('fails an export whose box was deleted meanwhile, even if the runner finished it', async () => {
    const box = await insert(stoppedBox('deleted-mid-export'))
    const snapshot = await service.create(box.id, 'golden', organizationId)
    await boxes.update({ id: box.id }, { ...Box.getSoftDeleteUpdate(box) })

    await finish(snapshot.jobId, JobStatus.COMPLETED, { sizeBytes: 4096 })

    expect(await snapshots.findOneByOrFail({ id: snapshot.id })).toMatchObject({
      state: BoxSnapshotState.FAILED,
      errorReason: 'The box was deleted while it was being exported',
    })
    // The deletion owns the box now; settling must not stop it.
    expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({
      state: BoxState.EXPORTING,
      desiredState: BoxDesiredState.DESTROYED,
    })
  })

  it('accepts deleting a box mid-export', async () => {
    const box = await insert(stoppedBox('deletable'))
    await service.create(box.id, 'golden', organizationId)
    const exporting = await boxes.findOneByOrFail({ id: box.id })

    const repository = new BoxRepository(
      dataSource,
      { emit: jest.fn() } as any,
      {
        invalidate: jest.fn(),
        invalidateOrgId: jest.fn(),
      } as any,
    )
    const deleted = await repository.updateWhere(box.id, {
      updateData: Box.getSoftDeleteUpdate(exporting),
      whereCondition: { pending: false, state: BoxState.EXPORTING },
    })

    expect(deleted).toMatchObject({ desiredState: BoxDesiredState.DESTROYED, pending: true })
  })

  it('restores a ready snapshot into another stopped box of the same size', async () => {
    const source = await insert(stoppedBox('source'))
    const target = await insert(stoppedBox('target'))
    const snapshot = await service.create(source.id, 'golden', organizationId)
    await finish(snapshot.jobId, JobStatus.COMPLETED, { sizeBytes: 1 })
    notifications.lpush.mockClear()
    events.emit.mockClear()

    const restore = await service.restore(target.id, 'golden', organizationId)

    expect(restore.state).toBe(BoxSnapshotRestoreState.PENDING)
    const job = await jobs.findOneByOrFail({ id: restore.jobId })
    expect(job).toMatchObject({ type: JobType.RESTORE_SNAPSHOT, resourceId: target.id })
    expect(notifications.lpush).toHaveBeenCalledWith(expect.any(String), job.id)
    expect(events.emit).toHaveBeenCalledWith(
      BoxEvents.STATE_UPDATED,
      expect.objectContaining({ oldState: BoxState.STOPPED, newState: BoxState.IMPORTING }),
    )
    expect(JSON.parse(job.payload)).toEqual({ archiveUri: snapshot.archiveUri })
    expect((await boxes.findOneByOrFail({ id: target.id })).state).toBe(BoxState.IMPORTING)

    // A snapshot a restore is reading cannot be deleted under it.
    await expect(service.remove(organizationId, 'golden')).rejects.toThrow(/being restored/)

    await finish(restore.jobId, JobStatus.FAILED, undefined, 'archive checksum mismatch')

    expect(await restores.findOneByOrFail({ id: restore.id })).toMatchObject({
      state: BoxSnapshotRestoreState.FAILED,
      errorReason: 'archive checksum mismatch',
    })
    expect((await boxes.findOneByOrFail({ id: target.id })).state).toBe(BoxState.STOPPED)
  })

  it('fails a restore whose box was deleted meanwhile, even if the runner finished it', async () => {
    const source = await insert(stoppedBox('source'))
    const target = await insert(stoppedBox('deleted-mid-restore'))
    const snapshot = await service.create(source.id, 'golden', organizationId)
    await finish(snapshot.jobId, JobStatus.COMPLETED, { sizeBytes: 1 })
    const restore = await service.restore(target.id, 'golden', organizationId)
    const importing = await boxes.findOneByOrFail({ id: target.id })
    await boxes.update({ id: target.id }, { ...Box.getSoftDeleteUpdate(importing) })

    await finish(restore.jobId, JobStatus.COMPLETED)

    expect(await restores.findOneByOrFail({ id: restore.id })).toMatchObject({
      state: BoxSnapshotRestoreState.FAILED,
      errorReason: 'The box was deleted while its disk was being restored',
    })
    // The deletion owns the box now; settling must not stop it.
    expect(await boxes.findOneByOrFail({ id: target.id })).toMatchObject({
      state: BoxState.IMPORTING,
      desiredState: BoxDesiredState.DESTROYED,
    })
  })

  it('finds a restore only under the box it restores into', async () => {
    const source = await insert(stoppedBox('source'))
    const target = await insert(stoppedBox('target'))
    const snapshot = await service.create(source.id, 'golden', organizationId)
    await finish(snapshot.jobId, JobStatus.COMPLETED, { sizeBytes: 1 })
    const restore = await service.restore(target.id, 'golden', organizationId)

    expect((await service.getRestore(target.id, restore.id, organizationId)).id).toBe(restore.id)
    await expect(service.getRestore(source.id, restore.id, organizationId)).rejects.toThrow(NotFoundException)
    await expect(service.getRestore(target.id, 'not-a-uuid', organizationId)).rejects.toThrow(NotFoundException)
  })

  it('lists the snapshots of one box or of the organization, never those being deleted', async () => {
    const first = await insert(stoppedBox('first'))
    const second = await insert(stoppedBox('second'))
    const kept = await service.create(first.id, 'kept', organizationId)
    await finish(kept.jobId, JobStatus.COMPLETED, { sizeBytes: 1 })
    const removed = await service.create(first.id, 'removed', organizationId)
    await finish(removed.jobId, JobStatus.COMPLETED, { sizeBytes: 1 })
    await service.remove(organizationId, 'removed')
    await service.create(second.id, 'other', organizationId)

    const fromFirst = await service.list(organizationId, { sourceBoxId: first.id })
    const everything = await service.list(organizationId)

    expect(fromFirst.map((snapshot) => snapshot.name)).toEqual(['kept'])
    expect(everything.map((snapshot) => snapshot.name).sort()).toEqual(['kept', 'other'])
  })

  it('refuses a restore into a box of another disk size', async () => {
    const source = await insert(stoppedBox('source'))
    const target = await insert(stoppedBox('bigger', { disk: 20 }))
    const snapshot = await service.create(source.id, 'golden', organizationId)
    await finish(snapshot.jobId, JobStatus.COMPLETED, { sizeBytes: 1 })

    await expect(service.restore(target.id, snapshot.id, organizationId)).rejects.toThrow(/10 GiB disk/)
    expect((await boxes.findOneByOrFail({ id: target.id })).state).toBe(BoxState.STOPPED)
  })

  it('refuses a restore into a box of another region', async () => {
    const source = await insert(stoppedBox('source'))
    const target = await insert(stoppedBox('elsewhere', { region: 'eu' }))
    const snapshot = await service.create(source.id, 'golden', organizationId)
    await finish(snapshot.jobId, JobStatus.COMPLETED, { sizeBytes: 1 })

    await expect(service.restore(target.id, snapshot.id, organizationId)).rejects.toThrow(/stored for region us/)
    expect((await boxes.findOneByOrFail({ id: target.id })).state).toBe(BoxState.STOPPED)
    expect(await restores.count()).toBe(0)
  })

  // The REST routes answer each of these refusals with 409.
  it('refuses a second live snapshot under one name, leaving the box as it was', async () => {
    const first = await insert(stoppedBox('first'))
    const second = await insert(stoppedBox('second'))
    await service.create(first.id, 'golden', organizationId)

    await expect(service.create(second.id, 'golden', organizationId)).rejects.toThrow(/named golden already exists/)
    expect((await boxes.findOneByOrFail({ id: second.id })).state).toBe(BoxState.STOPPED)
    expect(await jobs.count({ where: { resourceId: second.id } })).toBe(0)
  })

  it('refuses to delete or restore a snapshot still being created', async () => {
    const source = await insert(stoppedBox('source'))
    const target = await insert(stoppedBox('target'))
    await service.create(source.id, 'golden', organizationId)

    await expect(service.remove(organizationId, 'golden')).rejects.toThrow(/still being created/)
    await expect(service.restore(target.id, 'golden', organizationId)).rejects.toThrow(/only a ready snapshot/)
    expect((await boxes.findOneByOrFail({ id: target.id })).state).toBe(BoxState.STOPPED)
  })

  it.each(['capture', 'restore'].flatMap((operation) => ['0', '3', 'missing'].map((version) => [operation, version])))(
    'refuses %s on runner protocol %s without mutations or notifications',
    async (operation, version) => {
      const box = await insert(stoppedBox('protocol-target'))
      if (operation === 'restore') {
        const snapshot = await service.create(box.id, 'protocol-snapshot', organizationId)
        await finish(snapshot.jobId, JobStatus.COMPLETED, { sizeBytes: 1 })
      }
      if (version === 'missing') await runners.delete(runnerId)
      else await runners.update(runnerId, { apiVersion: version })
      notifications.lpush.mockClear()
      events.emit.mockClear()
      const before = {
        snapshots: await snapshots.count(),
        restores: await restores.count(),
        jobs: await jobs.count(),
      }

      const request =
        operation === 'capture'
          ? service.create(box.id, 'protocol-snapshot', organizationId)
          : service.restore(box.id, 'protocol-snapshot', organizationId)
      await expect(request).rejects.toThrow(ConflictException)

      expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({
        state: BoxState.STOPPED,
        desiredState: BoxDesiredState.STOPPED,
        pending: false,
      })
      expect(await snapshots.count()).toBe(before.snapshots)
      expect(await restores.count()).toBe(before.restores)
      expect(await jobs.count()).toBe(before.jobs)
      expect(notifications.lpush).not.toHaveBeenCalled()
      expect(events.emit).not.toHaveBeenCalled()
    },
  )

  it('refuses a box no runner holds', async () => {
    const box = await insert(stoppedBox('unplaced', { runnerId: undefined }))

    await expect(service.create(box.id, 'golden', organizationId)).rejects.toThrow(/no runner holding its disk/)
    expect(await snapshots.count()).toBe(0)
  })

  it('caps the snapshots an organization keeps', async () => {
    for (const name of ['a', 'b', 'c']) {
      const box = await insert(stoppedBox(`box-${name}`))
      await service.create(box.id, name, organizationId)
    }
    const fourth = await insert(stoppedBox('box-d'))

    const refusal = await service.create(fourth.id, 'd', organizationId).catch((error) => error)

    expect(refusal).toBeInstanceOf(HttpException)
    expect((refusal as HttpException).getStatus()).toBe(429)
  })

  it('holds the cap when one organization creates snapshots concurrently', async () => {
    for (const name of ['a', 'b']) {
      const box = await insert(stoppedBox(`kept-${name}`))
      await service.create(box.id, name, organizationId)
    }
    const racers = await Promise.all(['c', 'd', 'e', 'f'].map((name) => insert(stoppedBox(`racer-${name}`))))

    const outcomes = await Promise.allSettled(
      racers.map((box, index) => service.create(box.id, `race-${index}`, organizationId)),
    )

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(await snapshots.count({ where: { organizationId } })).toBe(3)
    for (const outcome of outcomes.filter((outcome) => outcome.status === 'rejected')) {
      expect(((outcome as PromiseRejectedResult).reason as HttpException).getStatus()).toBe(429)
    }
  })

  it('admits another box while a capture waits for a locked box row', async () => {
    const blockedBox = await insert(stoppedBox('blocked-source'))
    const independentBox = await insert(stoppedBox('independent-source'))
    const holder = dataSource.createQueryRunner()
    let blockedCapture: Promise<PromiseSettledResult<BoxSnapshot>> | undefined
    await holder.connect()
    await holder.startTransaction()
    try {
      await holder.manager.findOneOrFail(Box, {
        where: { id: blockedBox.id },
        lock: { mode: 'pessimistic_write' },
      })
      const [{ pid }] = await holder.query('SELECT pg_backend_pid() AS pid')
      blockedCapture = service.create(blockedBox.id, 'blocked', organizationId).then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ status: 'rejected', reason }),
      )

      // Observe the real row wait before starting the unrelated capture.
      const deadline = Date.now() + 3_000
      let blocked = false
      while (!blocked && Date.now() < deadline) {
        ;[{ blocked }] = await dataSource.query(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'
               AND $1 = ANY(pg_blocking_pids(pid))
           ) AS blocked`,
          [pid],
        )
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(blocked).toBe(true)

      const independentCapture = service.create(independentBox.id, 'independent', organizationId)
      await expect(independentCapture).resolves.toMatchObject({
        sourceBoxId: independentBox.id,
        state: BoxSnapshotState.CREATING,
      })
      const independent = await independentCapture
      expect(notifications.lpush).toHaveBeenCalledWith(expect.any(String), independent.jobId)
      expect(events.emit).toHaveBeenCalledWith(
        BoxEvents.STATE_UPDATED,
        expect.objectContaining({ oldState: BoxState.STOPPED, newState: BoxState.EXPORTING }),
      )
      expect((await boxes.findOneByOrFail({ id: blockedBox.id })).state).toBe(BoxState.STOPPED)
      expect(await snapshots.countBy({ sourceBoxId: blockedBox.id })).toBe(0)
      expect(await jobs.countBy({ resourceId: blockedBox.id })).toBe(0)
    } finally {
      try {
        await holder.rollbackTransaction()
      } finally {
        await holder.release()
        await blockedCapture
      }
    }
    expect(await blockedCapture).toMatchObject({
      status: 'fulfilled',
      value: { sourceBoxId: blockedBox.id, state: BoxSnapshotState.CREATING },
    })
  }, 15_000)

  it('refuses a create, retryably, while the organization lock stays held', async () => {
    const box = await insert(stoppedBox('contended'))
    const holder = dataSource.createQueryRunner()
    await holder.connect()
    await holder.startTransaction()
    try {
      await holder.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
        SNAPSHOT_ADMISSION_LOCK_NAMESPACE,
        organizationId,
      ])

      const refusal = await service.create(box.id, 'golden', organizationId).catch((error) => error)

      // The contract's retryable code, as box admission answers when busy.
      expect(refusal).toBeInstanceOf(HttpException)
      expect((refusal as HttpException).getStatus()).toBe(503)
      expect((refusal as HttpException).getResponse()).toMatchObject({ code: 'upstream_unavailable' })
      expect(await snapshots.count({ where: { organizationId } })).toBe(0)
      expect((await boxes.findOneByOrFail({ id: box.id })).state).toBe(BoxState.STOPPED)
      expect(notifications.lpush).not.toHaveBeenCalled()
      expect(events.emit).not.toHaveBeenCalled()
    } finally {
      await holder.rollbackTransaction()
      await holder.release()
    }
  }, 20_000)

  it('lets a retry reuse the name of a failed snapshot', async () => {
    const box = await insert(stoppedBox('retried'))
    const failed = await service.create(box.id, 'golden', organizationId)
    await finish(failed.jobId, JobStatus.FAILED, undefined, 'disk full')

    const retried = await service.create(box.id, 'golden', organizationId)

    expect(retried.id).not.toBe(failed.id)
    expect((await snapshots.findOneByOrFail({ id: failed.id })).state).toBe(BoxSnapshotState.DELETING)
  })

  it('settles a finished job whose completion never arrived', async () => {
    const box = await insert(stoppedBox('lost-callback'))
    const snapshot = await service.create(box.id, 'golden', organizationId)
    await jobs.update(
      { id: snapshot.jobId },
      { status: JobStatus.COMPLETED, completedAt: new Date(), resultMetadata: '{"sizeBytes":7}' },
    )

    await settler.reconcile()

    expect((await snapshots.findOneByOrFail({ id: snapshot.id })).state).toBe(BoxSnapshotState.READY)
    expect((await boxes.findOneByOrFail({ id: box.id })).state).toBe(BoxState.STOPPED)
  })

  // The sync loop leaves a held box to its job, so nothing else would free a
  // box whose runner never claims the job.
  it('fails an operation no runner claimed in time and frees its box', async () => {
    const source = await insert(stoppedBox('source'))
    const target = await insert(stoppedBox('runner-gone'))
    const ready = await service.create(source.id, 'golden', organizationId)
    await finish(ready.jobId, JobStatus.COMPLETED, { sizeBytes: 1 })
    const abandoned = await service.create(target.id, 'abandoned', organizationId)
    await jobs.update({ id: abandoned.jobId }, { createdAt: new Date(Date.now() - 11 * 60 * 1000) })
    const fresh = await service.restore(source.id, 'golden', organizationId)

    await settler.reconcile()

    expect(await snapshots.findOneByOrFail({ id: abandoned.id })).toMatchObject({
      state: BoxSnapshotState.FAILED,
      errorReason: 'No runner picked up the job within 10 minutes',
    })
    expect((await boxes.findOneByOrFail({ id: target.id })).state).toBe(BoxState.STOPPED)
    // A job queued moments ago is still its runner's to claim.
    expect((await jobs.findOneByOrFail({ id: fresh.jobId })).status).toBe(JobStatus.PENDING)
    expect((await boxes.findOneByOrFail({ id: source.id })).state).toBe(BoxState.IMPORTING)
  })

  it('removes a deleted snapshot archive before its row, and a failed one only of its archive', async () => {
    const box = await insert(stoppedBox('reaped'))
    const kept = await service.create(box.id, 'kept', organizationId)
    await finish(kept.jobId, JobStatus.FAILED, undefined, 'upload failed')
    const removed = await service.create(box.id, 'removed', organizationId)
    await finish(removed.jobId, JobStatus.COMPLETED, { sizeBytes: 1 })
    await service.remove(organizationId, 'removed')

    await settler.reconcile()

    expect(archiveStore.delete).toHaveBeenCalledWith(removed.archiveUri)
    expect(archiveStore.delete).toHaveBeenCalledWith(kept.archiveUri)
    expect(await snapshots.findOneBy({ id: removed.id })).toBeNull()
    expect(await snapshots.findOneByOrFail({ id: kept.id })).toMatchObject({
      state: BoxSnapshotState.FAILED,
      archiveUri: '',
    })
  })
})
