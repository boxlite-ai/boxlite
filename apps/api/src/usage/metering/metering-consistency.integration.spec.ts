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
import { BoxRuntimeCleanup } from '../../box/entities/box-runtime-cleanup.entity'
import { BoxRuntimeLease } from '../../box/entities/box-runtime-lease.entity'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BoxState } from '../../box/enums/box-state.enum'
import { BoxRepository } from '../../box/repositories/box.repository'
import { Job } from '../../box/entities/job.entity'
import { RunnerRuntimeEpoch } from '../../box/entities/runner-runtime-epoch.entity'
import { Runner } from '../../box/entities/runner.entity'
import { JobStatus } from '../../box/enums/job-status.enum'
import { JobType } from '../../box/enums/job-type.enum'
import { RunnerState } from '../../box/enums/runner-state.enum'
import { ResourceType } from '../../box/enums/resource-type.enum'
import { JobService } from '../../box/services/job.service'
import { JobStateHandlerService } from '../../box/services/job-state-handler.service'
import { RuntimeLeaseService, RuntimeStartFinalizationStatus } from '../../box/services/runtime-lease.service'
import { RuntimeOrphanCleanupService } from '../../box/services/runtime-orphan-cleanup.service'
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
      entities: [
        Region,
        Box,
        BoxLastActivity,
        BoxRuntimeLease,
        BoxRuntimeCleanup,
        RunnerRuntimeEpoch,
        Runner,
        BoxUsagePeriod,
        Job,
      ],
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
      `TRUNCATE TABLE "${schemaName}"."box_runtime_cleanup", "${schemaName}"."box_runtime_lease", "${schemaName}"."runner_runtime_epoch", "${schemaName}"."job", "${schemaName}"."box_usage_period", "${schemaName}"."box_last_activity", "${schemaName}"."box", "${schemaName}"."runner", "${schemaName}"."region" CASCADE`,
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
    const runnerEpoch = allocation === 'full' ? randomUUID() : null
    if (allocation === 'full') {
      const runner = await dataSource.getRepository(Runner).save(
        Object.assign(
          new Runner({
            region: box.region,
            name: `runner-${randomUUID().slice(0, 8)}`,
            apiKey: randomUUID(),
            apiVersion: '2',
          }),
          { state: RunnerState.READY },
        ),
      )
      box.runnerId = runner.id
      box.runtimeGeneration = 1
      box.runtimeAuthorized = true
    }
    await dataSource.getRepository(Box).save(box)

    if (allocation !== 'none') {
      const computeBillableUntil = allocation === 'full' ? new Date('2099-01-01T00:00:00.000Z') : null
      await dataSource.getRepository(BoxUsagePeriod).save(
        Object.assign(new BoxUsagePeriod(), {
          boxId: box.id,
          organizationId: box.organizationId,
          startAt: new Date('2026-07-21T00:00:00.000Z'),
          endAt: null,
          computeBillableUntil,
          runtimeGeneration: allocation === 'full' ? box.runtimeGeneration : null,
          runnerEpoch,
          cpu: allocation === 'full' ? box.cpu : 0,
          gpu: allocation === 'full' ? box.gpu : 0,
          mem: allocation === 'full' ? box.mem : 0,
          disk: box.disk,
          region: box.region,
          boxClass: box.class,
          regionType: RegionType.SHARED,
        }),
      )
      if (allocation === 'full') {
        await dataSource.getRepository(BoxRuntimeLease).save(
          Object.assign(new BoxRuntimeLease(), {
            boxId: box.id,
            runnerId: box.runnerId,
            runnerEpoch,
            runtimeGeneration: box.runtimeGeneration,
            sequence: 1,
            actualState: BoxState.STARTED,
            observedAt: box.createdAt,
            leaseExpiresAt: computeBillableUntil,
          }),
        )
      }
    }

    return box
  }

  function createRuntimeLeaseService(): RuntimeLeaseService {
    return new RuntimeLeaseService(
      dataSource,
      {
        getOrThrow: jest.fn((key: string) => {
          if (key === 'billing.runtimeLeaseSeconds') return 45
          return undefined
        }),
      } as never,
      new UsagePeriodWriter(new MeteringPolicy()),
      repository,
    )
  }

  async function attachCurrentRunner(box: Box): Promise<{ runnerId: string; runnerEpoch: string }> {
    const runnerEpoch = randomUUID()
    const runner = await dataSource.getRepository(Runner).save(
      Object.assign(
        new Runner({
          region: box.region,
          name: `runner-${randomUUID().slice(0, 8)}`,
          apiKey: randomUUID(),
          apiVersion: '2',
        }),
        {
          state: RunnerState.READY,
          runtimeEpoch: runnerEpoch,
          runtimeIncarnation: 1,
          runtimeSequence: 1,
        },
      ),
    )
    await dataSource.getRepository(RunnerRuntimeEpoch).save(
      Object.assign(new RunnerRuntimeEpoch(), {
        runnerId: runner.id,
        runnerEpoch,
        runnerIncarnation: 1,
        lastSequence: 1,
        activatedAt: new Date(),
        retiredAt: null,
      }),
    )
    await dataSource.getRepository(Box).update({ id: box.id }, { runnerId: runner.id })
    box.runnerId = runner.id
    return { runnerId: runner.id, runnerEpoch }
  }

  async function setCompletedRuntimeResult(job: Job, runnerEpoch: string, completedAtOffsetMs = 0): Promise<void> {
    const runtimeGeneration = job.getPayload<{ runtimeGeneration: number }>()?.runtimeGeneration
    job.resultMetadata = JSON.stringify({ runnerEpoch, runtimeGeneration })
    const [row] = await dataSource.query(`SELECT clock_timestamp() AS "now"`)
    job.completedAt = new Date(new Date(row.now).getTime() + completedAtOffsetMs)
  }

  async function seedObservedRunningBox(runtimeLeaseService: RuntimeLeaseService): Promise<{
    box: Box
    runnerId: string
    runnerEpoch: string
    runtimeGeneration: number
    expiredLease: BoxRuntimeLease
  }> {
    const box = await seedBox(BoxState.STARTED, BoxDesiredState.STARTED, 'full')
    const runnerId = box.runnerId!
    const runtimeGeneration = box.runtimeGeneration
    const openPeriod = await dataSource
      .getRepository(BoxUsagePeriod)
      .findOneByOrFail({ boxId: box.id, endAt: IsNull() })
    const runnerEpoch = openPeriod.runnerEpoch!

    await runtimeLeaseService.observeRunnerSnapshot({
      runnerId,
      runnerEpoch,
      runnerIncarnation: 1,
      sequence: 1,
      boxes: [{ boxId: box.id, actualState: BoxState.STARTED, runtimeGeneration }],
    })

    const leaseRepository = dataSource.getRepository(BoxRuntimeLease)
    const observedAt = new Date('2026-07-21T00:00:00.000Z')
    const leaseExpiresAt = new Date('2026-07-21T00:01:00.000Z')
    await leaseRepository.update({ boxId: box.id }, { observedAt, leaseExpiresAt })
    await dataSource
      .getRepository(BoxUsagePeriod)
      .update({ boxId: box.id, endAt: IsNull() }, { computeBillableUntil: leaseExpiresAt })

    return {
      box,
      runnerId,
      runnerEpoch,
      runtimeGeneration,
      expiredLease: await leaseRepository.findOneByOrFail({ boxId: box.id }),
    }
  }

  function findUsagePeriods(boxId: string): Promise<BoxUsagePeriod[]> {
    return dataSource.getRepository(BoxUsagePeriod).find({
      where: { boxId },
      order: { startAt: 'ASC', id: 'ASC' },
    })
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

    const runner = await dataSource.getRepository(Runner).save(
      Object.assign(
        new Runner({
          region: box.region,
          name: `runner-${randomUUID().slice(0, 8)}`,
          apiKey: randomUUID(),
          apiVersion: '2',
        }),
        { state: RunnerState.READY },
      ),
    )
    const runnerEpoch = randomUUID()
    await dataSource.getRepository(Box).update({ id: box.id }, { runnerId: runner.id, runtimeGeneration: 1 })
    await dataSource.getRepository(BoxRuntimeLease).save(
      Object.assign(new BoxRuntimeLease(), {
        boxId: box.id,
        runnerId: runner.id,
        runnerEpoch,
        runtimeGeneration: 1,
        sequence: 1,
        actualState: BoxState.STARTED,
        observedAt: new Date(),
        leaseExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      }),
    )
    await repository.updateWhere(box.id, {
      updateData: { state: BoxState.STARTED, errorReason: null, runtimeAuthorized: true },
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

    const { runnerId, runnerEpoch } = await attachCurrentRunner(box)
    const jobStateHandler = new JobStateHandlerService(repository, createRuntimeLeaseService())
    const jobService = new JobService(
      dataSource.getRepository(Job),
      { lpush: jest.fn().mockResolvedValue(1) } as never,
      jobStateHandler,
    )
    const job = await jobService.createJob(null, JobType.START_BOX, runnerId, ResourceType.BOX, box.id)

    job.status = JobStatus.COMPLETED
    await setCompletedRuntimeResult(job, runnerEpoch)
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

    const { runnerId, runnerEpoch } = await attachCurrentRunner(box)
    const runtimeLeaseService = createRuntimeLeaseService()
    const jobService = new JobService(
      dataSource.getRepository(Job),
      { lpush: jest.fn().mockResolvedValue(1) } as never,
      { handleJobCompletion: jest.fn().mockResolvedValue(undefined) } as never,
    )
    const job = await jobService.createJob(null, JobType.START_BOX, runnerId, ResourceType.BOX, box.id)
    job.status = JobStatus.COMPLETED
    await setCompletedRuntimeResult(job, runnerEpoch)

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
    const firstHandler = new JobStateHandlerService(wrapRepository() as never, runtimeLeaseService)
    const secondHandler = new JobStateHandlerService(wrapRepository() as never, runtimeLeaseService)

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

    const { runnerId, runnerEpoch } = await attachCurrentRunner(box)
    const jobService = new JobService(
      dataSource.getRepository(Job),
      { lpush: jest.fn().mockResolvedValue(1) } as never,
      new JobStateHandlerService(repository, createRuntimeLeaseService()),
    )
    const job = await jobService.createJob(null, JobType.START_BOX, runnerId, ResourceType.BOX, box.id)
    await jobService.updateJobStatus(job.id, JobStatus.IN_PROGRESS)
    const jobBeforeTerminal = await dataSource.getRepository(Job).findOneByOrFail({ id: job.id })

    const outcomes = await Promise.allSettled([
      jobService.updateJobStatus(
        job.id,
        JobStatus.COMPLETED,
        undefined,
        JSON.stringify({
          runnerEpoch,
          runtimeGeneration: job.getPayload<{ runtimeGeneration: number }>()?.runtimeGeneration,
        }),
      ),
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
    const { runnerId, runnerEpoch } = await attachCurrentRunner(box)
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
      (firstService as any).claimPendingJobs(runnerId, 1, runnerEpoch),
      (secondService as any).claimPendingJobs(runnerId, 1, runnerEpoch),
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

  it('prevents a retired runner epoch from claiming or completing jobs', async () => {
    const box = await seedBox(BoxState.STOPPED, BoxDesiredState.STOPPED, 'disk')
    const { runnerId, runnerEpoch } = await attachCurrentRunner(box)
    const retiredEpoch = randomUUID()
    const jobService = new JobService(
      dataSource.getRepository(Job),
      { lpush: jest.fn().mockResolvedValue(1) } as never,
      { handleJobCompletion: jest.fn().mockResolvedValue(undefined) } as never,
    )
    const job = await jobService.createJob(
      null,
      JobType.UPDATE_BOX_NETWORK_SETTINGS,
      runnerId,
      ResourceType.BOX,
      box.id,
    )

    await expect((jobService as any).claimPendingJobs(runnerId, 1)).rejects.toBeInstanceOf(ConflictException)
    await expect((jobService as any).claimPendingJobs(runnerId, 1, retiredEpoch)).rejects.toBeInstanceOf(
      ConflictException,
    )
    await expect(dataSource.getRepository(Job).findOneByOrFail({ id: job.id })).resolves.toMatchObject({
      status: JobStatus.PENDING,
      executionEpoch: null,
    })

    await expect((jobService as any).claimPendingJobs(runnerId, 1, runnerEpoch)).resolves.toHaveLength(1)
    await expect(
      jobService.updateJobStatus(job.id, JobStatus.COMPLETED, undefined, undefined, {
        runnerId,
        runnerEpoch: retiredEpoch,
      }),
    ).rejects.toBeInstanceOf(ConflictException)
    await expect(
      jobService.updateJobStatus(job.id, JobStatus.COMPLETED, undefined, undefined, {
        runnerId,
        runnerEpoch,
      }),
    ).resolves.toMatchObject({ status: JobStatus.COMPLETED, executionEpoch: runnerEpoch })
  })

  it('rejects a replay using the epoch high-water mark even if the Runner sequence was rolled back', async () => {
    const runtimeLeaseService = createRuntimeLeaseService()
    const box = await seedBox(BoxState.STOPPED, BoxDesiredState.STOPPED, 'disk')
    const { runnerId, runnerEpoch } = await attachCurrentRunner(box)
    await dataSource.getRepository(Runner).update({ id: runnerId }, { runtimeSequence: 0 })

    const replay = await runtimeLeaseService.observeRunnerSnapshot({
      runnerId,
      runnerEpoch,
      runnerIncarnation: 1,
      sequence: 1,
      boxes: [],
    })

    expect(replay).toEqual({ accepted: false, cleanupTargets: [] })
    await expect(
      dataSource.getRepository(RunnerRuntimeEpoch).findOneByOrFail({ runnerId, runnerEpoch }),
    ).resolves.toMatchObject({ lastSequence: 1 })
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
    const { runnerId, runnerEpoch } = await attachCurrentRunner(box)
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
      const claimed = await (claimingService as any).claimPendingJobs(runnerId, 1, runnerEpoch)
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
    const beforeJob = await dataSource.getRepository(Box).findOneByOrFail({ id: box.id })
    const jobStateHandler = new JobStateHandlerService(repository)
    const jobService = new JobService(
      dataSource.getRepository(Job),
      { lpush: jest.fn().mockResolvedValue(1) } as never,
      jobStateHandler,
    )

    const job = await jobService.createJob(null, JobType.START_BOX, randomUUID(), ResourceType.BOX, box.id)
    expect(beforeJob.lifecycleJobId).toBeNull()
    const actionSnapshot = await dataSource.getRepository(Box).findOneByOrFail({ id: box.id })

    await repository.update(box.id, {
      entity: actionSnapshot,
      updateData: { state: BoxState.STARTING },
    })

    await expect(dataSource.getRepository(Box).findOneByOrFail({ id: box.id })).resolves.toMatchObject({
      state: BoxState.STARTING,
      lifecycleJobId: job.id,
    })
  })

  it('ends FULL metering at the persisted lease expiry when a running Box stops reporting', async () => {
    const runtimeLeaseService = createRuntimeLeaseService()
    const { box, expiredLease } = await seedObservedRunningBox(runtimeLeaseService)

    await runtimeLeaseService.sweepExpiredLeases()

    await expect(dataSource.getRepository(Box).findOneByOrFail({ id: box.id })).resolves.toMatchObject({
      state: BoxState.ERROR,
      desiredState: BoxDesiredState.STARTED,
      recoverable: true,
      runtimeAuthorized: true,
    })
    const periods = await findUsagePeriods(box.id)
    expect(periods).toHaveLength(2)
    expect(periods[0]).toMatchObject({
      cpu: box.cpu,
      mem: box.mem,
      gpu: box.gpu,
      endAt: expiredLease.leaseExpiresAt,
    })
    expect(periods[1]).toMatchObject({
      cpu: 0,
      mem: 0,
      gpu: 0,
      disk: box.disk,
      startAt: expiredLease.leaseExpiresAt,
      endAt: null,
    })
    expect(periods[0].endAt).toEqual(periods[1].startAt)

    await runtimeLeaseService.sweepExpiredLeases()
    await expect(dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id })).resolves.toBe(2)
    await expect(dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id, endAt: IsNull() })).resolves.toBe(1)
  })

  it('shrinks the compute hard cap when the persisted runtime lease becomes shorter', async () => {
    const runtimeLeaseService = createRuntimeLeaseService()
    const box = await seedBox(BoxState.STARTED, BoxDesiredState.STARTED, 'full')
    const periodBeforeHeartbeat = await dataSource
      .getRepository(BoxUsagePeriod)
      .findOneByOrFail({ boxId: box.id, endAt: IsNull() })

    const observation = await runtimeLeaseService.observeRunnerSnapshot({
      runnerId: box.runnerId!,
      runnerEpoch: periodBeforeHeartbeat.runnerEpoch!,
      runnerIncarnation: 1,
      sequence: 1,
      boxes: [{ boxId: box.id, actualState: BoxState.STARTED, runtimeGeneration: box.runtimeGeneration }],
    })

    const lease = await dataSource.getRepository(BoxRuntimeLease).findOneByOrFail({ boxId: box.id })
    const periodAfterHeartbeat = await dataSource
      .getRepository(BoxUsagePeriod)
      .findOneByOrFail({ boxId: box.id, endAt: IsNull() })
    expect(observation.accepted).toBe(true)
    expect(lease.leaseExpiresAt.getTime()).toBeLessThan(periodBeforeHeartbeat.computeBillableUntil!.getTime())
    expect(periodAfterHeartbeat.computeBillableUntil).toEqual(lease.leaseExpiresAt)
  })

  it('reconciles an expired lease after rollover without moving usage time backwards', async () => {
    const runtimeLeaseService = createRuntimeLeaseService()
    const { box, expiredLease } = await seedObservedRunningBox(runtimeLeaseService)
    const rolloverAt = new Date(expiredLease.leaseExpiresAt.getTime() + 60_000)

    await dataSource.transaction(async (manager) => {
      const currentBox = await manager.findOneByOrFail(Box, { id: box.id })
      await new UsagePeriodWriter(new MeteringPolicy()).transition({
        manager,
        previousBox: currentBox,
        currentBox,
        transitionAt: rolloverAt,
        forceBoundary: true,
      })
    })

    const rolledPeriods = await findUsagePeriods(box.id)
    expect(rolledPeriods).toHaveLength(3)
    expect(rolledPeriods[0]).toMatchObject({
      cpu: box.cpu,
      endAt: expiredLease.leaseExpiresAt,
    })
    expect(rolledPeriods[1]).toMatchObject({
      cpu: 0,
      startAt: expiredLease.leaseExpiresAt,
      endAt: rolloverAt,
    })
    expect(rolledPeriods[2]).toMatchObject({
      cpu: 0,
      startAt: rolloverAt,
      endAt: null,
    })

    await expect(runtimeLeaseService.reconcileExpiredCandidate(expiredLease)).resolves.toBe(true)

    const reconciledBox = await dataSource.getRepository(Box).findOneByOrFail({ id: box.id })
    const lastActivity = await dataSource.getRepository(BoxLastActivity).findOneByOrFail({ boxId: box.id })
    await expect(dataSource.getRepository(BoxRuntimeLease).findOneByOrFail({ boxId: box.id })).resolves.toMatchObject({
      actualState: BoxState.ERROR,
    })
    expect(reconciledBox).toMatchObject({
      state: BoxState.ERROR,
      recoverable: true,
      runtimeUnavailable: true,
    })
    expect(reconciledBox.updatedAt.getTime()).toBeGreaterThan(rolloverAt.getTime())
    expect(lastActivity.lastActivityAt.getTime()).toBeGreaterThan(rolloverAt.getTime())

    const reconciledPeriods = await findUsagePeriods(box.id)
    expect(reconciledPeriods).toHaveLength(3)
    expect(reconciledPeriods[0].endAt).toEqual(expiredLease.leaseExpiresAt)
    expect(reconciledPeriods[1]).toMatchObject({ cpu: 0, mem: 0, gpu: 0, endAt: rolloverAt })
    expect(reconciledPeriods[2]).toMatchObject({ cpu: 0, mem: 0, gpu: 0, startAt: rolloverAt, endAt: null })
    await expect(runtimeLeaseService.reconcileExpiredCandidate(expiredLease)).resolves.toBe(false)
    await expect(dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id })).resolves.toBe(3)
    await expect(dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id, endAt: IsNull() })).resolves.toBe(1)
  })

  it('ignores a stale expiry candidate after a heartbeat reconciles the expired gap', async () => {
    const runtimeLeaseService = createRuntimeLeaseService()
    const { box, runnerId, runnerEpoch, runtimeGeneration, expiredLease } =
      await seedObservedRunningBox(runtimeLeaseService)

    const cleanupTargets = await runtimeLeaseService.observeRunnerSnapshot({
      runnerId,
      runnerEpoch,
      runnerIncarnation: 1,
      sequence: 2,
      boxes: [{ boxId: box.id, actualState: BoxState.STARTED, runtimeGeneration }],
    })
    const renewedLease = await dataSource.getRepository(BoxRuntimeLease).findOneByOrFail({ boxId: box.id })

    await runtimeLeaseService.reconcileExpiredCandidate(expiredLease)

    expect(cleanupTargets.cleanupTargets).toHaveLength(0)
    expect(renewedLease.observedAt.getTime()).toBeGreaterThan(expiredLease.leaseExpiresAt.getTime())
    expect(renewedLease.leaseExpiresAt.getTime()).toBeGreaterThan(renewedLease.observedAt.getTime())
    await expect(dataSource.getRepository(Box).findOneByOrFail({ id: box.id })).resolves.toMatchObject({
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STARTED,
      runtimeAuthorized: true,
    })

    const periods = await findUsagePeriods(box.id)
    expect(periods).toHaveLength(3)
    expect(periods[0]).toMatchObject({ cpu: box.cpu, endAt: expiredLease.leaseExpiresAt })
    expect(periods[1]).toMatchObject({
      cpu: 0,
      mem: 0,
      gpu: 0,
      startAt: expiredLease.leaseExpiresAt,
      endAt: renewedLease.observedAt,
    })
    expect(periods[2]).toMatchObject({
      cpu: box.cpu,
      mem: box.mem,
      gpu: box.gpu,
      startAt: renewedLease.observedAt,
      endAt: null,
    })
    expect(periods[0].endAt).toEqual(periods[1].startAt)
    expect(periods[1].endAt).toEqual(periods[2].startAt)
    await expect(dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id, endAt: IsNull() })).resolves.toBe(1)
  })

  it('reopens FULL metering only from the observation after an expired lease was swept', async () => {
    const runtimeLeaseService = createRuntimeLeaseService()
    const { box, runnerId, runnerEpoch, runtimeGeneration, expiredLease } =
      await seedObservedRunningBox(runtimeLeaseService)

    await runtimeLeaseService.sweepExpiredLeases()
    const cleanupTargets = await runtimeLeaseService.observeRunnerSnapshot({
      runnerId,
      runnerEpoch,
      runnerIncarnation: 1,
      sequence: 2,
      boxes: [{ boxId: box.id, actualState: BoxState.STARTED, runtimeGeneration }],
    })
    const renewedLease = await dataSource.getRepository(BoxRuntimeLease).findOneByOrFail({ boxId: box.id })

    expect(cleanupTargets.cleanupTargets).toHaveLength(0)
    expect(renewedLease.observedAt.getTime()).toBeGreaterThan(expiredLease.leaseExpiresAt.getTime())
    await expect(dataSource.getRepository(Box).findOneByOrFail({ id: box.id })).resolves.toMatchObject({
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STARTED,
      recoverable: false,
      runtimeAuthorized: true,
    })

    const periods = await findUsagePeriods(box.id)
    expect(periods).toHaveLength(3)
    expect(periods[0]).toMatchObject({ cpu: box.cpu, endAt: expiredLease.leaseExpiresAt })
    expect(periods[1]).toMatchObject({
      cpu: 0,
      mem: 0,
      gpu: 0,
      startAt: expiredLease.leaseExpiresAt,
      endAt: renewedLease.observedAt,
    })
    expect(periods[2]).toMatchObject({
      cpu: box.cpu,
      mem: box.mem,
      gpu: box.gpu,
      startAt: renewedLease.observedAt,
      endAt: null,
    })
    expect(periods[0].endAt).toEqual(periods[1].startAt)
    expect(periods[1].endAt).toEqual(periods[2].startAt)
  })

  it('ends compute immediately when a complete runner inventory omits an authorized runtime', async () => {
    const box = await seedBox(BoxState.STARTED, BoxDesiredState.STARTED, 'full')
    const runtimeLeaseService = createRuntimeLeaseService()
    const initialLease = await dataSource.getRepository(BoxRuntimeLease).findOneByOrFail({ boxId: box.id })

    await runtimeLeaseService.observeRunnerSnapshot({
      runnerId: box.runnerId!,
      runnerEpoch: initialLease.runnerEpoch,
      runnerIncarnation: 1,
      sequence: 1,
      boxes: [{ boxId: box.id, actualState: BoxState.STARTED, runtimeGeneration: box.runtimeGeneration }],
    })
    await runtimeLeaseService.observeRunnerSnapshot({
      runnerId: box.runnerId!,
      runnerEpoch: initialLease.runnerEpoch,
      runnerIncarnation: 1,
      sequence: 2,
      boxes: [],
    })

    const missingLease = await dataSource.getRepository(BoxRuntimeLease).findOneByOrFail({ boxId: box.id })
    expect(missingLease).toMatchObject({ actualState: BoxState.STOPPED, sequence: 2 })
    await expect(dataSource.getRepository(Box).findOneByOrFail({ id: box.id })).resolves.toMatchObject({
      state: BoxState.ERROR,
      runtimeUnavailable: true,
      runtimeAuthorized: true,
    })
    const periods = await findUsagePeriods(box.id)
    expect(periods).toHaveLength(2)
    expect(periods[0]).toMatchObject({ cpu: box.cpu, endAt: missingLease.observedAt })
    expect(periods[1]).toMatchObject({ cpu: 0, mem: 0, gpu: 0, startAt: missingLease.observedAt, endAt: null })
  })

  it('invalidates the expected lease when a complete inventory reports the same Box with a wrong generation', async () => {
    const box = await seedBox(BoxState.STARTED, BoxDesiredState.STARTED, 'full')
    const runtimeLeaseService = createRuntimeLeaseService()
    const initialLease = await dataSource.getRepository(BoxRuntimeLease).findOneByOrFail({ boxId: box.id })

    await runtimeLeaseService.observeRunnerSnapshot({
      runnerId: box.runnerId!,
      runnerEpoch: initialLease.runnerEpoch,
      runnerIncarnation: 1,
      sequence: 1,
      boxes: [{ boxId: box.id, actualState: BoxState.STARTED, runtimeGeneration: box.runtimeGeneration }],
    })
    const result = await runtimeLeaseService.observeRunnerSnapshot({
      runnerId: box.runnerId!,
      runnerEpoch: initialLease.runnerEpoch,
      runnerIncarnation: 1,
      sequence: 2,
      boxes: [{ boxId: box.id, actualState: BoxState.STARTED, runtimeGeneration: box.runtimeGeneration + 1 }],
    })

    expect(result.cleanupTargets).toEqual([
      {
        boxId: box.id,
        runnerId: box.runnerId,
        runnerEpoch: initialLease.runnerEpoch,
        runtimeGeneration: box.runtimeGeneration + 1,
      },
    ])
    await expect(dataSource.getRepository(Box).findOneByOrFail({ id: box.id })).resolves.toMatchObject({
      state: BoxState.ERROR,
      runtimeUnavailable: true,
    })
    const periods = await findUsagePeriods(box.id)
    expect(periods.at(-1)).toMatchObject({ cpu: 0, mem: 0, gpu: 0, endAt: null })
  })

  it('renews an authorized lease while the Box is resizing without scheduling orphan cleanup', async () => {
    const box = await seedBox(BoxState.STARTED, BoxDesiredState.STARTED, 'full')
    const runtimeLeaseService = createRuntimeLeaseService()
    const initialLease = await dataSource.getRepository(BoxRuntimeLease).findOneByOrFail({ boxId: box.id })
    await runtimeLeaseService.observeRunnerSnapshot({
      runnerId: box.runnerId!,
      runnerEpoch: initialLease.runnerEpoch,
      runnerIncarnation: 1,
      sequence: 1,
      boxes: [{ boxId: box.id, actualState: BoxState.STARTED, runtimeGeneration: box.runtimeGeneration }],
    })
    await dataSource.getRepository(Box).update({ id: box.id }, { state: BoxState.RESIZING })

    const result = await runtimeLeaseService.observeRunnerSnapshot({
      runnerId: box.runnerId!,
      runnerEpoch: initialLease.runnerEpoch,
      runnerIncarnation: 1,
      sequence: 2,
      boxes: [{ boxId: box.id, actualState: BoxState.STARTED, runtimeGeneration: box.runtimeGeneration }],
    })

    expect(result.cleanupTargets).toHaveLength(0)
    await expect(dataSource.getRepository(BoxRuntimeLease).findOneByOrFail({ boxId: box.id })).resolves.toMatchObject({
      actualState: BoxState.STARTED,
      sequence: 2,
    })
    await expect(dataSource.getRepository(Box).findOneByOrFail({ id: box.id })).resolves.toMatchObject({
      state: BoxState.RESIZING,
      runtimeAuthorized: true,
    })
  })

  it('rejects a delayed snapshot from an older runner incarnation even when its epoch was never seen', async () => {
    const box = await seedBox(BoxState.STOPPED, BoxDesiredState.STOPPED, 'disk')
    const { runnerId } = await attachCurrentRunner(box)
    const runtimeLeaseService = createRuntimeLeaseService()
    const currentEpoch = randomUUID()

    await expect(
      runtimeLeaseService.observeRunnerSnapshot({
        runnerId,
        runnerEpoch: currentEpoch,
        runnerIncarnation: 2,
        sequence: 1,
      }),
    ).resolves.toMatchObject({ accepted: true })

    const delayedEpoch = randomUUID()
    await expect(
      runtimeLeaseService.observeRunnerSnapshot({
        runnerId,
        runnerEpoch: delayedEpoch,
        runnerIncarnation: 1,
        sequence: 99,
      }),
    ).resolves.toMatchObject({ accepted: false })

    await expect(dataSource.getRepository(Runner).findOneByOrFail({ id: runnerId })).resolves.toMatchObject({
      runtimeEpoch: currentEpoch,
      runtimeIncarnation: 2,
      runtimeSequence: 1,
    })
    await expect(
      dataSource.getRepository(RunnerRuntimeEpoch).countBy({ runnerId, runnerEpoch: delayedEpoch }),
    ).resolves.toBe(0)
    await expect(
      runtimeLeaseService.observeRunnerSnapshot({
        runnerId,
        runnerEpoch: currentEpoch,
        runnerIncarnation: 2,
        sequence: 2,
      }),
    ).resolves.toMatchObject({ accepted: true })
  })

  it('does not extend a completed Job proof on replay and accepts a later current-epoch heartbeat', async () => {
    const box = await seedBox(BoxState.STOPPED, BoxDesiredState.STOPPED, 'disk')
    await repository.updateWhere(box.id, {
      updateData: { desiredState: BoxDesiredState.STARTED, pending: true },
      whereCondition: { state: BoxState.STOPPED, desiredState: BoxDesiredState.STOPPED, pending: false },
    })
    const { runnerId, runnerEpoch } = await attachCurrentRunner(box)
    const jobService = new JobService(
      dataSource.getRepository(Job),
      { lpush: jest.fn().mockResolvedValue(1) } as never,
      {} as never,
    )
    const job = await jobService.createJob(null, JobType.START_BOX, runnerId, ResourceType.BOX, box.id)
    job.status = JobStatus.COMPLETED
    await setCompletedRuntimeResult(job, runnerEpoch)
    await dataSource.getRepository(Job).save(job)
    const runtimeLeaseService = createRuntimeLeaseService()

    await expect(runtimeLeaseService.finalizeStartedJob(job)).resolves.toBe(RuntimeStartFinalizationStatus.CONFIRMED)
    const firstLease = await dataSource.getRepository(BoxRuntimeLease).findOneByOrFail({ boxId: box.id })
    await expect(dataSource.getRepository(Box).findOneByOrFail({ id: box.id })).resolves.toMatchObject({
      state: BoxState.STARTED,
      pending: false,
      runtimeAuthorized: true,
      runtimeUnavailable: false,
      lifecycleJobId: null,
    })
    const finalizedPeriods = await findUsagePeriods(box.id)
    expect(finalizedPeriods).toHaveLength(2)
    expect(finalizedPeriods[0]).toMatchObject({
      cpu: 0,
      mem: 0,
      gpu: 0,
      endAt: finalizedPeriods[1].startAt,
    })
    expect(finalizedPeriods[1]).toMatchObject({
      cpu: box.cpu,
      mem: box.mem,
      gpu: box.gpu,
      endAt: null,
      computeBillableUntil: firstLease.leaseExpiresAt,
      runnerEpoch,
      runtimeGeneration: job.getPayload<{ runtimeGeneration: number }>()!.runtimeGeneration,
    })

    await expect(runtimeLeaseService.finalizeStartedJob(job)).resolves.toBe(RuntimeStartFinalizationStatus.STALE)
    const replayedLease = await dataSource.getRepository(BoxRuntimeLease).findOneByOrFail({ boxId: box.id })
    expect(replayedLease.observedAt).toEqual(firstLease.observedAt)
    expect(replayedLease.leaseExpiresAt).toEqual(firstLease.leaseExpiresAt)

    await expect(
      runtimeLeaseService.observeRunnerSnapshot({
        runnerId,
        runnerEpoch,
        runnerIncarnation: 1,
        sequence: 2,
        boxes: [
          {
            boxId: box.id,
            actualState: BoxState.STARTED,
            runtimeGeneration: job.getPayload<{ runtimeGeneration: number }>()!.runtimeGeneration,
          },
        ],
      }),
    ).resolves.toMatchObject({ accepted: true, cleanupTargets: [] })
    const heartbeatLease = await dataSource.getRepository(BoxRuntimeLease).findOneByOrFail({ boxId: box.id })
    expect(heartbeatLease).toMatchObject({
      runnerId,
      runnerEpoch,
      sequence: 2,
      actualState: BoxState.STARTED,
    })
    expect(heartbeatLease.observedAt.getTime()).toBeGreaterThanOrEqual(replayedLease.observedAt.getTime())
    expect(heartbeatLease.leaseExpiresAt.getTime() - heartbeatLease.observedAt.getTime()).toBe(45_000)
    await expect(
      dataSource.getRepository(BoxUsagePeriod).findOneByOrFail({ boxId: box.id, endAt: IsNull() }),
    ).resolves.toMatchObject({
      computeBillableUntil: heartbeatLease.leaseExpiresAt,
      runnerEpoch,
      runtimeGeneration: job.getPayload<{ runtimeGeneration: number }>()!.runtimeGeneration,
    })
  })

  it('rejects an older completion proof after a newer non-running observation and fences a later orphan', async () => {
    const box = await seedBox(BoxState.STOPPED, BoxDesiredState.STOPPED, 'disk')
    await repository.updateWhere(box.id, {
      updateData: { desiredState: BoxDesiredState.STARTED, pending: true },
      whereCondition: { state: BoxState.STOPPED, desiredState: BoxDesiredState.STOPPED, pending: false },
    })
    const { runnerId, runnerEpoch } = await attachCurrentRunner(box)
    const jobService = new JobService(
      dataSource.getRepository(Job),
      { lpush: jest.fn().mockResolvedValue(1) } as never,
      {} as never,
    )
    const job = await jobService.createJob(null, JobType.START_BOX, runnerId, ResourceType.BOX, box.id)
    job.status = JobStatus.COMPLETED
    await setCompletedRuntimeResult(job, runnerEpoch, -2_000)
    await dataSource.getRepository(Job).save(job)
    const runtimeGeneration = job.getPayload<{ runtimeGeneration: number }>()!.runtimeGeneration
    const runtimeLeaseService = createRuntimeLeaseService()

    await runtimeLeaseService.observeRunnerSnapshot({
      runnerId,
      runnerEpoch,
      runnerIncarnation: 1,
      sequence: 2,
      boxes: [{ boxId: box.id, actualState: BoxState.STOPPED, runtimeGeneration }],
    })
    await expect(runtimeLeaseService.finalizeStartedJob(job)).resolves.toBe(RuntimeStartFinalizationStatus.REJECTED)
    await expect(dataSource.getRepository(BoxRuntimeLease).findOneByOrFail({ boxId: box.id })).resolves.toMatchObject({
      actualState: BoxState.STOPPED,
      sequence: 2,
    })
    await expect(dataSource.getRepository(Box).findOneByOrFail({ id: box.id })).resolves.toMatchObject({
      state: BoxState.ERROR,
      runtimeAuthorized: false,
      runtimeUnavailable: true,
      lifecycleJobId: null,
    })
    await expect(dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id, cpu: Not(0) })).resolves.toBe(0)

    await expect(
      runtimeLeaseService.observeRunnerSnapshot({
        runnerId,
        runnerEpoch,
        runnerIncarnation: 1,
        sequence: 3,
        boxes: [{ boxId: box.id, actualState: BoxState.STARTED, runtimeGeneration }],
      }),
    ).resolves.toEqual({
      accepted: true,
      cleanupTargets: [{ boxId: box.id, runnerId, runnerEpoch, runtimeGeneration }],
    })
    await expect(dataSource.getRepository(BoxRuntimeLease).findOneByOrFail({ boxId: box.id })).resolves.toMatchObject({
      actualState: BoxState.STOPPED,
      sequence: 2,
    })
    await expect(dataSource.getRepository(Box).findOneByOrFail({ id: box.id })).resolves.toMatchObject({
      state: BoxState.ERROR,
      runtimeAuthorized: false,
      runtimeUnavailable: true,
      lifecycleJobId: null,
    })
    await expect(dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id, cpu: Not(0) })).resolves.toBe(0)
  })

  it('does not let a completed start result override a newer complete empty inventory', async () => {
    const box = await seedBox(BoxState.STOPPED, BoxDesiredState.STOPPED, 'disk')
    await repository.updateWhere(box.id, {
      updateData: { desiredState: BoxDesiredState.STARTED, pending: true },
      whereCondition: { state: BoxState.STOPPED, desiredState: BoxDesiredState.STOPPED, pending: false },
    })
    const { runnerId, runnerEpoch } = await attachCurrentRunner(box)
    const jobService = new JobService(
      dataSource.getRepository(Job),
      { lpush: jest.fn().mockResolvedValue(1) } as never,
      {} as never,
    )
    const job = await jobService.createJob(null, JobType.START_BOX, runnerId, ResourceType.BOX, box.id)
    job.status = JobStatus.COMPLETED
    await setCompletedRuntimeResult(job, runnerEpoch, -1_000)
    await dataSource.getRepository(Job).save(job)
    const runtimeLeaseService = createRuntimeLeaseService()

    await runtimeLeaseService.observeRunnerSnapshot({
      runnerId,
      runnerEpoch,
      runnerIncarnation: 1,
      sequence: 2,
      boxes: [],
    })
    await expect(dataSource.getRepository(BoxRuntimeLease).findOneByOrFail({ boxId: box.id })).resolves.toMatchObject({
      actualState: BoxState.STOPPED,
      sequence: 2,
    })

    await new JobStateHandlerService(repository, runtimeLeaseService).handleJobCompletion(job)

    await expect(dataSource.getRepository(Box).findOneByOrFail({ id: box.id })).resolves.toMatchObject({
      state: BoxState.ERROR,
      runtimeAuthorized: false,
      runtimeUnavailable: true,
      lifecycleJobId: null,
    })
    await expect(dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id, cpu: Not(0) })).resolves.toBe(0)
  })

  it('rejects a future-dated start proof without opening compute metering', async () => {
    const box = await seedBox(BoxState.STOPPED, BoxDesiredState.STOPPED, 'disk')
    await repository.updateWhere(box.id, {
      updateData: { desiredState: BoxDesiredState.STARTED, pending: true },
      whereCondition: { state: BoxState.STOPPED, desiredState: BoxDesiredState.STOPPED, pending: false },
    })
    const { runnerId, runnerEpoch } = await attachCurrentRunner(box)
    const jobService = new JobService(
      dataSource.getRepository(Job),
      { lpush: jest.fn().mockResolvedValue(1) } as never,
      {} as never,
    )
    const job = await jobService.createJob(null, JobType.START_BOX, runnerId, ResourceType.BOX, box.id)
    job.status = JobStatus.COMPLETED
    await setCompletedRuntimeResult(job, runnerEpoch, 5 * 60_000)
    await dataSource.getRepository(Job).save(job)
    const runtimeLeaseService = createRuntimeLeaseService()

    await new JobStateHandlerService(repository, runtimeLeaseService).handleJobCompletion(job)

    await expect(dataSource.getRepository(Box).findOneByOrFail({ id: box.id })).resolves.toMatchObject({
      state: BoxState.ERROR,
      runtimeAuthorized: false,
      runtimeUnavailable: true,
      lifecycleJobId: null,
    })
    await expect(dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id, cpu: Not(0) })).resolves.toBe(0)
  })

  it('converges an expired completed start proof instead of retaining it in the retry queue', async () => {
    const box = await seedBox(BoxState.STOPPED, BoxDesiredState.STOPPED, 'disk')
    await repository.updateWhere(box.id, {
      updateData: { desiredState: BoxDesiredState.STARTED, pending: true },
      whereCondition: { state: BoxState.STOPPED, desiredState: BoxDesiredState.STOPPED, pending: false },
    })
    const { runnerId, runnerEpoch } = await attachCurrentRunner(box)
    const runtimeLeaseService = createRuntimeLeaseService()
    const handler = new JobStateHandlerService(repository, runtimeLeaseService)
    const jobService = new JobService(
      dataSource.getRepository(Job),
      { lpush: jest.fn().mockResolvedValue(1) } as never,
      handler,
    )
    const job = await jobService.createJob(null, JobType.START_BOX, runnerId, ResourceType.BOX, box.id)
    job.status = JobStatus.COMPLETED
    await setCompletedRuntimeResult(job, runnerEpoch, -60_000)
    await dataSource.getRepository(Job).save(job)

    await jobService.reconcileTerminalBoxJobs()
    await expect(dataSource.getRepository(Box).findOneByOrFail({ id: box.id })).resolves.toMatchObject({
      state: BoxState.ERROR,
      runtimeAuthorized: false,
      runtimeUnavailable: true,
      lifecycleJobId: null,
    })
    await expect(dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id, cpu: Not(0) })).resolves.toBe(0)

    await expect(jobService.reconcileTerminalBoxJobs()).resolves.toBeUndefined()
  })

  it('lets a current epoch heartbeat supersede an older completion epoch without backfilling', async () => {
    const box = await seedBox(BoxState.STOPPED, BoxDesiredState.STOPPED, 'disk')
    await repository.updateWhere(box.id, {
      updateData: { desiredState: BoxDesiredState.STARTED, pending: true },
      whereCondition: { state: BoxState.STOPPED, desiredState: BoxDesiredState.STOPPED, pending: false },
    })
    const { runnerId, runnerEpoch: resultEpoch } = await attachCurrentRunner(box)
    const jobService = new JobService(
      dataSource.getRepository(Job),
      { lpush: jest.fn().mockResolvedValue(1) } as never,
      {} as never,
    )
    const job = await jobService.createJob(null, JobType.START_BOX, runnerId, ResourceType.BOX, box.id)
    job.status = JobStatus.COMPLETED
    await setCompletedRuntimeResult(job, resultEpoch)
    await dataSource.getRepository(Job).save(job)

    const currentEpoch = randomUUID()
    const runtimeGeneration = job.getPayload<{ runtimeGeneration: number }>()!.runtimeGeneration
    const runtimeLeaseService = createRuntimeLeaseService()
    await runtimeLeaseService.observeRunnerSnapshot({
      runnerId,
      runnerEpoch: currentEpoch,
      runnerIncarnation: 2,
      sequence: 1,
      boxes: [{ boxId: box.id, actualState: BoxState.STARTED, runtimeGeneration }],
    })
    const currentProof = await dataSource.getRepository(BoxRuntimeLease).findOneByOrFail({ boxId: box.id })
    expect(currentProof.runnerEpoch).toBe(currentEpoch)

    const handler = new JobStateHandlerService(repository, runtimeLeaseService)
    await handler.handleJobCompletion(job)

    const periods = await findUsagePeriods(box.id)
    expect(periods).toHaveLength(2)
    expect(periods[1]).toMatchObject({
      cpu: box.cpu,
      mem: box.mem,
      runnerEpoch: currentEpoch,
      runtimeGeneration,
      endAt: null,
    })
    expect(periods[1].startAt.getTime()).toBeGreaterThanOrEqual(currentProof.observedAt.getTime())
  })

  it('never resumes compute billing after a failed stop and fences the still-running runtime for cleanup', async () => {
    const box = await seedBox(BoxState.STARTED, BoxDesiredState.STARTED, 'full')
    const runtimeLeaseService = createRuntimeLeaseService()
    const initialLease = await dataSource.getRepository(BoxRuntimeLease).findOneByOrFail({ boxId: box.id })
    await runtimeLeaseService.observeRunnerSnapshot({
      runnerId: box.runnerId!,
      runnerEpoch: initialLease.runnerEpoch,
      runnerIncarnation: 1,
      sequence: 1,
      boxes: [{ boxId: box.id, actualState: BoxState.STARTED, runtimeGeneration: box.runtimeGeneration }],
    })
    await repository.updateWhere(box.id, {
      updateData: { desiredState: BoxDesiredState.STOPPED, pending: true },
      whereCondition: {
        state: BoxState.STARTED,
        desiredState: BoxDesiredState.STARTED,
        pending: false,
      },
    })

    const jobService = new JobService(
      dataSource.getRepository(Job),
      { lpush: jest.fn().mockResolvedValue(1) } as never,
      new JobStateHandlerService(repository),
    )
    const stopJob = await jobService.createJob(null, JobType.STOP_BOX, box.runnerId!, ResourceType.BOX, box.id, {
      force: true,
    })
    expect(stopJob.getPayload()).toMatchObject({
      previousRuntimeGeneration: box.runtimeGeneration,
      runtimeGeneration: box.runtimeGeneration + 1,
    })
    await repository.updateWhere(box.id, {
      updateData: { state: BoxState.STOPPING },
      whereCondition: {
        state: BoxState.STARTED,
        desiredState: BoxDesiredState.STOPPED,
        pending: true,
        lifecycleJobId: stopJob.id,
      },
    })
    await jobService.updateJobStatus(stopJob.id, JobStatus.IN_PROGRESS)
    await jobService.updateJobStatus(stopJob.id, JobStatus.FAILED, 'runner stop failed')

    const failedGeneration = stopJob.getPayload<{ runtimeGeneration: number }>()!.runtimeGeneration
    const observation = await runtimeLeaseService.observeRunnerSnapshot({
      runnerId: box.runnerId!,
      runnerEpoch: initialLease.runnerEpoch,
      runnerIncarnation: 1,
      sequence: 2,
      boxes: [{ boxId: box.id, actualState: BoxState.STARTED, runtimeGeneration: failedGeneration }],
    })
    expect(observation.cleanupTargets).toEqual([
      {
        boxId: box.id,
        runnerId: box.runnerId,
        runnerEpoch: initialLease.runnerEpoch,
        runtimeGeneration: failedGeneration,
      },
    ])
    await expect(dataSource.getRepository(Box).findOneByOrFail({ id: box.id })).resolves.toMatchObject({
      state: BoxState.ERROR,
      desiredState: BoxDesiredState.STOPPED,
      runtimeAuthorized: false,
    })
    const periods = await findUsagePeriods(box.id)
    const computePeriods = periods.filter((period) => period.cpu > 0)
    const diskPeriods = periods.filter((period) => period.cpu === 0)
    expect(computePeriods).toHaveLength(1)
    expect(diskPeriods).toHaveLength(1)
    expect(computePeriods[0].endAt).toEqual(diskPeriods[0].startAt)
    expect(diskPeriods[0]).toMatchObject({
      endAt: null,
      cpu: 0,
      mem: 0,
      gpu: 0,
      disk: box.disk,
    })
    await expect(dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id, endAt: IsNull() })).resolves.toBe(1)
  })

  it('keeps all metering closed after a failed destroy even when the runtime is still visible', async () => {
    const box = await seedBox(BoxState.STARTED, BoxDesiredState.STARTED, 'full')
    const runtimeLeaseService = createRuntimeLeaseService()
    const initialLease = await dataSource.getRepository(BoxRuntimeLease).findOneByOrFail({ boxId: box.id })
    await runtimeLeaseService.observeRunnerSnapshot({
      runnerId: box.runnerId!,
      runnerEpoch: initialLease.runnerEpoch,
      runnerIncarnation: 1,
      sequence: 1,
      boxes: [{ boxId: box.id, actualState: BoxState.STARTED, runtimeGeneration: box.runtimeGeneration }],
    })
    await repository.updateWhere(box.id, {
      updateData: { desiredState: BoxDesiredState.DESTROYED, pending: true },
      whereCondition: {
        state: BoxState.STARTED,
        desiredState: BoxDesiredState.STARTED,
        pending: false,
      },
    })

    const jobService = new JobService(
      dataSource.getRepository(Job),
      { lpush: jest.fn().mockResolvedValue(1) } as never,
      new JobStateHandlerService(repository),
    )
    const destroyJob = await jobService.createJob(null, JobType.DESTROY_BOX, box.runnerId!, ResourceType.BOX, box.id, {
      force: true,
    })
    await repository.updateWhere(box.id, {
      updateData: { state: BoxState.DESTROYING },
      whereCondition: {
        state: BoxState.STARTED,
        desiredState: BoxDesiredState.DESTROYED,
        pending: true,
        lifecycleJobId: destroyJob.id,
      },
    })
    await jobService.updateJobStatus(destroyJob.id, JobStatus.IN_PROGRESS)
    await jobService.updateJobStatus(destroyJob.id, JobStatus.FAILED, 'runner destroy failed')

    const failedGeneration = destroyJob.getPayload<{ runtimeGeneration: number }>()!.runtimeGeneration
    const observation = await runtimeLeaseService.observeRunnerSnapshot({
      runnerId: box.runnerId!,
      runnerEpoch: initialLease.runnerEpoch,
      runnerIncarnation: 1,
      sequence: 2,
      boxes: [{ boxId: box.id, actualState: BoxState.STARTED, runtimeGeneration: failedGeneration }],
    })

    expect(observation.cleanupTargets).toEqual([
      {
        boxId: box.id,
        runnerId: box.runnerId,
        runnerEpoch: initialLease.runnerEpoch,
        runtimeGeneration: failedGeneration,
      },
    ])
    await expect(dataSource.getRepository(Box).findOneByOrFail({ id: box.id })).resolves.toMatchObject({
      state: BoxState.ERROR,
      desiredState: BoxDesiredState.DESTROYED,
      runtimeAuthorized: false,
    })
    const periods = await findUsagePeriods(box.id)
    expect(periods).toHaveLength(1)
    expect(periods[0]).toMatchObject({
      cpu: box.cpu,
      mem: box.mem,
      gpu: box.gpu,
      disk: box.disk,
      endAt: expect.any(Date),
    })
    await expect(dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id, endAt: IsNull() })).resolves.toBe(0)
  })

  it('keeps a failed start unbilled and rearms cleanup when the same runtime appears again', async () => {
    const box = await seedBox(BoxState.STOPPED, BoxDesiredState.STOPPED, 'disk')
    const runnerId = randomUUID()
    const runnerEpoch = randomUUID()
    await dataSource.getRepository(Runner).save(
      Object.assign(
        new Runner({
          region: box.region,
          name: `runner-${randomUUID().slice(0, 8)}`,
          apiKey: randomUUID(),
          apiVersion: '2',
        }),
        { id: runnerId, state: RunnerState.READY },
      ),
    )
    await dataSource.getRepository(Box).update({ id: box.id }, {
      runnerId,
      runtimeGeneration: 0,
      runtimeAuthorized: false,
    } as never)
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
    const startJob = await jobService.createJob(null, JobType.START_BOX, runnerId, ResourceType.BOX, box.id)
    const runtimeGeneration = startJob.getPayload<{ runtimeGeneration: number }>()?.runtimeGeneration
    expect(runtimeGeneration).toBe(1)
    await repository.updateWhere(box.id, {
      updateData: { state: BoxState.STARTING },
      whereCondition: {
        state: BoxState.STOPPED,
        desiredState: BoxDesiredState.STARTED,
        pending: true,
        lifecycleJobId: startJob.id,
      },
    })
    await jobService.updateJobStatus(startJob.id, JobStatus.IN_PROGRESS)
    await jobService.updateJobStatus(startJob.id, JobStatus.FAILED, 'runner start timed out')

    await expect(dataSource.getRepository(Box).findOneByOrFail({ id: box.id })).resolves.toMatchObject({
      state: BoxState.ERROR,
      desiredState: BoxDesiredState.STARTED,
      lifecycleJobId: null,
      runtimeAuthorized: false,
    })

    const runtimeLeaseService = createRuntimeLeaseService()
    const firstCleanupTargets = await runtimeLeaseService.observeRunnerSnapshot({
      runnerId,
      runnerEpoch,
      runnerIncarnation: 1,
      sequence: 1,
      boxes: [{ boxId: box.id, actualState: BoxState.STARTED, runtimeGeneration: runtimeGeneration! }],
    })
    const secondCleanupTargets = await runtimeLeaseService.observeRunnerSnapshot({
      runnerId,
      runnerEpoch,
      runnerIncarnation: 1,
      sequence: 2,
      boxes: [{ boxId: box.id, actualState: BoxState.STARTED, runtimeGeneration: runtimeGeneration! }],
    })

    expect(firstCleanupTargets.cleanupTargets).toEqual([
      { boxId: box.id, runnerId, runnerEpoch, runtimeGeneration: runtimeGeneration! },
    ])
    expect(secondCleanupTargets.cleanupTargets).toHaveLength(0)
    await expect(dataSource.getRepository(BoxRuntimeCleanup).find()).resolves.toEqual([
      expect.objectContaining({ boxId: box.id, runnerId, runnerEpoch, runtimeGeneration: runtimeGeneration! }),
    ])

    const orphanCleanupService = new RuntimeOrphanCleanupService(dataSource, jobService)
    await orphanCleanupService.enqueueTargets(firstCleanupTargets.cleanupTargets)
    await orphanCleanupService.enqueueTargets(firstCleanupTargets.cleanupTargets)
    const firstCleanupJobs = await dataSource.getRepository(Job).find({
      where: { type: JobType.STOP_ORPHAN_RUNTIME, resourceId: box.id },
    })
    expect(firstCleanupJobs).toHaveLength(1)
    expect(firstCleanupJobs[0].getPayload()).toMatchObject({
      force: true,
      runnerEpoch,
      runtimeGeneration,
    })
    await expect(dataSource.getRepository(Box).findOneByOrFail({ id: box.id })).resolves.toMatchObject({
      runtimeGeneration,
    })
    await expect(dataSource.getRepository(BoxRuntimeCleanup).findOneByOrFail({ boxId: box.id })).resolves.toMatchObject(
      {
        jobId: firstCleanupJobs[0].id,
      },
    )

    await jobService.updateJobStatus(firstCleanupJobs[0].id, JobStatus.IN_PROGRESS)
    await jobService.updateJobStatus(firstCleanupJobs[0].id, JobStatus.FAILED, 'orphan stop failed')
    await orphanCleanupService.reconcilePendingCleanups()
    await orphanCleanupService.reconcilePendingCleanups()
    const retriedCleanupJobs = await dataSource.getRepository(Job).find({
      where: { type: JobType.STOP_ORPHAN_RUNTIME, resourceId: box.id },
      order: { createdAt: 'ASC' },
    })
    expect(retriedCleanupJobs).toHaveLength(2)
    await expect(dataSource.getRepository(BoxRuntimeCleanup).findOneByOrFail({ boxId: box.id })).resolves.toMatchObject(
      {
        jobId: retriedCleanupJobs[1].id,
      },
    )
    await expect(dataSource.getRepository(Box).findOneByOrFail({ id: box.id })).resolves.toMatchObject({
      state: BoxState.ERROR,
      desiredState: BoxDesiredState.STARTED,
      lifecycleJobId: null,
      runtimeAuthorized: false,
    })
    await expect(dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id, cpu: Not(0) })).resolves.toBe(0)
    await expect(dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id, mem: Not(0) })).resolves.toBe(0)
    await expect(dataSource.getRepository(BoxUsagePeriod).countBy({ boxId: box.id, gpu: Not(0) })).resolves.toBe(0)

    await jobService.updateJobStatus(retriedCleanupJobs[1].id, JobStatus.IN_PROGRESS)
    await jobService.updateJobStatus(retriedCleanupJobs[1].id, JobStatus.COMPLETED)
    const cleanupBeforeRearm = await dataSource.getRepository(BoxRuntimeCleanup).findOneByOrFail({ boxId: box.id })

    const rearmedObservation = await runtimeLeaseService.observeRunnerSnapshot({
      runnerId,
      runnerEpoch,
      runnerIncarnation: 1,
      sequence: 3,
      boxes: [{ boxId: box.id, actualState: BoxState.STARTED, runtimeGeneration: runtimeGeneration! }],
    })
    expect(rearmedObservation.cleanupTargets).toEqual([
      { boxId: box.id, runnerId, runnerEpoch, runtimeGeneration: runtimeGeneration! },
    ])
    await expect(dataSource.getRepository(BoxRuntimeCleanup).findOneByOrFail({ boxId: box.id })).resolves.toMatchObject(
      {
        id: cleanupBeforeRearm.id,
        jobId: null,
      },
    )

    await Promise.all([
      orphanCleanupService.enqueueTargets(rearmedObservation.cleanupTargets),
      orphanCleanupService.enqueueTargets(rearmedObservation.cleanupTargets),
    ])
    const cleanupJobsAfterRearm = await dataSource.getRepository(Job).find({
      where: { type: JobType.STOP_ORPHAN_RUNTIME, resourceId: box.id },
      order: { createdAt: 'ASC' },
    })
    expect(cleanupJobsAfterRearm).toHaveLength(3)
    const cleanupAfterRearm = await dataSource.getRepository(BoxRuntimeCleanup).findOneByOrFail({ boxId: box.id })
    expect(cleanupAfterRearm).toMatchObject({
      id: cleanupBeforeRearm.id,
      jobId: cleanupJobsAfterRearm[2].id,
    })

    const pendingCleanupObservation = await runtimeLeaseService.observeRunnerSnapshot({
      runnerId,
      runnerEpoch,
      runnerIncarnation: 1,
      sequence: 4,
      boxes: [{ boxId: box.id, actualState: BoxState.STARTED, runtimeGeneration: runtimeGeneration! }],
    })
    expect(pendingCleanupObservation.cleanupTargets).toHaveLength(0)
    await expect(dataSource.getRepository(BoxRuntimeCleanup).findOneByOrFail({ boxId: box.id })).resolves.toMatchObject(
      {
        id: cleanupBeforeRearm.id,
        jobId: cleanupJobsAfterRearm[2].id,
      },
    )
  })
})
