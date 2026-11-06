// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import { randomUUID } from 'node:crypto'
import { ConfigService } from '@nestjs/config'
import { DataSource, Repository } from 'typeorm'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { Box } from '../entities/box.entity'
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

const describeWithDatabase = process.env.DB_HOST ? describe : describe.skip
const schema = `checkpoint_api_${process.pid}_${randomUUID().replaceAll('-', '')}`
const organizationId = randomUUID()
const otherOrganizationId = randomUUID()

describeWithDatabase('checkpoint create/export/upload (real PostgreSQL)', () => {
  let dataSource: DataSource
  let checkpoints: Repository<Checkpoint>
  let boxes: Repository<Box>
  let jobs: Repository<Job>
  let runner: Runner
  let service: CheckpointService
  let receiver: CheckpointJobReceiver
  let recovery: CheckpointRecoverService
  let repository: BoxRepository
  const events = { emit: jest.fn() }
  const organization = { id: organizationId } as Organization
  const resourceLimits = { resolve: jest.fn() }
  const imageAdmission = { assert: jest.fn() }
  const runnerSelection = { getRandomAvailableRunner: jest.fn() }
  const archiveStore = { remove: jest.fn() }
  let settings: { archivePrefix?: string; maxPerOrganization: number }
  const cache = { invalidate: jest.fn() }

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
    jobs = dataSource.getRepository(Job)
    const jobService = new JobService(jobs, { lpush: jest.fn().mockResolvedValue(1) } as any, {} as any)
    const config = { get: (key: string) => (key === 'checkpoint' ? settings : undefined) } as ConfigService
    service = new CheckpointService(dataSource, config, jobService, cache as any, archiveStore as never)
    receiver = new CheckpointJobReceiver(dataSource, cache as any, events as unknown as EventEmitter2)
    repository = new BoxRepository(dataSource, events as unknown as EventEmitter2, cache as any)
    recovery = new CheckpointRecoverService(
      dataSource,
      service,
      jobService,
      { assertOrganizationIsNotSuspended: jest.fn() } as any,
      resourceLimits as any,
      imageAdmission as any,
      cache as any,
      repository,
      runnerSelection as never,
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
    await dataSource.query(
      `TRUNCATE TABLE "${schema}"."checkpoint_operation", "${schema}"."checkpoint", "${schema}"."job", "${schema}"."box", "${schema}"."runner", "${schema}"."image", "${schema}"."registry_credential" CASCADE`,
    )
    settings = { archivePrefix: 'gs://checkpoint-tests/checkpoints/', maxPerOrganization: 10 }
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
    resourceLimits.resolve.mockReset().mockResolvedValue({ maxCpuPerBox: 16, maxMemoryPerBox: 128, maxDiskPerBox: 100 })
    imageAdmission.assert.mockReset().mockResolvedValue(undefined)
    runnerSelection.getRandomAvailableRunner.mockReset().mockImplementation(async () => runner)
    archiveStore.remove.mockReset().mockResolvedValue(undefined)
  })

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

  async function readyCheckpoint(image?: string): Promise<Checkpoint> {
    const captured = await source('captured')
    if (image) await boxes.update(captured.id, { image, imageIsOrgOwned: true })
    const checkpoint = await service.create(organizationId, captured.id, 'ready-base')
    await finish(checkpoint.exportJobId!, archive(checkpoint))
    const uploading = await service.get(organizationId, checkpoint.id)
    await finish(uploading.activeJobId!, archive(checkpoint))
    return service.get(organizationId, checkpoint.id)
  }

  it('commits inherited configuration only with its matching native import receipt', async () => {
    const checkpoint = await readyCheckpoint()
    const target = await source('target')
    await boxes.update(target.id, { cpu: 1, mem: 1, disk: 2, env: { OLD: 'keep until commit' } })
    const admitted = await recovery.recover(organization, checkpoint.id, target.id, 2)
    expect(admitted).toMatchObject({ id: target.id, state: BoxState.RESTORING, pending: true, cpu: 1, mem: 1, disk: 2 })
    const operation = await dataSource
      .getRepository(CheckpointOperation)
      .findOneByOrFail({ jobId: admitted.checkpointJobId! })
    expect(operation.environment).toMatchObject({ cpu: 4, mem: 8, disk: 12, env: { APP_ENV: 'test' } })
    expect((await jobs.findOneByOrFail({ id: operation.jobId })).getPayload()).toMatchObject({
      operationId: operation.id,
      targetSequence: operation.sequence,
      targetBoxId: target.id,
      mode: 'recover',
      archive: checkpoint.archive,
      platformEnv: { BOXLITE_BOX_ID: target.id, BOXLITE_ORGANIZATION_ID: organizationId },
    })
    await finish(operation.jobId, {
      operationId: operation.id,
      targetSequence: operation.sequence,
      nativeId: 'new-native-id',
    })
    expect(await boxes.findOneByOrFail({ id: target.id })).toMatchObject({
      id: target.id,
      state: BoxState.STOPPED,
      pending: false,
      checkpointJobId: null,
      cpu: 4,
      mem: 8,
      disk: 12,
      env: { APP_ENV: 'test' },
    })
    expect(await dataSource.getRepository(CheckpointOperation).findOneByOrFail({ id: operation.id })).toMatchObject({
      state: 'completed',
      nativeId: 'new-native-id',
    })
    expect(events.emit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ box: expect.objectContaining({ id: target.id, cpu: 4 }) }),
    )
  })

  it('creates a fresh target after source deletion with inherited settings and new platform identity', async () => {
    const checkpoint = await readyCheckpoint()
    await boxes.delete(checkpoint.sourceBoxId)
    const created = await recovery.createBox(organization, checkpoint.id, 'from-checkpoint', 1)
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
      .findOneByOrFail({ jobId: created.checkpointJobId! })
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
    expect(await boxes.findOneByOrFail({ id: created.id })).toMatchObject({
      state: BoxState.STOPPED,
      desiredState: BoxDesiredState.STARTED,
      checkpointJobId: null,
      cpu: 4,
      env: { APP_ENV: 'test' },
    })
  })

  it('rolls back the import job and ownership when a new target name conflicts', async () => {
    const checkpoint = await readyCheckpoint()
    await expect(recovery.createBox(organization, checkpoint.id, 'captured', undefined)).rejects.toMatchObject({
      status: 409,
    })
    expect(await jobs.countBy({ type: JobType.IMPORT_CHECKPOINT })).toBe(0)
    expect(await dataSource.getRepository(CheckpointOperation).count()).toBe(0)
    expect(await boxes.count()).toBe(1)
  })

  it('serializes new checkpoint targets with ordinary organization creation admission', async () => {
    const checkpoint = await readyCheckpoint()
    const results = await Promise.allSettled(
      ['first', 'second'].map((name) => recovery.createBox(organization, checkpoint.id, name, 2)),
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
    await expect(recovery.createBox(organization, checkpoint.id, 'deleted-race', undefined)).rejects.toMatchObject({
      status: 409,
    })
    await checkpoints.update(checkpoint.id, { state: 'ready' })
    runnerSelection.getRandomAvailableRunner.mockImplementation(async () => {
      await dataSource.getRepository(Runner).update(runner.id, { draining: true })
      return runner
    })
    await expect(recovery.createBox(organization, checkpoint.id, 'drain-race', undefined)).rejects.toMatchObject({
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
    expect(await boxes.findOneByOrFail({ id: checkpoint.sourceBoxId })).toMatchObject({ state: BoxState.STOPPED })
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
      await expect(recovery.createBox(organization, checkpoint.id, 'must-not-exist', undefined)).rejects.toMatchObject({
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
    const target = await source('target')
    const admitted = await recovery.recover(organization, checkpoint.id, target.id, undefined)
    await expect(service.remove(organizationId, checkpoint.id, true)).rejects.toMatchObject({ status: 409 })
    await finish(admitted.checkpointJobId!, undefined, JobStatus.FAILED)
    await expect(service.remove(organizationId, checkpoint.id, true)).rejects.toMatchObject({ status: 409 })
    expect(archiveStore.remove).not.toHaveBeenCalled()
    const retried = await recovery.recover(organization, checkpoint.id, target.id, undefined)
    const operation = await dataSource
      .getRepository(CheckpointOperation)
      .findOneByOrFail({ jobId: retried.checkpointJobId! })
    await finish(operation.jobId, {
      operationId: operation.id,
      targetSequence: operation.sequence,
      nativeId: 'kept-box',
    })
    await service.remove(organizationId, checkpoint.id)
    expect(await dataSource.getRepository(CheckpointOperation).count()).toBe(0)
    expect(await boxes.findOneByOrFail({ id: target.id })).toMatchObject({ state: BoxState.STOPPED, cpu: 4 })
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

  it('fences import callbacks and releases checkpoint use when the target is explicitly deleted', async () => {
    const checkpoint = await readyCheckpoint()
    const created = await recovery.createBox(organization, checkpoint.id, 'cancelled-target', undefined)
    const operation = await dataSource
      .getRepository(CheckpointOperation)
      .findOneByOrFail({ jobId: created.checkpointJobId! })
    const deleted = await repository.deleteCheckpointTarget(created)
    expect(deleted).toMatchObject({
      desiredState: BoxDesiredState.DESTROYED,
      pending: true,
      checkpointJobId: null,
      checkpointSequence: operation.sequence + 1,
    })
    await finish(operation.jobId, {
      operationId: operation.id,
      targetSequence: operation.sequence,
      nativeId: 'late-import',
    })
    expect(await boxes.findOneByOrFail({ id: created.id })).toMatchObject({
      desiredState: BoxDesiredState.DESTROYED,
      checkpointJobId: null,
    })
    expect(await dataSource.getRepository(CheckpointOperation).findOneByOrFail({ id: operation.id })).toMatchObject({
      state: 'cancelled',
    })
    await service.remove(organizationId, checkpoint.id)
    expect(await checkpoints.count()).toBe(0)
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

  it('reuses logical ownership across failed attempts and ignores their late completion', async () => {
    const checkpoint = await readyCheckpoint()
    const target = await source('target')
    const first = await recovery.recover(organization, checkpoint.id, target.id, undefined)
    const operation = await dataSource
      .getRepository(CheckpointOperation)
      .findOneByOrFail({ jobId: first.checkpointJobId! })
    await finish(operation.jobId, undefined, JobStatus.FAILED)
    expect(await boxes.findOneByOrFail({ id: target.id })).toMatchObject({
      state: BoxState.ERROR,
      pending: true,
      checkpointJobId: operation.jobId,
    })
    const retried = await recovery.recover(organization, checkpoint.id, target.id, undefined)
    expect(retried.checkpointJobId).not.toBe(operation.jobId)
    const current = await dataSource.getRepository(CheckpointOperation).findOneByOrFail({ id: operation.id })
    expect(current).toMatchObject({
      id: operation.id,
      sequence: operation.sequence,
      state: 'pending',
      jobId: retried.checkpointJobId,
    })
    await finish(operation.jobId, {
      operationId: operation.id,
      targetSequence: operation.sequence,
      nativeId: 'late-old-attempt',
    })
    expect(await boxes.findOneByOrFail({ id: target.id })).toMatchObject({
      state: BoxState.RESTORING,
      checkpointJobId: current.jobId,
    })
    await finish(current.jobId, {
      operationId: current.id,
      targetSequence: current.sequence,
      nativeId: 'accepted-retry',
    })
    expect(await boxes.findOneByOrFail({ id: target.id })).toMatchObject({
      state: BoxState.STOPPED,
      checkpointJobId: null,
    })
  })

  it('rejects resource admission and foreign targets before scheduling import', async () => {
    const checkpoint = await readyCheckpoint()
    const target = await source('target')
    resourceLimits.resolve.mockResolvedValue({ maxCpuPerBox: 1, maxMemoryPerBox: 1, maxDiskPerBox: 1 })
    await expect(recovery.recover(organization, checkpoint.id, target.id, undefined)).rejects.toMatchObject({
      status: 400,
    })
    expect(await jobs.countBy({ type: JobType.IMPORT_CHECKPOINT })).toBe(0)
    resourceLimits.resolve.mockResolvedValue({ maxCpuPerBox: 16, maxMemoryPerBox: 128, maxDiskPerBox: 100 })
    await boxes.update(target.id, { organizationId: otherOrganizationId })
    await expect(recovery.recover(organization, checkpoint.id, target.id, undefined)).rejects.toMatchObject({
      status: 404,
    })
    expect(await dataSource.getRepository(CheckpointOperation).count()).toBe(0)
  })

  it('does not revive an errored target beyond the organization Box quota', async () => {
    const checkpoint = await readyCheckpoint()
    const target = await source('target')
    await boxes.update(target.id, { state: BoxState.ERROR, desiredState: BoxDesiredState.STARTED })
    await expect(recovery.recover(organization, checkpoint.id, target.id, 1)).rejects.toThrow()
    expect(await jobs.countBy({ type: JobType.IMPORT_CHECKPOINT })).toBe(0)
    const admitted = await recovery.recover(organization, checkpoint.id, target.id, 2)
    const operation = await dataSource
      .getRepository(CheckpointOperation)
      .findOneByOrFail({ jobId: admitted.checkpointJobId! })
    await finish(operation.jobId, {
      operationId: operation.id,
      targetSequence: operation.sequence,
      nativeId: 'native-ready-to-start',
    })
    expect(await boxes.findOneByOrFail({ id: target.id })).toMatchObject({
      state: BoxState.STOPPED,
      desiredState: BoxDesiredState.STARTED,
      checkpointJobId: null,
      cpu: 4,
    })
  })

  it('joins concurrent recovery requests without creating another operation or job', async () => {
    const checkpoint = await readyCheckpoint()
    const target = await source('target')
    const results = await Promise.all(
      Array.from({ length: 6 }, () => recovery.recover(organization, checkpoint.id, target.id, 2)),
    )
    expect(new Set(results.map((box) => box.checkpointJobId)).size).toBe(1)
    expect(await jobs.countBy({ type: JobType.IMPORT_CHECKPOINT })).toBe(1)
    expect(await dataSource.getRepository(CheckpointOperation).count()).toBe(1)
  })

  it('replays a native success after the configuration transaction rolls back', async () => {
    const checkpoint = await readyCheckpoint()
    const target = await source('target')
    await boxes.update(target.id, { cpu: 1, mem: 1, disk: 2, env: { OLD: 'committed' } })
    const admitted = await recovery.recover(organization, checkpoint.id, target.id, undefined)
    const operation = await dataSource
      .getRepository(CheckpointOperation)
      .findOneByOrFail({ jobId: admitted.checkpointJobId! })
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
      expect(await boxes.findOneByOrFail({ id: target.id })).toMatchObject({
        state: BoxState.RESTORING,
        pending: true,
        cpu: 1,
        mem: 1,
        disk: 2,
        env: { OLD: 'committed' },
        checkpointJobId: operation.jobId,
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
    expect(await boxes.findOneByOrFail({ id: target.id })).toMatchObject({
      state: BoxState.STOPPED,
      pending: false,
      checkpointJobId: null,
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
    'retains ownership and committed configuration on an invalid %s receipt',
    async (field) => {
      const checkpoint = await readyCheckpoint()
      const target = await source('target')
      await boxes.update(target.id, { cpu: 1, env: { OLD: 'committed' } })
      const admitted = await recovery.recover(organization, checkpoint.id, target.id, undefined)
      const operation = await dataSource
        .getRepository(CheckpointOperation)
        .findOneByOrFail({ jobId: admitted.checkpointJobId! })
      const receipt: Record<string, unknown> = {
        operationId: operation.id,
        targetSequence: operation.sequence,
        nativeId: 'new-native',
      }
      delete receipt[field]
      await finish(operation.jobId, receipt)
      expect(await boxes.findOneByOrFail({ id: target.id })).toMatchObject({
        state: BoxState.ERROR,
        pending: true,
        checkpointJobId: operation.jobId,
        cpu: 1,
        env: { OLD: 'committed' },
      })
      expect(await dataSource.getRepository(CheckpointOperation).findOneByOrFail({ id: operation.id })).toMatchObject({
        state: 'failed',
        nativeId: null,
      })
      expect(await service.get(organizationId, checkpoint.id)).toMatchObject({ state: 'ready' })
      const retry = await recovery.recover(organization, checkpoint.id, target.id, undefined)
      expect(retry.checkpointSequence).toBe(operation.sequence)
      expect(retry.checkpointJobId).not.toBe(operation.jobId)
    },
  )

  it('rejects recovery while a target has an active migration between jobs', async () => {
    const checkpoint = await readyCheckpoint()
    const target = await source('target')
    await dataSource.getRepository(BoxMigration).save(
      Object.assign(new BoxMigration(), {
        boxId: target.id,
        state: BoxMigrationState.PENDING_IMPORT,
        updatedAt: target.updatedAt,
      }),
    )
    await expect(recovery.recover(organization, checkpoint.id, target.id, undefined)).rejects.toMatchObject({
      status: 409,
    })
    expect(await jobs.countBy({ type: JobType.IMPORT_CHECKPOINT })).toBe(0)
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
    expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({
      pending: true,
      checkpointJobId: checkpoint.exportJobId,
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
    expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({
      pending: false,
      checkpointJobId: null,
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
    expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({
      pending: true,
      checkpointJobId: second.exportJobId,
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
    expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({ pending: false, checkpointJobId: null })
  })

  it('keeps checkpoints independent of a deleted source', async () => {
    const box = await source()
    const checkpoint = await service.create(organizationId, box.id)
    await finish(checkpoint.exportJobId!, archive(checkpoint))
    await boxes.delete(box.id)
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
      expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({ pending: false, checkpointJobId: null })
    },
  )

  it('rolls a duplicate name back without leaving a job or busy source', async () => {
    const first = await source('first')
    const second = await source('second')
    await service.create(organizationId, first.id, 'duplicate')
    await expect(service.create(organizationId, second.id, 'duplicate')).rejects.toMatchObject({ status: 409 })
    expect(await checkpoints.count()).toBe(1)
    expect(await jobs.count()).toBe(1)
    expect(await boxes.findOneByOrFail({ id: second.id })).toMatchObject({ pending: false, checkpointJobId: null })
  })

  it('records export failure without changing the source lifecycle state', async () => {
    const box = await source()
    const checkpoint = await service.create(organizationId, box.id)
    await finish(checkpoint.exportJobId!, undefined, JobStatus.FAILED)
    expect(await service.get(organizationId, checkpoint.id)).toMatchObject({ state: 'failed', activeJobId: null })
    expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({ pending: false, state: BoxState.STOPPED })
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
    expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({ pending: false, checkpointJobId: null })
  })

  it('refuses an active migration before taking a source job', async () => {
    const box = await source()
    await dataSource
      .getRepository(BoxMigration)
      .insert({ boxId: box.id, state: BoxMigrationState.PENDING_EXPORT, arcPath: '', updatedAt: box.updatedAt })
    await expect(service.create(organizationId, box.id)).rejects.toMatchObject({ status: 409 })
    expect(await jobs.count()).toBe(0)
    expect(await checkpoints.count()).toBe(0)
    expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({ pending: false, checkpointJobId: null })
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

  it('keeps a started source started when export releases its busy flag', async () => {
    const box = await source()
    await boxes.update(box.id, { state: BoxState.STARTED, desiredState: BoxDesiredState.STARTED })
    const checkpoint = await service.create(organizationId, box.id)
    await finish(checkpoint.exportJobId!, archive(checkpoint))
    expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STARTED,
      pending: false,
      checkpointJobId: null,
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
    expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({ pending: true })
    await jobs.update(checkpoint.exportJobId!, { runnerId: runner.id })
    await finish(checkpoint.exportJobId!, { ...archive(checkpoint), arcPath: 'gs://other/object' })
    expect(await service.get(organizationId, checkpoint.id)).toMatchObject({ state: 'failed', activeJobId: null })
    expect(await jobs.countBy({ type: JobType.UPLOAD_CHECKPOINT })).toBe(0)
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
