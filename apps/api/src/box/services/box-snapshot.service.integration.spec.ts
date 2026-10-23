/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException, HttpException, NotFoundException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { DataSource, Repository } from 'typeorm'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { BoxMigration } from '../entities/box-migration.entity'
import { BoxSnapshot } from '../entities/box-snapshot.entity'
import { BoxSnapshotRestore } from '../entities/box-snapshot-restore.entity'
import { Job } from '../entities/job.entity'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxSnapshotRestoreState } from '../enums/box-snapshot-restore-state.enum'
import { BoxSnapshotState } from '../enums/box-snapshot-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { BoxRepository } from '../repositories/box.repository'
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
  let service: BoxSnapshotService
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
      entities: [Box, BoxLastActivity, BoxMigration, BoxSnapshot, BoxSnapshotRestore, Job],
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

    const boxRepository = new BoxRepository(
      dataSource,
      { emit: jest.fn() } as any,
      { invalidate: jest.fn(), invalidateOrgId: jest.fn() } as any,
    )
    const boxService = {
      findOneByIdOrName: (id: string) => boxes.findOneByOrFail({ id }),
    }
    const jobService = new JobService(jobs, { lpush: jest.fn() } as any, {} as any)
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
    // pending stays false: deleting the box must still be accepted.
    expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({
      state: BoxState.EXPORTING,
      desiredState: BoxDesiredState.STOPPED,
      pending: false,
    })
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

    const restore = await service.restore(target.id, 'golden', organizationId)

    expect(restore.state).toBe(BoxSnapshotRestoreState.PENDING)
    const job = await jobs.findOneByOrFail({ id: restore.jobId })
    expect(job).toMatchObject({ type: JobType.RESTORE_SNAPSHOT, resourceId: target.id })
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
