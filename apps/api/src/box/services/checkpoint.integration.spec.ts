// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import { randomUUID } from 'node:crypto'
import { ConfigService } from '@nestjs/config'
import { DataSource, Repository } from 'typeorm'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { Box } from '../entities/box.entity'
import { BoxCheckpointState } from '../entities/box-checkpoint-state.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { Runner } from '../entities/runner.entity'
import { Checkpoint, CheckpointArchive } from '../entities/checkpoint.entity'
import { Job } from '../entities/job.entity'
import { RunnerState } from '../enums/runner-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { JobService } from './job.service'
import { CheckpointService } from './checkpoint.service'
import { CheckpointJobReceiver } from './checkpoint-job-receiver.service'
import { BoxMigration } from '../entities/box-migration.entity'
import { BoxMigrationState } from '../enums/box-migration-state.enum'
import { BoxliteCheckpointController } from '../../boxlite-rest/boxlite-checkpoint.controller'
import { CheckpointOperation } from '../entities/checkpoint-operation.entity'
import { CheckpointRecoverService } from './checkpoint-recover.service'
import { BoxRepository } from '../repositories/box.repository'
import { Organization } from '../../organization/entities/organization.entity'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { ServiceUnavailableException } from '@nestjs/common'
import { Image } from '../../image/entities/image.entity'
import { ImageVersion } from '../../image/entities/image-version.entity'
import { ImageAlias } from '../../image/entities/image-alias.entity'
import { ImageAliasEvent } from '../../image/entities/image-alias-event.entity'
import { ImageCatalogService } from '../../image/services/image-catalog.service'
import { catalogNameOf } from '../../image/utils/image-ref.util'
import { RegistryCredential } from '../../registry/entities/registry-credential.entity'
import { RegistriesService } from '../../registry/services/registries.service'
import { BoxService } from './box.service'
import { Context } from '../../common/context/context'
import { BoxManager } from '../managers/box.manager'
import { BoxEvents } from '../constants/box-events.constants'
import { BoxCreatedEvent } from '../events/box-create.event'

const describeWithDatabase = process.env.DB_HOST ? describe : describe.skip
const schema = `checkpoint_api_${process.pid}_${randomUUID().replaceAll('-', '')}`
const organizationId = randomUUID()
const otherOrganizationId = randomUUID()

describeWithDatabase('checkpoint create/export/upload (real PostgreSQL)', () => {
  let dataSource: DataSource
  let checkpoints: Repository<Checkpoint>
  let boxes: Repository<Box>
  let states: Repository<BoxCheckpointState>
  let jobs: Repository<Job>
  let runner: Runner
  let service: CheckpointService
  let receiver: CheckpointJobReceiver
  let recovery: CheckpointRecoverService
  let repository: BoxRepository
  const events = { emit: jest.fn(), emitAsync: jest.fn().mockResolvedValue([]) }
  const organization = { id: organizationId } as Organization
  const resourceLimits = { resolve: jest.fn() }
  const imageAdmission = { assert: jest.fn() }
  const runnerSelection = { getRandomAvailableRunner: jest.fn() }
  const archiveStore = { remove: jest.fn() }
  let settings: { archivePrefix?: string; maxPerOrganization: number; enabled?: boolean }
  const cache = { invalidate: jest.fn() }
  const uploadNotifications = { lpush: jest.fn() }

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema,
      entities: [
        Checkpoint,
        CheckpointOperation,
        BoxCheckpointState,
        Job,
        Box,
        BoxLastActivity,
        Runner,
        BoxMigration,
        Image,
        ImageVersion,
        ImageAlias,
        ImageAliasEvent,
        RegistryCredential,
      ],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      synchronize: false,
      extra: { options: `-c search_path=${schema},public` },
    }).initialize()
    await dataSource.query(`CREATE SCHEMA "${schema}"`)
    await dataSource.synchronize()
    checkpoints = dataSource.getRepository(Checkpoint)
    boxes = dataSource.getRepository(Box)
    states = dataSource.getRepository(BoxCheckpointState)
    jobs = dataSource.getRepository(Job)
    const jobService = new JobService(jobs, { lpush: jest.fn().mockResolvedValue(1) } as any, {} as any)
    const config = { get: (key: string) => (key === 'checkpoint' ? settings : undefined) } as ConfigService
    service = new CheckpointService(dataSource, config, jobService, cache as any, archiveStore as never)
    receiver = new CheckpointJobReceiver(
      dataSource,
      cache as never,
      events as unknown as EventEmitter2,
      uploadNotifications as never,
    )
    repository = new BoxRepository(dataSource, events as unknown as EventEmitter2, cache as any)
    recovery = new CheckpointRecoverService(
      service,
      jobService,
      { assertOrganizationIsNotSuspended: jest.fn() } as any,
      resourceLimits as any,
      imageAdmission as any,
      repository,
      runnerSelection as never,
      events as unknown as EventEmitter2,
    )
  })

  afterAll(async () => {
    if (!dataSource?.isInitialized) return
    try {
      await dataSource.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally {
      await dataSource.destroy()
    }
  })

  beforeEach(async () => {
    uploadNotifications.lpush.mockReset().mockResolvedValue(1)
    await dataSource.query(
      `TRUNCATE TABLE "${schema}"."checkpoint_operation", "${schema}"."checkpoint", "${schema}"."job", "${schema}"."box", "${schema}"."runner", "${schema}"."image", "${schema}"."registry_credential" CASCADE`,
    )
    settings = { archivePrefix: 'gs://checkpoint-tests/checkpoints/', maxPerOrganization: 10, enabled: true }
    runner = new Runner({
      region: 'us',
      name: 'runner',
      apiKey: 'fixture-key',
      apiVersion: '2',
      cpu: 64,
      memoryGiB: 128,
      diskGiB: 1000,
    })
    runner.state = RunnerState.READY
    await dataSource.getRepository(Runner).save(runner)
    cache.invalidate.mockClear()
    events.emit.mockClear()
    events.emitAsync.mockReset().mockResolvedValue([])
    resourceLimits.resolve.mockReset().mockResolvedValue({ maxCpuPerBox: 16, maxMemoryPerBox: 128, maxDiskPerBox: 100 })
    imageAdmission.assert.mockReset().mockResolvedValue(undefined)
    runnerSelection.getRandomAvailableRunner.mockReset().mockImplementation(async () => runner)
    archiveStore.remove.mockReset().mockResolvedValue(undefined)
  })

  // Read persisted coordination separately; service responses remain plain Boxes.
  async function withCheckpointState(box: Box) {
    const state = await states.findOneBy({ boxId: box.id })
    return { ...box, activeJobId: state?.activeJobId ?? null, sequence: state?.sequence ?? 0 }
  }

  function lifecycleService(): BoxService {
    return Object.assign(Object.create(BoxService.prototype), {
      findOneByIdOrName: (id: string, organizationId: string) => boxes.findOneByOrFail({ id, organizationId }),
      boxRepository: repository,
      eventEmitter: events,
      logger: { debug: jest.fn() },
    })
  }

  async function source(name = 'source'): Promise<Box> {
    const box = new Box('us', name)
    Object.assign(box, {
      organizationId,
      runnerId: runner.id,
      osUser: 'boxlite',
      state: BoxState.STOPPED,
      desiredState: BoxDesiredState.STOPPED,
      image: 'registry.example/app:tag',
      cpu: 4,
      mem: 8,
      disk: 12,
      env: { APP_ENV: 'test' },
      entrypoint: ['/app'],
      cmd: ['serve'],
      workingDir: '/work',
    })
    await boxes.save(box)
    return box
  }

  function archive(checkpoint: Checkpoint): CheckpointArchive {
    return {
      checkpointId: checkpoint.id,
      exportJobId: checkpoint.exportJobId!,
      sourceBoxId: checkpoint.sourceBoxId,
      arcPath: checkpoint.arcPath,
      sizeBytes: 1024,
      sha256: 'a'.repeat(64),
      pinnedImage: 'registry.example/app@sha256:' + 'b'.repeat(64),
    }
  }

  async function finish(jobId: string, result?: unknown, status = JobStatus.COMPLETED): Promise<Job> {
    await jobs.update(jobId, {
      status,
      completedAt: new Date(),
      ...(result ? { resultMetadata: JSON.stringify(result) } : {}),
    })
    const job = await jobs.findOneByOrFail({ id: jobId })
    await receiver.handleJobCompletion(job)
    return job
  }

  async function readyCheckpoint(image?: string, suffix = ''): Promise<Checkpoint> {
    const captured = await source(`captured${suffix}`)
    if (image) await boxes.update(captured.id, { image, imageIsOrgOwned: true })
    const checkpoint = await service.create(organizationId, captured.id, `ready-base${suffix}`)
    await finish(checkpoint.exportJobId!, archive(checkpoint))
    const uploading = await service.get(organizationId, checkpoint.id)
    await finish(uploading.activeJobId!, archive(checkpoint))
    return service.get(organizationId, checkpoint.id)
  }

  it('prefers the exact Box ID over a colliding name during capture', async () => {
    const target = await source('exact-source')
    const shadow = await source(target.id)
    await boxes.update(target.id, { name: 'updated-exact-source', env: { ROLE: 'exact-source' } })
    const captured = await service.create(organizationId, target.id, 'id-selected-source')
    expect(captured.sourceBoxId).toBe(target.id)
    expect(captured.environment.env).toEqual({ ROLE: 'exact-source' })
    expect(await jobs.findOneByOrFail({ id: captured.exportJobId! })).toMatchObject({ resourceId: target.id })
    expect((await boxes.findOneByOrFail({ id: shadow.id })).pending).toBe(false)
  })

  async function legacyCheckpointNameCollision() {
    const checkpoint = await readyCheckpoint()
    const id = randomUUID()
    const arcPath = `${settings.archivePrefix}${organizationId}/${id}/archive.boxlite`
    const shadow = await checkpoints.save(
      checkpoints.create({
        ...checkpoint,
        id,
        name: checkpoint.id,
        arcPath,
        archive: { ...checkpoint.archive!, checkpointId: id, arcPath },
      }),
    )
    // A normal update changes heap order; identifier precedence must not depend on it.
    await checkpoints.update(checkpoint.id, { updatedAt: new Date() })
    return { checkpoint, shadow }
  }

  it('prefers the exact checkpoint ID over a legacy colliding name when reading', async () => {
    const { checkpoint } = await legacyCheckpointNameCollision()
    expect((await service.get(organizationId, checkpoint.id)).id).toBe(checkpoint.id)
  })

  it('prefers the exact checkpoint ID over a legacy colliding name when importing', async () => {
    const { checkpoint } = await legacyCheckpointNameCollision()
    const created = await recovery.createBox(organization, checkpoint.id, 'exact-import', undefined)
    expect(await dataSource.getRepository(CheckpointOperation).findOneByOrFail({ boxId: created.id })).toMatchObject({
      checkpointId: checkpoint.id,
    })
  })

  it('prefers the exact checkpoint ID over a legacy colliding name when deleting', async () => {
    const { checkpoint, shadow } = await legacyCheckpointNameCollision()
    await service.remove(organizationId, checkpoint.id)
    expect(archiveStore.remove).toHaveBeenCalledWith(expect.objectContaining({ id: checkpoint.id }))
    expect(await checkpoints.findOneBy({ id: checkpoint.id })).toBeNull()
    expect(await checkpoints.findOneBy({ id: shadow.id })).not.toBeNull()
  })

  it('rejects a checkpoint name that collides with an existing checkpoint ID', async () => {
    const checkpoint = await readyCheckpoint()
    const box = await source('name-collision-source')
    const previousJobs = await jobs.count()
    await expect(service.create(organizationId, box.id, checkpoint.id)).rejects.toMatchObject({ status: 409 })
    expect(await checkpoints.count()).toBe(1)
    expect(await jobs.count()).toBe(previousJobs)
    expect((await boxes.findOneByOrFail({ id: box.id })).pending).toBe(false)
  })

  it('emits BoxCreatedEvent only after checkpoint import admission commits', async () => {
    const checkpoint = await readyCheckpoint()
    events.emitAsync.mockImplementation(async (type: string, event: BoxCreatedEvent) => {
      expect(type).toBe(BoxEvents.CREATED)
      expect(event).toBeInstanceOf(BoxCreatedEvent)
      const operation = await dataSource.getRepository(CheckpointOperation).findOneByOrFail({ boxId: event.box.id })
      expect(await boxes.findOneByOrFail({ id: event.box.id })).toMatchObject({ state: BoxState.RESTORING })
      expect(await jobs.findOneByOrFail({ id: operation.jobId })).toMatchObject({ resourceId: event.box.id })
      return []
    })
    const created = await recovery.createBox(organization, checkpoint.id, 'announced-import', undefined)
    expect(events.emitAsync).toHaveBeenCalledTimes(1)
    expect(events.emitAsync).toHaveBeenCalledWith(BoxEvents.CREATED, expect.objectContaining({ box: created }))
    await events.emitAsync.mock.results[0].value
  })

  it('keeps a committed checkpoint import successful when a creation listener fails', async () => {
    const checkpoint = await readyCheckpoint()
    events.emitAsync.mockRejectedValueOnce(new Error('creation listener unavailable'))
    const created = await recovery.createBox(organization, checkpoint.id, 'listener-failure-import', undefined)
    expect(events.emitAsync).toHaveBeenCalledTimes(1)
    expect(await boxes.findOneByOrFail({ id: created.id })).toMatchObject({ name: 'listener-failure-import' })
    expect(await jobs.countBy({ type: JobType.IMPORT_CHECKPOINT })).toBe(1)
  })

  it('allows a UUID-shaped checkpoint name when no checkpoint owns that ID', async () => {
    const box = await source()
    const name = randomUUID()
    const checkpoint = await service.create(organizationId, box.id, name)
    expect((await service.get(organizationId, name)).id).toBe(checkpoint.id)
    await expect(service.get(otherOrganizationId, name)).rejects.toMatchObject({ status: 404 })
  })

  it('requires a stopped source before accepting checkpoint capture', async () => {
    const box = await source()
    await boxes.update(box.id, { state: BoxState.STARTED, desiredState: BoxDesiredState.STARTED })
    await expect(service.create(organizationId, box.id, 'running-source')).rejects.toMatchObject({ status: 409 })
    expect(await checkpoints.count()).toBe(0)
    expect(await jobs.count()).toBe(0)
    expect(await states.count()).toBe(0)
    expect((await boxes.findOneByOrFail({ id: box.id })).pending).toBe(false)
    await boxes.update(box.id, { state: BoxState.STOPPED, desiredState: BoxDesiredState.STOPPED })
    await expect(service.create(organizationId, box.id, 'stopped-source')).resolves.toMatchObject({ state: 'creating' })
  })

  it('refuses new checkpoint work until rollout is explicitly enabled despite provisioned storage', async () => {
    const checkpoint = await readyCheckpoint()
    const target = await source('rollout-target')
    settings.enabled = false
    const priorJobs = await jobs.count()
    await expect(service.create(organizationId, target.id, 'must-not-capture')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    )
    await expect(recovery.createBox(organization, checkpoint.id, 'must-not-import', undefined)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    )
    expect(await jobs.count()).toBe(priorJobs)
    expect((await service.get(organizationId, checkpoint.id)).state).toBe('ready')
  })

  it('keeps ordinary Box reads independent and loads coordination only when requested', async () => {
    const target = await source()
    expect(await states.count()).toBe(0)
    expect(await repository.findWithCheckpointState(target.id)).toMatchObject({
      box: { id: target.id },
      checkpointState: null,
    })
    const checkpoint = await service.create(organizationId, target.id)
    const ordinary = await boxes.findOneByOrFail({ id: target.id })
    expect(ordinary).not.toHaveProperty('activeJobId')
    expect(ordinary).not.toHaveProperty('sequence')
    expect(ordinary).not.toHaveProperty('checkpointState')
    expect(await repository.findWithCheckpointState(target.id, organizationId)).toMatchObject({
      box: { id: target.id, pending: true },
      checkpointState: { boxId: target.id, activeJobId: checkpoint.exportJobId, sequence: 0 },
    })
    await expect(repository.findWithCheckpointState(target.id, otherOrganizationId)).rejects.toMatchObject({
      status: 404,
    })
    await expect(repository.findWithCheckpointState('missing')).rejects.toMatchObject({ status: 404 })
  })

  it('deletes an ordinary Box without creating checkpoint coordination', async () => {
    const box = await source()
    const deleted = await lifecycleService().destroy(box.id, organizationId, Context.user())
    expect(deleted).toMatchObject({ desiredState: BoxDesiredState.DESTROYED, pending: true })
    expect(await states.count()).toBe(0)
  })

  it('blocks deletion and proxy start during export, then allows start after release', async () => {
    const box = await source()
    const checkpoint = await service.create(organizationId, box.id)
    await expect(lifecycleService().destroy(box.id, organizationId, Context.user())).rejects.toThrow(
      'another state change',
    )
    expect(await repository.conditionalStartForProxy(box.id, organizationId)).toBeNull()
    expect(await states.findOneByOrFail({ boxId: box.id })).toMatchObject({ activeJobId: checkpoint.exportJobId })
    await finish(checkpoint.exportJobId!, archive(checkpoint))
    expect(await repository.conditionalStartForProxy(box.id, organizationId)).toMatchObject({
      desiredState: BoxDesiredState.STARTED,
      pending: true,
    })
    expect(await states.findOneByOrFail({ boxId: box.id })).toMatchObject({ activeJobId: null })
  })

  it('retains the import sequence across later exports and ignores a replayed import receipt', async () => {
    const checkpoint = await readyCheckpoint()
    const target = await recovery.createBox(organization, checkpoint.id, 'sequence-target', undefined)
    const operation = await dataSource.getRepository(CheckpointOperation).findOneByOrFail({ boxId: target.id })
    const receipt = { operationId: operation.id, targetSequence: operation.sequence, nativeId: 'first-native' }
    await finish(operation.jobId, receipt)
    await boxes.update(target.id, { desiredState: BoxDesiredState.STOPPED, pending: false })
    for (const name of ['export-one', 'export-two']) {
      const captured = await service.create(organizationId, target.id, name)
      expect(await states.findOneByOrFail({ boxId: target.id })).toMatchObject({
        activeJobId: captured.exportJobId,
        sequence: operation.sequence,
      })
      await finish(captured.exportJobId!, archive(captured))
      expect(await states.findOneByOrFail({ boxId: target.id })).toMatchObject({
        activeJobId: null,
        sequence: operation.sequence,
      })
    }
    const settled = await states.findOneByOrFail({ boxId: target.id })
    await finish(operation.jobId, { ...receipt, nativeId: 'late-native' })
    expect(await states.findOneByOrFail({ boxId: target.id })).toEqual(settled)
    expect(await dataSource.getRepository(CheckpointOperation).findOneByOrFail({ id: operation.id })).toMatchObject({
      state: 'completed',
      nativeId: 'first-native',
    })
    expect(await boxes.findOneByOrFail({ id: target.id })).toMatchObject({ state: BoxState.STOPPED, pending: false })
  })

  it('rolls back a new Box, operation and job if coordination cannot be persisted', async () => {
    const checkpoint = await readyCheckpoint()
    const initialStates = await states.count()
    await dataSource.query(`CREATE FUNCTION "${schema}".reject_checkpoint_state() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'coordination unavailable'; END; $$ LANGUAGE plpgsql`)
    await dataSource.query(`CREATE TRIGGER reject_checkpoint_state BEFORE INSERT ON "box_checkpoint_state"
      FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_checkpoint_state()`)
    try {
      await expect(recovery.createBox(organization, checkpoint.id, 'rolled-back-target', undefined)).rejects.toThrow(
        'coordination unavailable',
      )
      expect(await boxes.findOneBy({ name: 'rolled-back-target' })).toBeNull()
      expect(await states.count()).toBe(initialStates)
      expect(await jobs.countBy({ type: JobType.IMPORT_CHECKPOINT })).toBe(0)
      expect(await dataSource.getRepository(CheckpointOperation).count()).toBe(0)
      expect(events.emitAsync).not.toHaveBeenCalled()
    } finally {
      await dataSource.query('DROP TRIGGER reject_checkpoint_state ON "box_checkpoint_state"')
      await dataSource.query(`DROP FUNCTION "${schema}".reject_checkpoint_state()`)
    }
  })

  it.each(['', 'x'.repeat(129), 'bad\0name'])('rejects invalid imported Box name %j before admission', async (name) => {
    const checkpoint = await readyCheckpoint()
    await expect(
      recovery.createBox(organization, checkpoint.id, name, undefined).then(withCheckpointState),
    ).rejects.toThrow('Invalid box name')
    expect(await jobs.countBy({ type: JobType.IMPORT_CHECKPOINT })).toBe(0)
    expect(await dataSource.getRepository(CheckpointOperation).count()).toBe(0)
  })

  it('assigns an omitted imported Box name through ordinary name admission', async () => {
    const checkpoint = await readyCheckpoint()
    const created = await recovery
      .createBox(organization, checkpoint.id, undefined, undefined)
      .then(withCheckpointState)
    expect(created.name).toBeTruthy()
    expect(created.name).not.toBe('captured')
    expect(await boxes.findOneByOrFail({ id: created.id }).then(withCheckpointState)).toMatchObject({
      name: created.name,
    })
    expect(await jobs.countBy({ type: JobType.IMPORT_CHECKPOINT })).toBe(1)
  })

  it('refuses a selected v1 runner before target creation', async () => {
    const checkpoint = await readyCheckpoint()
    runnerSelection.getRandomAvailableRunner.mockResolvedValue({ ...runner, apiVersion: '1' })
    await expect(
      recovery.createBox(organization, checkpoint.id, 'legacy-target', undefined).then(withCheckpointState),
    ).rejects.toThrow('v2 runner')
    expect(await boxes.findOneBy({ name: 'legacy-target' })).toBeNull()
    expect(await jobs.countBy({ type: JobType.IMPORT_CHECKPOINT })).toBe(0)
  })

  it('refuses a ready checkpoint with missing captured image metadata before creating a target', async () => {
    const checkpoint = await readyCheckpoint()
    await checkpoints.update(checkpoint.id, { environment: { ...checkpoint.environment, image: '' } })
    await expect(
      recovery.createBox(organization, checkpoint.id, 'invalid-image-target', undefined).then(withCheckpointState),
    ).rejects.toThrow('no OCI image')
    expect(await boxes.findOneBy({ name: 'invalid-image-target' })).toBeNull()
    expect(await jobs.countBy({ type: JobType.IMPORT_CHECKPOINT })).toBe(0)
  })

  it('creates a fresh target after source deletion with inherited settings and new platform identity', async () => {
    const checkpoint = await readyCheckpoint()
    await boxes.delete(checkpoint.sourceBoxId)
    const created = await recovery
      .createBox(organization, checkpoint.id, 'from-checkpoint', 1)
      .then(withCheckpointState)
    expect(created).toMatchObject({
      organizationId,
      name: 'from-checkpoint',
      cpu: 4,
      mem: 8,
      disk: 12,
      state: BoxState.RESTORING,
      desiredState: BoxDesiredState.STARTED,
      pending: true,
      env: { APP_ENV: 'test' },
    })
    expect(created.id).not.toBe(checkpoint.sourceBoxId)
    const operation = await dataSource
      .getRepository(CheckpointOperation)
      .findOneByOrFail({ jobId: created.activeJobId! })
    expect(operation).toMatchObject({ mode: 'create', boxId: created.id, checkpointId: checkpoint.id })
    expect((await jobs.findOneByOrFail({ id: operation.jobId })).getPayload()).toMatchObject({
      mode: 'create',
      archive: checkpoint.archive,
      targetBoxId: created.id,
      platformEnv: {
        BOXLITE_BOX_ID: created.id,
        BOXLITE_ORGANIZATION_ID: organizationId,
        BOXLITE_REGION_ID: created.region,
      },
    })
    expect(runnerSelection.getRandomAvailableRunner).toHaveBeenCalledWith({
      regions: ['us'],
      boxClass: checkpoint.environment.class,
      requiresPrivileged: false,
    })
    await finish(operation.jobId, {
      operationId: operation.id,
      targetSequence: operation.sequence,
      nativeId: 'created-native',
    })
    expect(await boxes.findOneByOrFail({ id: created.id }).then(withCheckpointState)).toMatchObject({
      state: BoxState.STOPPED,
      desiredState: BoxDesiredState.STARTED,
      activeJobId: null,
      cpu: 4,
      env: { APP_ENV: 'test' },
    })
    expect(await dataSource.getRepository(CheckpointOperation).findOneByOrFail({ id: operation.id })).toMatchObject({
      state: 'completed',
      nativeId: 'created-native',
    })
    expect(events.emit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ box: expect.objectContaining({ id: created.id, cpu: 4 }) }),
    )
  })

  it('rolls back the import job and ownership when a new target name conflicts', async () => {
    const checkpoint = await readyCheckpoint()
    await expect(
      recovery.createBox(organization, checkpoint.id, 'captured', undefined).then(withCheckpointState),
    ).rejects.toMatchObject({
      status: 409,
    })
    expect(await jobs.countBy({ type: JobType.IMPORT_CHECKPOINT })).toBe(0)
    expect(await dataSource.getRepository(CheckpointOperation).count()).toBe(0)
    expect(await boxes.count()).toBe(1)
  })

  it('serializes new checkpoint targets with ordinary organization creation admission', async () => {
    const checkpoint = await readyCheckpoint()
    const results = await Promise.allSettled(
      ['first', 'second'].map((name) =>
        recovery.createBox(organization, checkpoint.id, name, 2).then(withCheckpointState),
      ),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await boxes.count()).toBe(2)
    expect(await jobs.countBy({ type: JobType.IMPORT_CHECKPOINT })).toBe(1)
    expect(await dataSource.getRepository(CheckpointOperation).count()).toBe(1)
  })

  it('rechecks checkpoint availability and runner eligibility before inserting a new target', async () => {
    const checkpoint = await readyCheckpoint()
    runnerSelection.getRandomAvailableRunner.mockImplementation(async () => {
      await checkpoints.update(checkpoint.id, { state: 'deleting' })
      return runner
    })
    await expect(
      recovery.createBox(organization, checkpoint.id, 'deleted-race', undefined).then(withCheckpointState),
    ).rejects.toMatchObject({
      status: 409,
    })
    await checkpoints.update(checkpoint.id, { state: 'ready' })
    runnerSelection.getRandomAvailableRunner.mockImplementation(async () => {
      await dataSource.getRepository(Runner).update(runner.id, { draining: true })
      return runner
    })
    await expect(
      recovery.createBox(organization, checkpoint.id, 'drain-race', undefined).then(withCheckpointState),
    ).rejects.toMatchObject({
      status: 409,
    })
    expect(await boxes.count()).toBe(1)
    expect(await jobs.countBy({ type: JobType.IMPORT_CHECKPOINT })).toBe(0)
  })

  it('retains deleting metadata after object failure and retries before releasing the quota', async () => {
    const checkpoint = await readyCheckpoint()
    archiveStore.remove.mockRejectedValueOnce(new ServiceUnavailableException('storage unavailable'))
    await expect(service.remove(organizationId, checkpoint.id)).rejects.toMatchObject({ status: 503 })
    expect(await service.get(organizationId, checkpoint.id)).toMatchObject({ state: 'deleting' })
    settings.maxPerOrganization = 1
    await expect(service.create(organizationId, checkpoint.sourceBoxId, 'another')).rejects.toMatchObject({
      status: 409,
    })
    await service.remove(organizationId, checkpoint.id)
    expect(archiveStore.remove).toHaveBeenCalledTimes(2)
    await expect(service.get(organizationId, checkpoint.id)).rejects.toMatchObject({ status: 404 })
    expect(await boxes.findOneByOrFail({ id: checkpoint.sourceBoxId }).then(withCheckpointState)).toMatchObject({
      state: BoxState.STOPPED,
    })
    await expect(service.remove(organizationId, checkpoint.id, true)).resolves.toBeUndefined()
  })

  it('refuses new uses while object deletion runs without holding the database row lock', async () => {
    const checkpoint = await readyCheckpoint()
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const deleting = new Promise<void>((resolve) => {
      entered = resolve
    })
    archiveStore.remove.mockImplementation(async () => {
      entered()
      await waiting
    })
    const removal = service.remove(organizationId, checkpoint.id)
    await deleting
    try {
      expect(await service.get(organizationId, checkpoint.id)).toMatchObject({ state: 'deleting' })
      await expect(
        recovery.createBox(organization, checkpoint.id, 'must-not-exist', undefined).then(withCheckpointState),
      ).rejects.toMatchObject({
        status: 409,
      })
      expect(await jobs.countBy({ type: JobType.IMPORT_CHECKPOINT })).toBe(0)
    } finally {
      release()
      await removal
    }
    expect(await checkpoints.count()).toBe(0)
  })

  it('keeps pending and failed checkpoint uses even for force deletion', async () => {
    const checkpoint = await readyCheckpoint()
    const admitted = await recovery
      .createBox(organization, checkpoint.id, 'target', undefined)
      .then(withCheckpointState)
    await expect(service.remove(organizationId, checkpoint.id, true)).rejects.toMatchObject({ status: 409 })
    await finish(admitted.activeJobId!, undefined, JobStatus.FAILED)
    await expect(service.remove(organizationId, checkpoint.id, true)).rejects.toMatchObject({ status: 409 })
    expect(archiveStore.remove).not.toHaveBeenCalled()
    expect(await dataSource.getRepository(CheckpointOperation).countBy({ state: 'failed' })).toBe(1)
  })

  it('releases a completed checkpoint use so the checkpoint can be deleted', async () => {
    const checkpoint = await readyCheckpoint()
    const admitted = await recovery
      .createBox(organization, checkpoint.id, 'target', undefined)
      .then(withCheckpointState)
    const operation = await dataSource
      .getRepository(CheckpointOperation)
      .findOneByOrFail({ jobId: admitted.activeJobId! })
    await finish(operation.jobId, {
      operationId: operation.id,
      targetSequence: operation.sequence,
      nativeId: 'kept-box',
    })
    await service.remove(organizationId, checkpoint.id)
    expect(await dataSource.getRepository(CheckpointOperation).count()).toBe(0)
    expect(await boxes.findOneByOrFail({ id: admitted.id }).then(withCheckpointState)).toMatchObject({
      state: BoxState.STOPPED,
      cpu: 4,
    })
  })

  it('rejects foreign checkpoint deletion before object access and cannot force a creating checkpoint', async () => {
    const sourceBox = await source()
    const checkpoint = await service.create(organizationId, sourceBox.id)
    await expect(service.remove(otherOrganizationId, checkpoint.id, true)).resolves.toBeUndefined()
    await expect(service.remove(organizationId, checkpoint.id, true)).rejects.toMatchObject({ status: 409 })
    expect(archiveStore.remove).not.toHaveBeenCalled()
    expect(await checkpoints.count()).toBe(1)
  })

  it('protects an organization image through a retained checkpoint after source deletion', async () => {
    const checkpoint = await readyCheckpoint()
    await boxes.delete(checkpoint.sourceBoxId)
    const images = dataSource.getRepository(Image)
    const image = await images.save(
      images.create({ organizationId, name: catalogNameOf(checkpoint.environment.image)! }),
    )
    const otherImage = await images.save(images.create({ organizationId: otherOrganizationId, name: image.name }))
    const catalog = new ImageCatalogService(
      images,
      dataSource.getRepository(ImageVersion),
      dataSource.getRepository(ImageAlias),
      dataSource.getRepository(ImageAliasEvent),
      boxes,
    )
    await expect(catalog.delete(organization, image.id)).rejects.toThrow(checkpoint.id)
    expect((await images.findOneByOrFail({ id: image.id })).deletedAt).toBeNull()
    await catalog.delete({ id: otherOrganizationId } as Organization, otherImage.id)
    await service.remove(organizationId, checkpoint.id)
    await catalog.delete(organization, image.id)
    expect((await images.findOneByOrFail({ id: image.id })).deletedAt).toBeInstanceOf(Date)
  })

  it('fences import callbacks and retains checkpoint use until native target destruction', async () => {
    const checkpoint = await readyCheckpoint()
    const created = await recovery
      .createBox(organization, checkpoint.id, 'cancelled-target', undefined)
      .then(withCheckpointState)
    const operation = await dataSource
      .getRepository(CheckpointOperation)
      .findOneByOrFail({ jobId: created.activeJobId! })
    const deleted = await lifecycleService()
      .destroy(created.id, organizationId, Context.user())
      .then(withCheckpointState)
    expect(deleted).toMatchObject({
      desiredState: BoxDesiredState.DESTROYED,
      pending: true,
      activeJobId: null,
      sequence: operation.sequence + 1,
    })
    await finish(operation.jobId, {
      operationId: operation.id,
      targetSequence: operation.sequence,
      nativeId: 'late-import',
    })
    expect(await boxes.findOneByOrFail({ id: created.id }).then(withCheckpointState)).toMatchObject({
      desiredState: BoxDesiredState.DESTROYED,
      activeJobId: null,
    })
    expect(await dataSource.getRepository(CheckpointOperation).findOneByOrFail({ id: operation.id })).toMatchObject({
      state: 'cancelled',
    })
    await expect(service.remove(organizationId, checkpoint.id)).rejects.toMatchObject({ status: 409 })
    expect(archiveStore.remove).not.toHaveBeenCalled()
    expect(await dataSource.getRepository(CheckpointOperation).findOneByOrFail({ id: operation.id })).toMatchObject({
      state: 'cancelled',
    })
    await boxes.update(created.id, { state: BoxState.DESTROYED })
    await service.remove(organizationId, checkpoint.id)
    expect(await checkpoints.count()).toBe(0)
  })

  it('retries native destruction of a cancelled checkpoint target through periodic reconciliation', async () => {
    const checkpoint = await readyCheckpoint()
    const target = await recovery.createBox(organization, checkpoint.id, 'delete-reconcile', undefined)
    await lifecycleService().destroy(target.id, organizationId, Context.user())
    await expect(service.remove(organizationId, checkpoint.id)).rejects.toMatchObject({ status: 409 })
    expect(archiveStore.remove).not.toHaveBeenCalled()
    let destroyed: () => void
    const attempted = new Promise<void>((resolve) => {
      destroyed = resolve
    })
    const destroy = {
      run: jest.fn().mockImplementation(async () => {
        destroyed()
        return false
      }),
    }
    const locks = {
      lock: jest.fn().mockResolvedValue(true),
      unlock: jest.fn(),
      isLocked: jest.fn().mockResolvedValue(false),
    }
    const manager = new BoxManager(
      repository,
      { getRunnerApiVersion: async () => '2' } as never,
      {} as never,
      locks as never,
      {} as never,
      {} as never,
      destroy as never,
      {} as never,
    )
    await manager.syncStates()
    expect(
      await new Promise<boolean>((resolve) => {
        const deadline = setTimeout(() => resolve(false), 2000)
        void attempted.then(() => {
          clearTimeout(deadline)
          resolve(true)
        })
      }),
    ).toBe(true)
    expect(destroy.run).toHaveBeenCalledWith(expect.objectContaining({ id: target.id }), expect.anything())
  })

  it('retains cancelled checkpoint targets until native destruction is confirmed', async () => {
    const checkpoint = await readyCheckpoint()
    const target = await recovery.createBox(organization, checkpoint.id, 'delete-retained', undefined)
    await lifecycleService().destroy(target.id, organizationId, Context.user())
    await expect(service.remove(organizationId, checkpoint.id, true)).rejects.toMatchObject({ status: 409 })
    expect(archiveStore.remove).not.toHaveBeenCalled()
    const ordinary = await source('ordinary-error')
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    await boxes.update(target.id, { updatedAt: old })
    await boxes.update(ordinary.id, { state: BoxState.ERROR, desiredState: BoxDesiredState.DESTROYED, updatedAt: old })
    await lifecycleService().cleanupStaleErrorBoxes()
    expect(await boxes.findOneBy({ id: target.id })).not.toBeNull()
    expect(await boxes.findOneBy({ id: ordinary.id })).toBeNull()
  })

  it('protects the selected registry login through a checkpoint without blocking a shadowed prefix', async () => {
    const previousProxy = process.env.REGISTRY_PROXY_HOST
    process.env.REGISTRY_PROXY_HOST = 'checkpoint-proxy.example'
    const secretStore = {
      put: jest.fn().mockResolvedValue('test-version'),
      destroy: jest.fn().mockResolvedValue(undefined),
    }
    const registries = new RegistriesService(dataSource.getRepository(RegistryCredential), secretStore as never)
    try {
      const shorter = await registries.create(organizationId, null, {
        registryHost: 'ghcr.io',
        repositoryPrefix: 'acme/',
        username: 'fixture',
        password: 'fixture',
      })
      const selected = await registries.create(organizationId, null, {
        registryHost: 'ghcr.io',
        repositoryPrefix: 'acme/team/',
        username: 'fixture',
        password: 'fixture',
      })
      const checkpoint = await readyCheckpoint(`checkpoint-proxy.example/${organizationId}/ghcr.io/acme/team/app:tag`)
      await boxes.delete(checkpoint.sourceBoxId)
      await registries.delete(organizationId, shorter.id)
      secretStore.destroy.mockClear()
      await expect(registries.delete(organizationId, selected.id)).rejects.toThrow(checkpoint.id)
      expect(secretStore.destroy).not.toHaveBeenCalled()
      await service.remove(organizationId, checkpoint.id)
      await registries.delete(organizationId, selected.id)
      expect(secretStore.destroy).toHaveBeenCalledWith('test-version')
    } finally {
      if (previousProxy === undefined) delete process.env.REGISTRY_PROXY_HOST
      else process.env.REGISTRY_PROXY_HOST = previousProxy
    }
  })

  it('keeps a failed import failed and ignores its late completion', async () => {
    const checkpoint = await readyCheckpoint()
    const first = await recovery.createBox(organization, checkpoint.id, 'target', undefined).then(withCheckpointState)
    const operation = await dataSource.getRepository(CheckpointOperation).findOneByOrFail({ jobId: first.activeJobId! })
    await finish(operation.jobId, undefined, JobStatus.FAILED)
    const failed = {
      state: BoxState.ERROR,
      pending: true,
      activeJobId: operation.jobId,
      sequence: operation.sequence,
    }
    expect(await boxes.findOneByOrFail({ id: first.id }).then(withCheckpointState)).toMatchObject(failed)
    await finish(operation.jobId, {
      operationId: operation.id,
      targetSequence: operation.sequence,
      nativeId: 'late-old-attempt',
    })
    expect(await boxes.findOneByOrFail({ id: first.id }).then(withCheckpointState)).toMatchObject(failed)
    expect(await dataSource.getRepository(CheckpointOperation).findOneByOrFail({ id: operation.id })).toMatchObject({
      state: 'failed',
      nativeId: null,
    })
    expect(await jobs.countBy({ type: JobType.IMPORT_CHECKPOINT })).toBe(1)
  })

  it('rejects resource admission and foreign checkpoints before scheduling import', async () => {
    const checkpoint = await readyCheckpoint()
    resourceLimits.resolve.mockResolvedValue({ maxCpuPerBox: 1, maxMemoryPerBox: 1, maxDiskPerBox: 1 })
    await expect(recovery.createBox(organization, checkpoint.id, 'over-limit', undefined)).rejects.toMatchObject({
      status: 400,
    })
    resourceLimits.resolve.mockResolvedValue({ maxCpuPerBox: 16, maxMemoryPerBox: 128, maxDiskPerBox: 100 })
    await expect(
      recovery.createBox({ id: otherOrganizationId } as Organization, checkpoint.id, 'foreign', undefined),
    ).rejects.toMatchObject({ status: 404 })
    expect(await boxes.count()).toBe(1)
    expect(await jobs.countBy({ type: JobType.IMPORT_CHECKPOINT })).toBe(0)
    expect(await dataSource.getRepository(CheckpointOperation).count()).toBe(0)
  })

  it('replays a native success after the completion transaction rolls back', async () => {
    const checkpoint = await readyCheckpoint()
    const target = await recovery.createBox(organization, checkpoint.id, 'target', undefined).then(withCheckpointState)
    const operation = await dataSource
      .getRepository(CheckpointOperation)
      .findOneByOrFail({ jobId: target.activeJobId! })
    // Fail the second write, after the Box update, inside the real transaction.
    await dataSource.query(`CREATE FUNCTION "${schema}".reject_checkpoint_commit() RETURNS trigger AS $$
      BEGIN IF NEW.state = 'completed' THEN RAISE EXCEPTION 'checkpoint commit unavailable'; END IF;
      RETURN NEW; END; $$ LANGUAGE plpgsql`)
    await dataSource.query(`CREATE TRIGGER reject_checkpoint_commit BEFORE UPDATE ON "checkpoint_operation"
      FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_checkpoint_commit()`)
    try {
      await expect(
        finish(operation.jobId, {
          operationId: operation.id,
          targetSequence: operation.sequence,
          nativeId: 'already-imported',
        }),
      ).rejects.toThrow('checkpoint commit unavailable')
      expect(await boxes.findOneByOrFail({ id: target.id }).then(withCheckpointState)).toMatchObject({
        state: BoxState.RESTORING,
        pending: true,
        activeJobId: operation.jobId,
      })
      expect(await dataSource.getRepository(CheckpointOperation).findOneByOrFail({ id: operation.id })).toMatchObject({
        state: 'pending',
        nativeId: null,
      })
    } finally {
      await dataSource.query('DROP TRIGGER reject_checkpoint_commit ON "checkpoint_operation"')
      await dataSource.query(`DROP FUNCTION "${schema}".reject_checkpoint_commit()`)
    }
    await Promise.all([receiver.reconcile(), receiver.reconcile()])
    expect(await boxes.findOneByOrFail({ id: target.id }).then(withCheckpointState)).toMatchObject({
      state: BoxState.STOPPED,
      desiredState: BoxDesiredState.STARTED,
      activeJobId: null,
      cpu: 4,
      mem: 8,
      disk: 12,
      env: { APP_ENV: 'test' },
    })
    expect(await dataSource.getRepository(CheckpointOperation).findOneByOrFail({ id: operation.id })).toMatchObject({
      state: 'completed',
      nativeId: 'already-imported',
    })
    expect(events.emit.mock.calls.filter(([, event]) => event.box?.id === target.id)).toHaveLength(1)
    expect(await jobs.countBy({ type: JobType.IMPORT_CHECKPOINT })).toBe(1)
  })

  it.each(['operationId', 'targetSequence', 'nativeId'])(
    'retains ownership and the checkpoint use on an invalid %s receipt',
    async (field) => {
      const checkpoint = await readyCheckpoint()
      const admitted = await recovery
        .createBox(organization, checkpoint.id, 'target', undefined)
        .then(withCheckpointState)
      const operation = await dataSource
        .getRepository(CheckpointOperation)
        .findOneByOrFail({ jobId: admitted.activeJobId! })
      const receipt: Record<string, unknown> = {
        operationId: operation.id,
        targetSequence: operation.sequence,
        nativeId: 'new-native',
      }
      delete receipt[field]
      await finish(operation.jobId, receipt)
      expect(await boxes.findOneByOrFail({ id: admitted.id }).then(withCheckpointState)).toMatchObject({
        state: BoxState.ERROR,
        pending: true,
        activeJobId: operation.jobId,
        sequence: operation.sequence,
      })
      expect(await dataSource.getRepository(CheckpointOperation).findOneByOrFail({ id: operation.id })).toMatchObject({
        state: 'failed',
        nativeId: null,
      })
      expect(await service.get(organizationId, checkpoint.id)).toMatchObject({ state: 'ready' })
      await expect(service.remove(organizationId, checkpoint.id)).rejects.toMatchObject({ status: 409 })
    },
  )

  it('wakes the runner for upload only after the export transaction commits', async () => {
    const box = await source()
    const checkpoint = await service.create(organizationId, box.id, 'notify-upload')
    const observed: unknown[] = []
    uploadNotifications.lpush.mockImplementation(async (queue: string, jobId: string) => {
      // This repository uses a separate connection from the transaction.
      observed.push({
        queue,
        jobId,
        job: await jobs.findOneBy({ id: jobId }),
        checkpoint: await checkpoints.findOneBy({ id: checkpoint.id }),
      })
      return 1
    })
    const completed = await finish(checkpoint.exportJobId!, archive(checkpoint))
    expect(uploadNotifications.lpush).toHaveBeenCalledTimes(1)
    const jobId = uploadNotifications.lpush.mock.calls[0][1]
    expect(observed).toEqual([
      {
        queue: `runner:jobs:${runner.id}`,
        jobId,
        job: expect.objectContaining({ id: jobId, type: JobType.UPLOAD_CHECKPOINT }),
        checkpoint: expect.objectContaining({ activeJobId: jobId }),
      },
    ])
    await receiver.handleJobCompletion(completed)
    expect(uploadNotifications.lpush).toHaveBeenCalledTimes(1)
  })

  it('keeps a committed upload available for polling when its Redis wakeup fails', async () => {
    const box = await source()
    const checkpoint = await service.create(organizationId, box.id, 'notify-unavailable')
    uploadNotifications.lpush.mockRejectedValue(new Error('Redis temporarily unavailable'))
    await finish(checkpoint.exportJobId!, archive(checkpoint))
    const pending = await checkpoints.findOneByOrFail({ id: checkpoint.id })
    expect(await jobs.findOneByOrFail({ id: pending.activeJobId! })).toMatchObject({ type: JobType.UPLOAD_CHECKPOINT })
    expect(uploadNotifications.lpush).toHaveBeenCalledTimes(1)
  })

  it('releases the source after export and becomes ready only after upload', async () => {
    const box = await source()
    const created = await new BoxliteCheckpointController(service).create({ organizationId } as never, {
      source_box_id: box.id,
      name: 'base',
    })
    expect(created).toMatchObject({ name: 'base', state: 'creating', source_box_id: box.id, size_bytes: 0 })
    expect(Number.isNaN(Date.parse(created.created_at))).toBe(false)
    const checkpoint = await service.get(organizationId, created.id)
    expect(checkpoint.state).toBe('creating')
    expect(checkpoint.environment).toMatchObject({
      cpu: 4,
      mem: 8,
      disk: 12,
      env: { APP_ENV: 'test' },
      entrypoint: ['/app'],
      cmd: ['serve'],
    })
    expect(await boxes.findOneByOrFail({ id: box.id }).then(withCheckpointState)).toMatchObject({
      pending: true,
      activeJobId: checkpoint.exportJobId,
    })
    expect(await jobs.findOneByOrFail({ id: checkpoint.exportJobId! })).toMatchObject({
      type: JobType.EXPORT_CHECKPOINT,
      resourceType: ResourceType.BOX,
      resourceId: box.id,
    })
    await finish(checkpoint.exportJobId!, archive(checkpoint))
    const uploading = await checkpoints.findOneByOrFail({ id: checkpoint.id })
    expect(uploading.state).toBe('creating')
    expect(uploading.activeJobId).not.toBe(checkpoint.exportJobId)
    expect(await boxes.findOneByOrFail({ id: box.id }).then(withCheckpointState)).toMatchObject({
      pending: false,
      activeJobId: null,
      state: BoxState.STOPPED,
    })
    expect(await jobs.findOneByOrFail({ id: uploading.activeJobId! })).toMatchObject({
      type: JobType.UPLOAD_CHECKPOINT,
      resourceType: ResourceType.CHECKPOINT,
      resourceId: checkpoint.id,
    })
    await finish(uploading.activeJobId!, archive(checkpoint))
    expect(await service.get(organizationId, 'base')).toMatchObject({
      state: 'ready',
      activeJobId: null,
      archive: archive(checkpoint),
    })
  })

  it('accepts export callbacks once and ignores their later replay during a newer capture', async () => {
    const box = await source()
    const first = await service.create(organizationId, box.id, 'first')
    await jobs.update(first.exportJobId!, {
      status: JobStatus.COMPLETED,
      completedAt: new Date(),
      resultMetadata: JSON.stringify(archive(first)),
    })
    const job = await jobs.findOneByOrFail({ id: first.exportJobId! })
    await Promise.all(Array.from({ length: 8 }, () => receiver.handleJobCompletion(job)))
    expect(await jobs.countBy({ type: JobType.UPLOAD_CHECKPOINT })).toBe(1)
    const second = await service.create(organizationId, box.id, 'second')
    await receiver.handleJobCompletion(job)
    expect(await boxes.findOneByOrFail({ id: box.id }).then(withCheckpointState)).toMatchObject({
      pending: true,
      activeJobId: second.exportJobId,
    })
    expect(await jobs.countBy({ type: JobType.UPLOAD_CHECKPOINT })).toBe(1)
  })

  it('reconciles durable terminal jobs after callback loss', async () => {
    const box = await source()
    const checkpoint = await service.create(organizationId, box.id)
    await jobs.update(checkpoint.exportJobId!, {
      status: JobStatus.COMPLETED,
      completedAt: new Date(),
      resultMetadata: JSON.stringify(archive(checkpoint)),
    })
    await receiver.reconcile()
    await receiver.reconcile()
    expect(await jobs.countBy({ type: JobType.UPLOAD_CHECKPOINT })).toBe(1)
    expect(await boxes.findOneByOrFail({ id: box.id }).then(withCheckpointState)).toMatchObject({
      pending: false,
      activeJobId: null,
    })
  })

  it('keeps checkpoints independent of a deleted source', async () => {
    const box = await source()
    const checkpoint = await service.create(organizationId, box.id)
    await finish(checkpoint.exportJobId!, archive(checkpoint))
    await boxes.delete(box.id)
    expect(await states.findOneBy({ boxId: box.id })).toBeNull()
    const uploading = await service.get(organizationId, checkpoint.id)
    await finish(uploading.activeJobId!, archive(checkpoint))
    expect(await service.get(organizationId, checkpoint.id)).toMatchObject({ state: 'ready', sourceBoxId: box.id })
  })

  it('enforces the org quota across concurrent captures of different sources', async () => {
    settings.maxPerOrganization = 1
    const sources = await Promise.all([source('one'), source('two')])
    const results = await Promise.allSettled(sources.map((box) => service.create(organizationId, box.id)))
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(await checkpoints.count()).toBe(1)
    expect(await jobs.count()).toBe(1)
    expect(await boxes.countBy({ pending: true })).toBe(1)
  })

  it('does not leak another organization through create, get or list', async () => {
    const box = await source()
    const checkpoint = await service.create(organizationId, box.id, 'private')
    await expect(service.create(otherOrganizationId, box.id)).rejects.toMatchObject({ status: 404 })
    await expect(service.get(otherOrganizationId, checkpoint.id)).rejects.toMatchObject({ status: 404 })
    expect(await service.list(otherOrganizationId)).toEqual({ checkpoints: [], nextPageToken: undefined })
    expect(await jobs.count()).toBe(1)
  })

  it.each(['volumes', 'secrets'] as const)(
    'refuses %s before creating a job or taking the source busy flag',
    async (field) => {
      const box = await source()
      await boxes.update(box.id, { [field]: [{ id: 'external-reference' }] })
      await expect(service.create(organizationId, box.id)).rejects.toMatchObject({ status: 400 })
      expect(await jobs.count()).toBe(0)
      expect(await checkpoints.count()).toBe(0)
      expect(await boxes.findOneByOrFail({ id: box.id }).then(withCheckpointState)).toMatchObject({
        pending: false,
        activeJobId: null,
      })
    },
  )

  it('rolls a duplicate name back without leaving a job or busy source', async () => {
    const first = await source('first')
    const second = await source('second')
    await service.create(organizationId, first.id, 'duplicate')
    await expect(service.create(organizationId, second.id, 'duplicate')).rejects.toMatchObject({ status: 409 })
    expect(await checkpoints.count()).toBe(1)
    expect(await jobs.count()).toBe(1)
    expect(await boxes.findOneByOrFail({ id: second.id }).then(withCheckpointState)).toMatchObject({
      pending: false,
      activeJobId: null,
    })
  })

  it('records export failure without changing the source lifecycle state', async () => {
    const box = await source()
    const checkpoint = await service.create(organizationId, box.id)
    await finish(checkpoint.exportJobId!, undefined, JobStatus.FAILED)
    expect(await service.get(organizationId, checkpoint.id)).toMatchObject({ state: 'failed', activeJobId: null })
    expect(await boxes.findOneByOrFail({ id: box.id }).then(withCheckpointState)).toMatchObject({
      pending: false,
      state: BoxState.STOPPED,
    })
    expect(await jobs.countBy({ type: JobType.UPLOAD_CHECKPOINT })).toBe(0)
  })

  it('refuses to promote malformed or changed upload metadata', async () => {
    const box = await source()
    const checkpoint = await service.create(organizationId, box.id)
    await finish(checkpoint.exportJobId!, archive(checkpoint))
    const uploading = await service.get(organizationId, checkpoint.id)
    await finish(uploading.activeJobId!, { ...archive(checkpoint), sha256: 'c'.repeat(64) })
    expect(await service.get(organizationId, checkpoint.id)).toMatchObject({ state: 'failed' })
  })

  it('requires configured storage before any source or job mutation', async () => {
    const box = await source()
    settings.archivePrefix = undefined
    await expect(service.create(organizationId, box.id)).rejects.toMatchObject({ status: 503 })
    expect(await jobs.count()).toBe(0)
    expect(await boxes.findOneByOrFail({ id: box.id }).then(withCheckpointState)).toMatchObject({
      pending: false,
      activeJobId: null,
    })
  })

  it('refuses an active migration before taking a source job', async () => {
    const box = await source()
    await dataSource
      .getRepository(BoxMigration)
      .insert({ boxId: box.id, state: BoxMigrationState.PENDING_EXPORT, arcPath: '', updatedAt: box.updatedAt })
    await expect(service.create(organizationId, box.id)).rejects.toMatchObject({ status: 409 })
    expect(await jobs.count()).toBe(0)
    expect(await checkpoints.count()).toBe(0)
    expect(await boxes.findOneByOrFail({ id: box.id }).then(withCheckpointState)).toMatchObject({
      pending: false,
      activeJobId: null,
    })
  })

  it('does not claim a draining runner or a source with an unfinished lifecycle job', async () => {
    const box = await source()
    await dataSource.getRepository(Runner).update(runner.id, { draining: true })
    await expect(service.create(organizationId, box.id)).rejects.toMatchObject({ status: 409 })
    await dataSource.getRepository(Runner).update(runner.id, { draining: false })
    await jobs.insert(
      new Job({ type: JobType.START_BOX, runnerId: runner.id, resourceType: ResourceType.BOX, resourceId: box.id }),
    )
    await expect(service.create(organizationId, box.id)).rejects.toMatchObject({ status: 409 })
    expect(await checkpoints.count()).toBe(0)
    expect(await jobs.count()).toBe(1)
  })

  it('keeps the source stopped when export releases its busy flag', async () => {
    const box = await source()
    const checkpoint = await service.create(organizationId, box.id)
    await finish(checkpoint.exportJobId!, archive(checkpoint))
    expect(await boxes.findOneByOrFail({ id: box.id }).then(withCheckpointState)).toMatchObject({
      state: BoxState.STOPPED,
      desiredState: BoxDesiredState.STOPPED,
      pending: false,
      activeJobId: null,
    })
  })

  it('does not advance a capture using another runner or mismatched archive ownership', async () => {
    const box = await source()
    const checkpoint = await service.create(organizationId, box.id)
    await jobs.update(checkpoint.exportJobId!, { runnerId: randomUUID() })
    await finish(checkpoint.exportJobId!, archive(checkpoint))
    expect(await service.get(organizationId, checkpoint.id)).toMatchObject({
      state: 'creating',
      activeJobId: checkpoint.exportJobId,
    })
    expect(await boxes.findOneByOrFail({ id: box.id }).then(withCheckpointState)).toMatchObject({ pending: true })
    await jobs.update(checkpoint.exportJobId!, { runnerId: runner.id })
    await finish(checkpoint.exportJobId!, { ...archive(checkpoint), arcPath: 'gs://other/object' })
    expect(await service.get(organizationId, checkpoint.id)).toMatchObject({ state: 'failed', activeJobId: null })
    expect(await jobs.countBy({ type: JobType.UPLOAD_CHECKPOINT })).toBe(0)
  })

  it.each(['', '-base', 'base/name', 'a'.repeat(129)])(
    'rejects invalid capture name %j before reserving the source',
    async (name) => {
      const box = await source()
      await expect(service.create(organizationId, box.id, name)).rejects.toMatchObject({ status: 400 })
      expect(await checkpoints.count()).toBe(0)
      expect(await jobs.count()).toBe(0)
      expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({ pending: false })
    },
  )

  it('does not accept a completion notification before the persisted job is terminal', async () => {
    const box = await source()
    const checkpoint = await service.create(organizationId, box.id)
    const notification = await jobs.findOneByOrFail({ id: checkpoint.exportJobId! })
    notification.status = JobStatus.COMPLETED
    notification.resultMetadata = JSON.stringify(archive(checkpoint))
    await receiver.handleJobCompletion(notification)
    expect(await service.get(organizationId, checkpoint.id)).toMatchObject({
      state: 'creating',
      activeJobId: checkpoint.exportJobId,
    })
    expect(await jobs.countBy({ type: JobType.UPLOAD_CHECKPOINT })).toBe(0)
    expect(await boxes.findOneByOrFail({ id: box.id }).then(withCheckpointState)).toMatchObject({ pending: true })
  })

  it.each([{ resourceType: ResourceType.CHECKPOINT }, { resourceId: randomUUID() }])(
    'ignores an export receipt with the wrong resource: %j',
    async (resource) => {
      const box = await source()
      const checkpoint = await service.create(organizationId, box.id)
      await jobs.update(checkpoint.exportJobId!, resource)
      await finish(checkpoint.exportJobId!, archive(checkpoint))
      expect(await service.get(organizationId, checkpoint.id)).toMatchObject({
        state: 'creating',
        activeJobId: checkpoint.exportJobId,
      })
      expect(await jobs.countBy({ type: JobType.UPLOAD_CHECKPOINT })).toBe(0)
      expect(await boxes.findOneByOrFail({ id: box.id }).then(withCheckpointState)).toMatchObject({ pending: true })
    },
  )

  it('cancels import completion after a persisted destruction intent', async () => {
    const checkpoint = await readyCheckpoint()
    const target = await recovery.createBox(organization, checkpoint.id, 'destroy-before-completion', undefined)
    const coordination = await states.findOneByOrFail({ boxId: target.id })
    await boxes.update(target.id, { desiredState: BoxDesiredState.DESTROYED })
    await finish(coordination.activeJobId!, { nativeId: 'late-native-result' })
    expect(
      await dataSource.getRepository(CheckpointOperation).findOneByOrFail({ jobId: coordination.activeJobId! }),
    ).toMatchObject({ state: 'cancelled' })
    expect(await boxes.findOneByOrFail({ id: target.id })).toMatchObject({ desiredState: BoxDesiredState.DESTROYED })
  })

  it('continues reconciling other captures when one callback fails', async () => {
    const first = await service.create(organizationId, (await source('first')).id)
    const second = await service.create(organizationId, (await source('second')).id)
    for (const [index, checkpoint] of [first, second].entries()) {
      await jobs.update(checkpoint.exportJobId!, {
        status: JobStatus.COMPLETED,
        completedAt: new Date(1000 + index),
        resultMetadata: JSON.stringify(archive(checkpoint)),
      })
    }
    const completion = jest.spyOn(receiver, 'handleJobCompletion').mockRejectedValueOnce(new Error('Temporary failure'))
    try {
      await receiver.reconcile()
      expect(completion).toHaveBeenCalledTimes(2)
      expect(await service.get(organizationId, first.id)).toMatchObject({ activeJobId: first.exportJobId })
      expect((await service.get(organizationId, second.id)).activeJobId).not.toBe(second.exportJobId)
      expect(await jobs.countBy({ type: JobType.UPLOAD_CHECKPOINT })).toBe(1)
    } finally {
      completion.mockRestore()
    }
  })

  it('reports a missing checkpoint on ordinary deletion', async () => {
    await expect(service.remove(organizationId, randomUUID())).rejects.toMatchObject({ status: 404 })
    expect(archiveStore.remove).not.toHaveBeenCalled()
  })

  it.each([false, true])('handles a checkpoint removed between lookup and locking with force=%s', async (force) => {
    const checkpoint = await readyCheckpoint()
    const get = service.get.bind(service)
    const lookup = jest.spyOn(service, 'get').mockImplementationOnce(async (...args) => {
      const selected = await get(...args)
      await checkpoints.delete(selected.id)
      return selected
    })
    try {
      const removal = service.remove(organizationId, checkpoint.id, force)
      if (force) await expect(removal).resolves.toBeUndefined()
      else await expect(removal).rejects.toMatchObject({ status: 404 })
      expect(await checkpoints.count()).toBe(0)
      expect(archiveStore.remove).not.toHaveBeenCalled()
    } finally {
      lookup.mockRestore()
    }
  })

  it('pages retained records without dropping rows or reading another organization', async () => {
    const box = await source()
    const first = await service.create(organizationId, box.id)
    await checkpoints.insert(
      Array.from({ length: 100 }, (_, index) => ({
        ...first,
        id: randomUUID(),
        name: `page-${index}`,
        activeJobId: null,
        exportJobId: null,
        state: 'failed' as const,
      })),
    )
    const page = await service.list(organizationId)
    expect(page.checkpoints).toHaveLength(100)
    expect(page.nextPageToken).toBeDefined()
    const next = await service.list(organizationId, page.nextPageToken)
    expect(next.checkpoints).toHaveLength(1)
    expect(next.nextPageToken).toBeUndefined()
    expect(new Set([...page.checkpoints, ...next.checkpoints].map((row) => row.id)).size).toBe(101)
    await expect(service.list(organizationId, 'bad-token')).rejects.toMatchObject({ status: 400 })
  })
})
