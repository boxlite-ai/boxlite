/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { ConflictException } from '@nestjs/common'
import { DataSource, IsNull, Not } from 'typeorm'
import { Box } from '../../box/entities/box.entity'
import { BoxLastActivity } from '../../box/entities/box-last-activity.entity'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BoxState } from '../../box/enums/box-state.enum'
import { BoxRepository } from '../../box/repositories/box.repository'
import { Job } from '../../box/entities/job.entity'
import { JobStatus } from '../../box/enums/job-status.enum'
import { JobType } from '../../box/enums/job-type.enum'
import { ResourceType } from '../../box/enums/resource-type.enum'
import { JobService } from '../../box/services/job.service'
import { JobStateHandlerService } from '../../box/services/job-state-handler.service'
import { Region } from '../../region/entities/region.entity'
import { RegionType } from '../../region/enums/region-type.enum'
import { BoxUsagePeriod } from '../entities/box-usage-period.entity'
import { MeteringPolicy } from './metering-policy'
import { UsagePeriodWriter } from './usage-period-writer'

const RUN_DATABASE_TESTS = process.env.BILLING_EDGE_DB_TESTS === '1'
const describeWithDatabase = RUN_DATABASE_TESTS ? describe : describe.skip
const schemaName = `metering_consistency_${randomUUID().replaceAll('-', '')}`

function connectionOptions() {
  return {
    type: 'postgres' as const,
    host: process.env.BILLING_EDGE_DB_HOST ?? process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.BILLING_EDGE_DB_PORT ?? process.env.DB_PORT ?? '25432'),
    username: process.env.BILLING_EDGE_DB_USERNAME ?? process.env.DB_USERNAME ?? 'boxlite',
    password: process.env.BILLING_EDGE_DB_PASSWORD ?? process.env.DB_PASSWORD ?? 'boxlite',
    database: process.env.BILLING_EDGE_DB_DATABASE ?? process.env.DB_DATABASE ?? 'boxlite',
  }
}

describeWithDatabase('Box metering consistency with PostgreSQL', () => {
  let controlDataSource: DataSource
  let dataSource: DataSource
  let eventEmitter: { emit: jest.Mock }
  let repository: BoxRepository

  beforeAll(async () => {
    if (!/^metering_consistency_[a-f0-9]+$/.test(schemaName)) {
      throw new Error(`unsafe metering test schema name: ${schemaName}`)
    }

    controlDataSource = await new DataSource(connectionOptions()).initialize()
    await controlDataSource.query(`CREATE SCHEMA "${schemaName}"`)

    dataSource = await new DataSource({
      ...connectionOptions(),
      schema: schemaName,
      entities: [Region, Box, BoxLastActivity, BoxUsagePeriod, Job],
      entitySkipConstructor: true,
      synchronize: true,
      dropSchema: false,
      extra: { max: 10, options: `-c search_path=${schemaName},public` },
    }).initialize()
  }, 30_000)

  beforeEach(() => {
    eventEmitter = { emit: jest.fn() }
    repository = new BoxRepository(
      dataSource,
      eventEmitter as never,
      { invalidate: jest.fn(), invalidateOrgId: jest.fn() } as never,
      new UsagePeriodWriter(new MeteringPolicy()),
    )
  })

  afterEach(async () => {
    if (!dataSource?.isInitialized) return
    await dataSource.query(
      `TRUNCATE TABLE "${schemaName}"."job", "${schemaName}"."box_usage_period", "${schemaName}"."box_last_activity", "${schemaName}"."box", "${schemaName}"."region" CASCADE`,
    )
  })

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy()
    if (controlDataSource?.isInitialized) {
      await controlDataSource.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
      await controlDataSource.destroy()
    }
  })

  async function seedBox(
    state: BoxState,
    desiredState: BoxDesiredState,
    allocation: 'full' | 'disk' | 'none',
  ): Promise<Box> {
    const regionId = `region-${randomUUID().slice(0, 8)}`
    const region = new Region({
      id: regionId,
      name: regionId,
      enforceQuotas: true,
      regionType: RegionType.SHARED,
      organizationId: null,
    })
    await dataSource.getRepository(Region).save(region)

    const box = new Box(regionId, `box-${randomUUID().slice(0, 8)}`)
    box.id = randomUUID().replaceAll('-', '').slice(0, 12)
    box.organizationId = randomUUID()
    box.osUser = 'box'
    box.labels = {}
    box.state = state
    box.desiredState = desiredState
    box.pending = state !== (desiredState as unknown as BoxState)
    box.createdAt = new Date('2026-07-21T00:00:00.000Z')
    box.updatedAt = box.createdAt
    await dataSource.getRepository(Box).save(box)

    if (allocation !== 'none') {
      await dataSource.getRepository(BoxUsagePeriod).save(
        Object.assign(new BoxUsagePeriod(), {
          boxId: box.id,
          organizationId: box.organizationId,
          startAt: new Date('2026-07-21T00:00:00.000Z'),
          endAt: null,
          cpu: allocation === 'full' ? box.cpu : 0,
          gpu: allocation === 'full' ? box.gpu : 0,
          mem: allocation === 'full' ? box.mem : 0,
          disk: box.disk,
          region: box.region,
          boxClass: box.class,
          regionType: RegionType.SHARED,
        }),
      )
    }

    return box
  }

  it('ends FULL metering in the transaction that accepts a stop intent', async () => {
    const box = await seedBox(BoxState.STARTED, BoxDesiredState.STARTED, 'full')

    await repository.updateWhere(box.id, {
      updateData: { pending: true, desiredState: BoxDesiredState.STOPPED },
      whereCondition: { pending: false, state: BoxState.STARTED, desiredState: BoxDesiredState.STARTED },
    })

    const periods = await dataSource.getRepository(BoxUsagePeriod).find({ order: { startAt: 'ASC' } })
    expect(periods).toHaveLength(2)
    expect(periods[0]).toMatchObject({ cpu: box.cpu, endAt: expect.any(Date) })
    expect(periods[1]).toMatchObject({ cpu: 0, mem: 0, gpu: 0, disk: box.disk, endAt: null })
    expect(periods[0].endAt).toEqual(periods[1].startAt)
  })

  it('keeps a restarted Box disk-only until STARTED is confirmed', async () => {
    const box = await seedBox(BoxState.STOPPED, BoxDesiredState.STOPPED, 'disk')

    await repository.updateWhere(box.id, {
      updateData: { pending: true, desiredState: BoxDesiredState.STARTED },
      whereCondition: { pending: false, state: BoxState.STOPPED, desiredState: BoxDesiredState.STOPPED },
    })
    await expect(dataSource.getRepository(BoxUsagePeriod).count()).resolves.toBe(1)

    await repository.updateWhere(box.id, {
      updateData: { state: BoxState.STARTED, errorReason: null },
      whereCondition: { pending: true, state: BoxState.STOPPED, desiredState: BoxDesiredState.STARTED },
    })

    const periods = await dataSource.getRepository(BoxUsagePeriod).find({ order: { startAt: 'ASC' } })
    expect(periods).toHaveLength(2)
    expect(periods[0]).toMatchObject({ cpu: 0, endAt: expect.any(Date) })
    expect(periods[1]).toMatchObject({ cpu: box.cpu, mem: box.mem, disk: box.disk, endAt: null })
    expect(periods[0].endAt).toEqual(periods[1].startAt)
  })

  it('rolls back the Box update and old period close when the new period insert fails', async () => {
    const box = await seedBox(BoxState.STARTED, BoxDesiredState.STARTED, 'full')
    const functionName = `fail_metering_insert_${randomUUID().replaceAll('-', '')}`

    await dataSource.query(`
      CREATE FUNCTION "${schemaName}"."${functionName}"() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'forced usage insert failure';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_metering_insert
      BEFORE INSERT ON "${schemaName}"."box_usage_period"
      FOR EACH ROW EXECUTE FUNCTION "${schemaName}"."${functionName}"();
    `)

    try {
      await expect(
        repository.updateWhere(box.id, {
          updateData: { pending: true, desiredState: BoxDesiredState.STOPPED },
          whereCondition: { pending: false, state: BoxState.STARTED, desiredState: BoxDesiredState.STARTED },
        }),
      ).rejects.toThrow('forced usage insert failure')

      await expect(dataSource.getRepository(Box).findOneByOrFail({ id: box.id })).resolves.toMatchObject({
        state: BoxState.STARTED,
        desiredState: BoxDesiredState.STARTED,
        pending: false,
      })
      await expect(
        dataSource.getRepository(BoxUsagePeriod).findOneByOrFail({ boxId: box.id, endAt: IsNull() }),
      ).resolves.toMatchObject({ cpu: box.cpu, endAt: null })
      expect(eventEmitter.emit).not.toHaveBeenCalled()
    } finally {
      await dataSource.query(`DROP TRIGGER IF EXISTS fail_metering_insert ON "${schemaName}"."box_usage_period"`)
      await dataSource.query(`DROP FUNCTION IF EXISTS "${schemaName}"."${functionName}"()`)
    }
  })

  it('serializes concurrent stop attempts and leaves one open period', async () => {
    const box = await seedBox(BoxState.STARTED, BoxDesiredState.STARTED, 'full')
    const otherRepository = new BoxRepository(
      dataSource,
      { emit: jest.fn() } as never,
      { invalidate: jest.fn(), invalidateOrgId: jest.fn() } as never,
      new UsagePeriodWriter(new MeteringPolicy()),
    )
    const stop = (boxRepository: BoxRepository) =>
      boxRepository.updateWhere(box.id, {
        updateData: { pending: true, desiredState: BoxDesiredState.STOPPED },
        whereCondition: { pending: false, state: BoxState.STARTED, desiredState: BoxDesiredState.STARTED },
      })

    const results = await Promise.allSettled([stop(repository), stop(otherRepository)])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    await expect(dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id, endAt: IsNull() })).resolves.toBe(1)
    await expect(
      dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id, endAt: Not(IsNull()) }),
    ).resolves.toBe(1)
  })

  it('never creates FULL metering when a start attempt fails', async () => {
    const box = await seedBox(BoxState.STOPPED, BoxDesiredState.STOPPED, 'disk')

    await repository.updateWhere(box.id, {
      updateData: { pending: true, desiredState: BoxDesiredState.STARTED },
      whereCondition: { pending: false, state: BoxState.STOPPED, desiredState: BoxDesiredState.STOPPED },
    })
    await repository.updateWhere(box.id, {
      updateData: { state: BoxState.ERROR, errorReason: 'start failed' },
      whereCondition: { pending: true, state: BoxState.STOPPED, desiredState: BoxDesiredState.STARTED },
    })

    await expect(dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id, cpu: Not(0) })).resolves.toBe(0)
    await expect(dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id, endAt: IsNull() })).resolves.toBe(0)
  })

  it('cuts a new FULL period with the confirmed resize allocation', async () => {
    const box = await seedBox(BoxState.STARTED, BoxDesiredState.STARTED, 'full')

    await repository.updateWhere(box.id, {
      updateData: { state: BoxState.RESIZING },
      whereCondition: { state: BoxState.STARTED, desiredState: BoxDesiredState.STARTED },
    })
    await repository.updateWhere(box.id, {
      updateData: { state: BoxState.STARTED, cpu: 4, mem: 8, disk: 20 },
      whereCondition: { state: BoxState.RESIZING, desiredState: BoxDesiredState.STARTED },
    })

    const periods = await dataSource.getRepository(BoxUsagePeriod).find({ order: { startAt: 'ASC' } })
    expect(periods).toHaveLength(2)
    expect(periods[0].endAt).toEqual(periods[1].startAt)
    expect(periods[1]).toMatchObject({ cpu: 4, mem: 8, disk: 20, endAt: null })
  })

  it('enforces non-negative usage durations in PostgreSQL', async () => {
    const period = Object.assign(new BoxUsagePeriod(), {
      boxId: 'box000000099',
      organizationId: randomUUID(),
      startAt: new Date('2026-07-22T00:00:01.000Z'),
      endAt: new Date('2026-07-22T00:00:00.000Z'),
      cpu: 1,
      gpu: 0,
      mem: 1,
      disk: 1,
      region: 'region-1',
      regionType: RegionType.SHARED,
    })

    await expect(dataSource.getRepository(BoxUsagePeriod).save(period)).rejects.toMatchObject({ code: '23514' })
  })

  it('reconciles an interrupted terminal Job once and rejects later replays', async () => {
    const box = await seedBox(BoxState.STOPPED, BoxDesiredState.STOPPED, 'disk')
    await repository.updateWhere(box.id, {
      updateData: { desiredState: BoxDesiredState.STARTED, pending: true },
      whereCondition: { state: BoxState.STOPPED, desiredState: BoxDesiredState.STOPPED, pending: false },
    })

    const jobStateHandler = new JobStateHandlerService(repository)
    const jobService = new JobService(
      dataSource.getRepository(Job),
      { lpush: jest.fn().mockResolvedValue(1) } as never,
      jobStateHandler,
    )
    const job = await jobService.createJob(null, JobType.START_BOX, randomUUID(), ResourceType.BOX, box.id)

    job.status = JobStatus.COMPLETED
    job.completedAt = new Date()
    await dataSource.getRepository(Job).save(job)

    await jobService.reconcileTerminalBoxJobs()
    const reconciledBox = await dataSource.getRepository(Box).findOneByOrFail({ id: box.id })
    expect(reconciledBox).toMatchObject({ state: BoxState.STARTED, lifecycleJobId: null })
    await expect(dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id })).resolves.toBe(2)

    await jobService.reconcileTerminalBoxJobs()
    await expect(dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id })).resolves.toBe(2)
  })

  it('handles concurrent terminal callbacks exactly once', async () => {
    const box = await seedBox(BoxState.STOPPED, BoxDesiredState.STOPPED, 'disk')
    await repository.updateWhere(box.id, {
      updateData: { desiredState: BoxDesiredState.STARTED, pending: true },
      whereCondition: { state: BoxState.STOPPED, desiredState: BoxDesiredState.STOPPED, pending: false },
    })

    const jobService = new JobService(
      dataSource.getRepository(Job),
      { lpush: jest.fn().mockResolvedValue(1) } as never,
      {} as never,
    )
    const job = await jobService.createJob(null, JobType.START_BOX, randomUUID(), ResourceType.BOX, box.id)
    job.status = JobStatus.COMPLETED

    let initialReads = 0
    let releaseInitialReads!: () => void
    const bothCallbacksReadOwner = new Promise<void>((resolve) => {
      releaseInitialReads = resolve
    })
    const wrapRepository = () => ({
      findOne: async (...args: Parameters<BoxRepository['findOne']>) => {
        const current = await repository.findOne(...args)
        if (current?.lifecycleJobId === job.id && initialReads < 2) {
          initialReads += 1
          if (initialReads === 2) releaseInitialReads()
          await bothCallbacksReadOwner
        }
        return current
      },
      update: repository.update.bind(repository),
    })
    const firstHandler = new JobStateHandlerService(wrapRepository() as never)
    const secondHandler = new JobStateHandlerService(wrapRepository() as never)

    await expect(
      Promise.all([firstHandler.handleJobCompletion(job), secondHandler.handleJobCompletion(job)]),
    ).resolves.toEqual([undefined, undefined])

    await expect(dataSource.getRepository(Box).findOneByOrFail({ id: box.id })).resolves.toMatchObject({
      state: BoxState.STARTED,
      lifecycleJobId: null,
    })
    await expect(dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id })).resolves.toBe(2)
    await expect(
      dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id, endAt: IsNull(), cpu: box.cpu }),
    ).resolves.toBe(1)
  })

  it('keeps Job, Box, and usage consistent when opposite terminal statuses race', async () => {
    const box = await seedBox(BoxState.STOPPED, BoxDesiredState.STOPPED, 'disk')
    await repository.updateWhere(box.id, {
      updateData: { desiredState: BoxDesiredState.STARTED, pending: true },
      whereCondition: { state: BoxState.STOPPED, desiredState: BoxDesiredState.STOPPED, pending: false },
    })

    const jobService = new JobService(
      dataSource.getRepository(Job),
      { lpush: jest.fn().mockResolvedValue(1) } as never,
      new JobStateHandlerService(repository),
    )
    const job = await jobService.createJob(null, JobType.START_BOX, randomUUID(), ResourceType.BOX, box.id)
    await jobService.updateJobStatus(job.id, JobStatus.IN_PROGRESS)
    const jobBeforeTerminal = await dataSource.getRepository(Job).findOneByOrFail({ id: job.id })

    const outcomes = await Promise.allSettled([
      jobService.updateJobStatus(job.id, JobStatus.COMPLETED),
      jobService.updateJobStatus(job.id, JobStatus.FAILED, 'runner reported start failure'),
    ])

    const fulfilled = outcomes.find((outcome): outcome is PromiseFulfilledResult<Job> => outcome.status === 'fulfilled')
    const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    expect(fulfilled).toBeDefined()
    expect(rejected?.reason).toBeInstanceOf(ConflictException)

    const persistedJob = await dataSource.getRepository(Job).findOneByOrFail({ id: job.id })
    const persistedBox = await dataSource.getRepository(Box).findOneByOrFail({ id: box.id })
    expect(persistedJob).toMatchObject({
      status: fulfilled?.value.status,
      completedAt: expect.any(Date),
      version: jobBeforeTerminal.version + 1,
    })
    expect(persistedBox).toMatchObject({ lifecycleJobId: null, pending: false })

    if (persistedJob.status === JobStatus.COMPLETED) {
      expect(persistedBox).toMatchObject({
        state: BoxState.STARTED,
        desiredState: BoxDesiredState.STARTED,
      })
      await expect(dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id })).resolves.toBe(2)
      await expect(
        dataSource
          .getRepository(BoxUsagePeriod)
          .countBy({ boxId: box.id, endAt: Not(IsNull()), cpu: 0, disk: box.disk }),
      ).resolves.toBe(1)
      await expect(
        dataSource
          .getRepository(BoxUsagePeriod)
          .countBy({ boxId: box.id, endAt: IsNull(), cpu: box.cpu, mem: box.mem, disk: box.disk }),
      ).resolves.toBe(1)
    } else {
      expect(persistedJob.status).toBe(JobStatus.FAILED)
      expect(persistedBox).toMatchObject({
        state: BoxState.ERROR,
        desiredState: BoxDesiredState.STARTED,
      })
      await expect(dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id })).resolves.toBe(1)
      await expect(
        dataSource
          .getRepository(BoxUsagePeriod)
          .countBy({ boxId: box.id, endAt: Not(IsNull()), cpu: 0, disk: box.disk }),
      ).resolves.toBe(1)
      await expect(dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id, endAt: IsNull() })).resolves.toBe(
        0,
      )
      await expect(dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id, cpu: Not(0) })).resolves.toBe(0)
    }
  })

  it('claims one pending Job at most once across concurrent PostgreSQL pollers', async () => {
    const box = await seedBox(BoxState.STOPPED, BoxDesiredState.STOPPED, 'disk')
    const runnerId = randomUUID()
    const firstService = new JobService(
      dataSource.getRepository(Job),
      { lpush: jest.fn().mockResolvedValue(1) } as never,
      {} as never,
    )
    const secondService = new JobService(
      dataSource.getRepository(Job),
      { lpush: jest.fn().mockResolvedValue(1) } as never,
      {} as never,
    )
    const job = await firstService.createJob(
      null,
      JobType.UPDATE_BOX_NETWORK_SETTINGS,
      runnerId,
      ResourceType.BOX,
      box.id,
    )
    const versionBeforeClaim = job.version

    const [firstClaim, secondClaim] = await Promise.all([
      (firstService as any).claimPendingJobs(runnerId, 1),
      (secondService as any).claimPendingJobs(runnerId, 1),
    ])

    const claimed = [...firstClaim, ...secondClaim]
    expect(claimed.map((item) => item.id)).toEqual([job.id])
    expect([firstClaim.length, secondClaim.length].sort()).toEqual([0, 1])
    await expect(dataSource.getRepository(Job).findOneByOrFail({ id: job.id })).resolves.toMatchObject({
      status: JobStatus.IN_PROGRESS,
      startedAt: expect.any(Date),
      version: versionBeforeClaim + 1,
    })
  })

  it('does not time out a lifecycle Job that was freshly claimed after the stale scan', async () => {
    const box = await seedBox(BoxState.STOPPED, BoxDesiredState.STOPPED, 'disk')
    await repository.updateWhere(box.id, {
      updateData: { desiredState: BoxDesiredState.STARTED, pending: true },
      whereCondition: { state: BoxState.STOPPED, desiredState: BoxDesiredState.STOPPED, pending: false },
    })

    const staleRepository = dataSource.getRepository(Job)
    const handler = new JobStateHandlerService(repository)
    const staleService = new JobService(staleRepository, { lpush: jest.fn().mockResolvedValue(1) } as never, handler)
    const claimingService = new JobService(
      dataSource.createEntityManager().getRepository(Job),
      { lpush: jest.fn().mockResolvedValue(1) } as never,
      handler,
    )
    const runnerId = randomUUID()
    const job = await staleService.createJob(null, JobType.START_BOX, runnerId, ResourceType.BOX, box.id)
    await dataSource.query(`UPDATE "${schemaName}"."job" SET "updatedAt" = NOW() - INTERVAL '1 hour' WHERE id = $1`, [
      job.id,
    ])

    let signalStaleRead!: () => void
    const staleRead = new Promise<void>((resolve) => {
      signalStaleRead = resolve
    })
    let resumeStaleScan!: () => void
    const staleScanMayResume = new Promise<void>((resolve) => {
      resumeStaleScan = resolve
    })
    const findJobs = staleRepository.find.bind(staleRepository)
    const findSpy = jest.spyOn(staleRepository, 'find').mockImplementation(async (options) => {
      const jobs = await findJobs(options)
      if (jobs.some((candidate) => candidate.id === job.id)) {
        signalStaleRead()
        await staleScanMayResume
      }
      return jobs
    })

    try {
      const staleRun = staleService.handleStaleJobs()
      await staleRead
      const claimed = await (claimingService as any).claimPendingJobs(runnerId, 1)
      expect(claimed).toHaveLength(1)
      resumeStaleScan()
      await staleRun
    } finally {
      resumeStaleScan()
      findSpy.mockRestore()
    }

    await expect(dataSource.getRepository(Job).findOneByOrFail({ id: job.id })).resolves.toMatchObject({
      status: JobStatus.IN_PROGRESS,
      completedAt: null,
    })
    await expect(dataSource.getRepository(Box).findOneByOrFail({ id: box.id })).resolves.toMatchObject({
      state: BoxState.STOPPED,
      desiredState: BoxDesiredState.STARTED,
      lifecycleJobId: job.id,
    })
    await expect(
      dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id, endAt: IsNull(), cpu: 0 }),
    ).resolves.toBe(1)
  })

  it('still fails a lifecycle Job that remains stale at the conditional update', async () => {
    const box = await seedBox(BoxState.STOPPED, BoxDesiredState.STOPPED, 'disk')
    await repository.updateWhere(box.id, {
      updateData: { desiredState: BoxDesiredState.STARTED, pending: true },
      whereCondition: { state: BoxState.STOPPED, desiredState: BoxDesiredState.STOPPED, pending: false },
    })

    const jobService = new JobService(
      dataSource.getRepository(Job),
      { lpush: jest.fn().mockResolvedValue(1) } as never,
      new JobStateHandlerService(repository),
    )
    const job = await jobService.createJob(null, JobType.START_BOX, randomUUID(), ResourceType.BOX, box.id)
    await dataSource.query(`UPDATE "${schemaName}"."job" SET "updatedAt" = NOW() - INTERVAL '1 hour' WHERE id = $1`, [
      job.id,
    ])

    await jobService.handleStaleJobs()

    await expect(dataSource.getRepository(Job).findOneByOrFail({ id: job.id })).resolves.toMatchObject({
      status: JobStatus.FAILED,
      completedAt: expect.any(Date),
    })
    await expect(dataSource.getRepository(Box).findOneByOrFail({ id: box.id })).resolves.toMatchObject({
      state: BoxState.ERROR,
      desiredState: BoxDesiredState.STARTED,
      lifecycleJobId: null,
      pending: false,
    })
    await expect(dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id, endAt: IsNull() })).resolves.toBe(0)
  })

  it('preserves lifecycle Job ownership when its action writes the transitional state', async () => {
    const box = await seedBox(BoxState.STOPPED, BoxDesiredState.STARTED, 'disk')
    const actionSnapshot = await dataSource.getRepository(Box).findOneByOrFail({ id: box.id })
    const jobStateHandler = new JobStateHandlerService(repository)
    const jobService = new JobService(
      dataSource.getRepository(Job),
      { lpush: jest.fn().mockResolvedValue(1) } as never,
      jobStateHandler,
    )

    const job = await jobService.createJob(null, JobType.START_BOX, randomUUID(), ResourceType.BOX, box.id)
    expect(actionSnapshot.lifecycleJobId).toBeNull()

    await repository.update(box.id, {
      entity: actionSnapshot,
      updateData: { state: BoxState.STARTING },
    })

    await expect(dataSource.getRepository(Box).findOneByOrFail({ id: box.id })).resolves.toMatchObject({
      state: BoxState.STARTING,
      lifecycleJobId: job.id,
    })
  })
})
