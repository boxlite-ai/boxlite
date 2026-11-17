// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import { randomUUID } from 'node:crypto'
import { ConfigService } from '@nestjs/config'
import { ReplayBusinessFixture } from '../../test/request-replay-business.fixture'
import { BoxliteCheckpointController } from './boxlite-checkpoint.controller'
import { BoxliteVolumeController } from './boxlite-volume.controller'
import { CheckpointService } from '../box/services/checkpoint.service'
import { CheckpointJobReceiver } from '../box/services/checkpoint-job-receiver.service'
import { JobService } from '../box/services/job.service'
import { VolumeService } from '../box/services/volume.service'
import { BoxRepository } from '../box/repositories/box.repository'
import { Checkpoint, CheckpointArchive } from '../box/entities/checkpoint.entity'
import { Box } from '../box/entities/box.entity'
import { Runner } from '../box/entities/runner.entity'
import { Job } from '../box/entities/job.entity'
import { Volume } from '../box/entities/volume.entity'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxDesiredState } from '../box/enums/box-desired-state.enum'
import { RunnerState } from '../box/enums/runner-state.enum'
import { VolumeState } from '../box/enums/volume-state.enum'
import { JobStatus } from '../box/enums/job-status.enum'
import { JobType } from '../box/enums/job-type.enum'

const describeWithServices = process.env.DB_HOST && process.env.REDIS_HOST ? describe : describe.skip

describeWithServices('Request replay resources (HTTP, PostgreSQL and Redis)', () => {
  let fixture: ReplayBusinessFixture
  let checkpoints: CheckpointService
  let receiver: CheckpointJobReceiver
  const archiveStore = { remove: jest.fn() }
  const notifications = { lpush: jest.fn().mockResolvedValue(1) }

  beforeEach(async () => {
    fixture = new ReplayBusinessFixture()
    await fixture.open()
    const cache = { invalidate: jest.fn(), invalidateOrgId: jest.fn() }
    const events = { emit: jest.fn(), emitAsync: jest.fn().mockResolvedValue([]) }
    const repository = new BoxRepository(fixture.db, events as never, cache as never)
    const jobs = new JobService(fixture.db.getRepository(Job), notifications as never, {} as never)
    archiveStore.remove.mockReset().mockResolvedValue(undefined)
    notifications.lpush.mockClear()
    checkpoints = new CheckpointService(
      fixture.db,
      {
        get: () => ({ archivePrefix: 'gs://replay-tests/checkpoints/', maxPerOrganization: 10, enabled: true }),
      } as unknown as ConfigService,
      jobs,
      cache as never,
      archiveStore as never,
    )
    receiver = new CheckpointJobReceiver(fixture.db, cache as never, events as never, notifications as never)
    const volumes = new VolumeService(
      fixture.db.getRepository(Volume),
      repository,
      { assertOrganizationIsNotSuspended: () => undefined } as never,
      { get: (key: string) => (key === 'volume.storageBackend' ? 'gcs' : undefined) } as never,
      {} as never,
    )
    // The storage worker is outside this request. Persist READY at its database boundary,
    // leaving the production create and waitForReady implementations intact.
    fixture.db.subscribers.push({
      listenTo: () => Volume,
      afterInsert: async (event) => {
        await event.manager.update(Volume, event.entity.id, { state: VolumeState.READY })
      },
    })
    await fixture.serve(
      [BoxliteCheckpointController, BoxliteVolumeController],
      [
        { provide: CheckpointService, useValue: checkpoints },
        { provide: VolumeService, useValue: volumes },
      ],
    )
  })
  afterEach(async () => fixture?.close())

  async function finish(jobId: string, archive: CheckpointArchive) {
    const jobs = fixture.db.getRepository(Job)
    await jobs.update(jobId, {
      status: JobStatus.COMPLETED,
      completedAt: new Date(),
      resultMetadata: JSON.stringify(archive),
    })
    await receiver.handleJobCompletion(await jobs.findOneByOrFail({ id: jobId }))
  }

  it('returns the unnamed checkpoint creating response after export and upload finish, then replays deletion', async () => {
    const runner = new Runner({
      region: 'us',
      name: 'replay',
      apiKey: 'test-key',
      apiVersion: '2',
      cpu: 64,
      memoryGiB: 128,
      diskGiB: 1000,
    })
    runner.state = RunnerState.READY
    await fixture.db.getRepository(Runner).save(runner)
    const box = Object.assign(new Box('us', 'checkpoint-source'), {
      organizationId: fixture.organization.id,
      runnerId: runner.id,
      osUser: 'boxlite',
      state: BoxState.STOPPED,
      desiredState: BoxDesiredState.STOPPED,
      image: 'registry.example/app:tag',
      cpu: 4,
      mem: 8,
      disk: 12,
      env: {},
      entrypoint: ['/app'],
      cmd: [],
      workingDir: '/work',
    })
    await fixture.db.getRepository(Box).save(box)
    const key = randomUUID()
    const body = { source_box_id: box.id }
    const original = await fixture.request('POST', 'checkpoints', key, body)
    expect(original.body).toMatchObject({ state: 'creating', source_box_id: box.id })
    const checkpoint = await fixture.db.getRepository(Checkpoint).findOneByOrFail({ sourceBoxId: box.id })
    expect(original.body?.id).toBe(checkpoint.id)
    const archive: CheckpointArchive = {
      checkpointId: checkpoint.id,
      exportJobId: checkpoint.exportJobId!,
      sourceBoxId: box.id,
      arcPath: checkpoint.arcPath,
      sizeBytes: 1024,
      sha256: 'a'.repeat(64),
      pinnedImage: `registry.example/app@sha256:${'b'.repeat(64)}`,
    }
    await finish(checkpoint.exportJobId!, archive)
    const uploading = await checkpoints.get(fixture.organization.id, checkpoint.id)
    await finish(uploading.activeJobId!, archive)
    expect((await checkpoints.get(fixture.organization.id, checkpoint.id)).state).toBe('ready')
    await fixture.replay('POST', 'checkpoints', key, original, body)
    expect(await fixture.db.getRepository(Checkpoint).count()).toBe(1)
    expect(await fixture.db.getRepository(Job).countBy({ type: JobType.EXPORT_CHECKPOINT })).toBe(1)
    expect(await fixture.db.getRepository(Job).countBy({ type: JobType.UPLOAD_CHECKPOINT })).toBe(1)
    const deleteKey = randomUUID()
    const removed = await fixture.request('DELETE', `checkpoints/${checkpoint.id}`, deleteKey)
    expect(await fixture.db.getRepository(Checkpoint).count()).toBe(0)
    await fixture.replay('DELETE', `checkpoints/${checkpoint.id}`, deleteKey, removed)
    expect(archiveStore.remove).toHaveBeenCalledTimes(1)
  })

  it('creates one unnamed volume and preserves ready bytes after its state changes and deletion completes', async () => {
    const key = randomUUID()
    const original = await fixture.request('POST', 'volumes', key, {})
    const volume = await fixture.db.getRepository(Volume).findOneByOrFail({ organizationId: fixture.organization.id })
    expect(original.body).toMatchObject({ id: volume.id, name: volume.id, state: VolumeState.READY })
    await fixture.db.getRepository(Volume).update(volume.id, { state: VolumeState.ERROR })
    const events = [...fixture.events]
    await fixture.replay('POST', 'volumes', key, original, {})
    expect(await fixture.db.getRepository(Volume).count()).toBe(1)
    expect(fixture.events).toEqual(events)
    const deleteKey = randomUUID()
    const removed = await fixture.request('DELETE', `volumes/${volume.id}`, deleteKey)
    expect((await fixture.db.getRepository(Volume).findOneByOrFail({ id: volume.id })).state).toBe(
      VolumeState.PENDING_DELETE,
    )
    await fixture.db.getRepository(Volume).delete(volume.id)
    const deletionEvents = [...fixture.events]
    await fixture.replay('DELETE', `volumes/${volume.id}`, deleteKey, removed)
    expect(fixture.events).toEqual(deletionEvents)
    expect(await fixture.db.getRepository(Volume).count()).toBe(0)
    expect(
      events.filter((event) => event['event.name'] === 'volume.create' && event['event.outcome'] === 'success'),
    ).toHaveLength(1)
  })
})
