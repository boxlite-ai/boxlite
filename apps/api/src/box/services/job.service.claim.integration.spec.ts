/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto'
import { DataSource, Repository } from 'typeorm'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { LockCode } from '../common/redis-lock.provider'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { Runner } from '../entities/runner.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxStartAction } from '../managers/box-actions/box-start.action'
import { BoxRepository } from '../repositories/box.repository'
import { RunnerAdapterV2 } from '../runner-adapter/runnerAdapter.v2'
import { JobStateHandlerService } from './job-state-handler.service'
import { ManagedOutboundBootstrap } from './managed-outbound-bootstrap'
import { JobStatus, JobType, ResourceType } from '../dto/job.dto'
import { Job } from '../entities/job.entity'
import { JobService } from './job.service'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `job_claim_${process.pid}_${randomUUID().replaceAll('-', '')}`
const firstJobId = '00000000-0000-4000-8000-000000000001'
const secondJobId = '00000000-0000-4000-8000-000000000002'
const rejectedJobId = '00000000-0000-4000-8000-000000000003'
const rejectConstraint = 'reject_one_in_progress_job'
const runnerId = '8137cc0d-5d3f-43b8-aa32-b9304740269e'

function claimPendingJobs(service: JobService, runnerId: string, limit: number) {
  return (service as any).claimPendingJobs(runnerId, limit) as Promise<Array<{ id: string; status: JobStatus }>>
}

function pendingJob(id: string, resourceId: string, createdAt: Date): Job {
  const job = new Job({
    id,
    type: JobType.CREATE_BOX,
    runnerId,
    resourceType: ResourceType.BOX,
    resourceId,
  })
  job.createdAt = createdAt
  job.updatedAt = createdAt
  return job
}

describeIfDatabase('JobService.claimPendingJobs (integration, real Postgres)', () => {
  let dataSource: DataSource
  let repository: Repository<Job>
  let boxes: BoxRepository
  let service: JobService
  let completions: JobStateHandlerService
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
      entities: [Job, Box, BoxLastActivity, Runner],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      synchronize: false,
      extra: {
        max: 1,
        connectionTimeoutMillis: 1500,
        options: `-c search_path=${schemaName},public -c lock_timeout=1000`,
      },
    }).initialize()

    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    ownsSchema = true
    await dataSource.synchronize()
    await dataSource.query(
      'CREATE TABLE outbound_proxy_reference (organization_id uuid, box_id varchar, runner_id uuid)',
    )
    await dataSource.query(`CREATE TABLE organization_activation_facts (
      "organizationId" uuid PRIMARY KEY, "lastBoxCreatedAt" timestamptz, "lastBoxModifiedAt" timestamptz
    )`)
    repository = dataSource.getRepository(Job)
    boxes = new BoxRepository(
      dataSource,
      { emit: jest.fn() } as never,
      { invalidate: jest.fn(), invalidateOrgId: jest.fn() } as never,
    )
    completions = new JobStateHandlerService(boxes, {} as never, {} as never, {} as never, {} as never)
    service = new JobService(repository, { lpush: jest.fn().mockResolvedValue(1) } as any, {} as any)
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
    await repository.clear()
  })

  async function lifecycleBox(): Promise<Box> {
    const box = new Box('us', 'queued-box')
    box.organizationId = randomUUID()
    box.runnerId = runnerId
    box.osUser = 'boxlite'
    box.labels = {}
    box.pending = true
    await dataSource.getRepository(Box).insert(box)
    return box
  }

  async function seedProtectedIntent(box: Box): Promise<void> {
    const bootstrap = new ManagedOutboundBootstrap(dataSource, {} as never)
    await dataSource.transaction((manager) => bootstrap.seed(manager, box, null))
  }

  afterEach(async () => {
    await dataSource.query(`ALTER TABLE "${schemaName}"."job" DROP CONSTRAINT IF EXISTS "${rejectConstraint}"`)
  })

  it('claims a persisted job without reconstructing the returned database row', async () => {
    const createdAt = new Date('2026-08-10T10:00:00.000Z')
    await repository.insert(pendingJob(firstJobId, 'box-claim-success', createdAt))

    const claimed = await claimPendingJobs(service, runnerId, 10)

    expect(claimed).toEqual([expect.objectContaining({ id: firstJobId, status: JobStatus.IN_PROGRESS })])
    expect(await repository.findOneByOrFail({ id: firstJobId })).toEqual(
      expect.objectContaining({ status: JobStatus.IN_PROGRESS, startedAt: expect.any(Date) }),
    )
  })

  it('keeps the lock owner in PostgreSQL when a Runner claims its job', async () => {
    const box = await lifecycleBox()
    const lockOwner = new LockCode(randomUUID())
    const job = await service.createJob(null, JobType.STOP_BOX, runnerId, ResourceType.BOX, box.id, {}, lockOwner)

    const [claimed] = await claimPendingJobs(service, runnerId, 1)

    expect(claimed).toMatchObject({ id: job.id, status: JobStatus.IN_PROGRESS })
    expect(claimed).not.toHaveProperty('stateChangeLockOwner')
    expect(await repository.findOneByOrFail({ id: job.id })).toMatchObject({
      stateChangeLockOwner: lockOwner.getCode(),
    })
  })

  it('refuses an ordinary lifecycle job after protected ownership is recorded', async () => {
    const box = await lifecycleBox()
    await seedProtectedIntent(box)

    await expect(
      service.createJob(null, JobType.DESTROY_BOX, runnerId, ResourceType.BOX, box.id),
    ).rejects.toMatchObject({
      status: 409,
    })
    expect(await repository.countBy({ resourceId: box.id })).toBe(0)
  })

  it('keeps a late ordinary start result from overwriting a protected Box', async () => {
    const box = await lifecycleBox()
    const job = await service.createJob(null, JobType.START_BOX, runnerId, ResourceType.BOX, box.id)
    await seedProtectedIntent(box)

    job.status = JobStatus.COMPLETED
    await completions.handleJobCompletion(job)

    expect(await dataSource.getRepository(Box).findOneByOrFail({ id: box.id })).toMatchObject({
      state: BoxState.UNKNOWN,
    })
  })

  it('publishes a start result for a Box still assigned to the ordinary job', async () => {
    const box = await lifecycleBox()
    const job = await service.createJob(null, JobType.START_BOX, runnerId, ResourceType.BOX, box.id)

    job.status = JobStatus.COMPLETED
    await completions.handleJobCompletion(job)

    expect(await dataSource.getRepository(Box).findOneByOrFail({ id: box.id })).toMatchObject({
      state: BoxState.STARTED,
    })
  })

  it('queues previous V2 Runner cleanup with one database connection', async () => {
    const box = await lifecycleBox()
    const previous = await dataSource.getRepository(Runner).save(
      new Runner({
        name: 'previous',
        region: 'us',
        apiVersion: '2',
        apiKey: 'fixture',
      }),
    )
    await dataSource.getRepository(Box).update(box.id, { state: BoxState.STARTING, prevRunnerId: previous.id })
    const previousAdapter = new RunnerAdapterV2(boxes, repository, service)
    await previousAdapter.init(previous)
    const lock = new LockCode(randomUUID())
    const action = new BoxStartAction(
      { findOneOrFail: async () => ({ id: runnerId }), findOne: async () => previous } as never,
      {
        create: async (runner: Runner) =>
          runner.id === previous.id ? previousAdapter : { boxInfo: async () => ({ state: BoxState.STARTED }) },
      } as never,
      boxes,
      {} as never,
      {} as never,
      { getCode: async () => lock } as never,
      {} as never,
      {} as never,
    )

    await action.run(await boxes.findOneByOrFail({ id: box.id }), lock)

    expect(await repository.findOneByOrFail({ resourceId: box.id })).toMatchObject({
      runnerId: previous.id,
      type: JobType.DESTROY_BOX,
    })
    expect(await boxes.findOneByOrFail({ id: box.id })).toMatchObject({ prevRunnerId: null, state: BoxState.STARTED })
  })

  it('leaves the whole selected batch pending when one claim update is rejected', async () => {
    await repository.insert([
      pendingJob(firstJobId, 'box-claim-first', new Date('2026-08-10T10:00:00.000Z')),
      pendingJob(rejectedJobId, 'box-claim-rejected', new Date('2026-08-10T10:00:01.000Z')),
      pendingJob(secondJobId, 'box-not-selected', new Date('2026-08-10T10:00:02.000Z')),
    ])
    await dataSource.query(
      `ALTER TABLE "${schemaName}"."job" ADD CONSTRAINT "${rejectConstraint}" CHECK ("id" <> '${rejectedJobId}' OR "status" <> '${JobStatus.IN_PROGRESS}')`,
    )

    await expect(claimPendingJobs(service, runnerId, 2)).rejects.toThrow()

    const selected = await repository.find({
      where: [{ id: firstJobId }, { id: rejectedJobId }],
      order: { createdAt: 'ASC' },
    })
    expect(selected.map((job) => job.status)).toEqual([JobStatus.PENDING, JobStatus.PENDING])
  })
})
