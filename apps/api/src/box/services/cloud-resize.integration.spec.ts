import { randomUUID } from 'node:crypto'
import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { DataSource, IsNull } from 'typeorm'
import { Redis } from 'ioredis'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { Job } from '../entities/job.entity'
import { BoxState } from '../enums/box-state.enum'
import { JobStatus, JobType, ResourceType } from '../dto/job.dto'
import { BoxRepository } from '../repositories/box.repository'
import { RedisLockProvider } from '../common/redis-lock.provider'
import { BoxStateUpdatedEvent } from '../events/box-state-updated.event'
import { ResizeJobService } from './resize-job.service'
import { JobService } from './job.service'
import { UsageService } from '../../usage/services/usage.service'
import { BoxUsagePeriod } from '../../usage/entities/box-usage-period.entity'
import { AddCloudResizeJobs1793232000000 } from '../../migrations/pre-deploy/1793232000000-add-cloud-resize-jobs-migration'
import { BoxResizeService } from '../../boxlite-rest/box-resize.service'
import { Organization } from '../../organization/entities/organization.entity'
import { BoxLookupCacheInvalidationService } from './box-lookup-cache-invalidation.service'
import { boxLookupCacheKeyById } from '../utils/box-lookup-cache.util'
import { RESIZE_MAX_DURATION_MINUTES } from './resize-resources'

const databaseTests = process.env.DB_HOST && process.env.REDIS_HOST ? describe : describe.skip
const schema = `resize_${process.pid}_${randomUUID().replaceAll('-', '')}`
const runnerId = '00000000-0000-4000-8000-000000000001'
const target = { cpus: 4, memory_mib: 2048, max_cpus: 16, max_memory_mib: 8192 }

databaseTests('Cloud resize jobs with Postgres and Redis', () => {
  let db: DataSource
  let redis: Redis
  let usage: UsageService
  let leases: ResizeJobService
  let jobs: JobService
  let repository: BoxRepository
  let box: Box
  let job: Job
  let server: Server
  let coordinator: BoxResizeService
  let enabled: boolean
  let runtimeResources: typeof target
  let organization: Organization
  const availableRunner = jest.fn()
  let resourceQueries = 0
  const removeCache = jest.fn().mockResolvedValue(undefined)
  const cache = new BoxLookupCacheInvalidationService({ queryResultCache: { remove: removeCache } } as never)

  beforeAll(async () => {
    db = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema,
      extra: { options: `-c search_path=${schema},public` },
      entities: [Box, BoxLastActivity, Job, BoxUsagePeriod],
      entitySkipConstructor: true,
    }).initialize()
    await db.query(`CREATE SCHEMA "${schema}"`)
    await db.synchronize()
    // Exercise the shipped additive DDL against the pre-feature shape.
    await db.query('ALTER TABLE "box" DROP COLUMN "resizeJobId"')
    await db.query(
      'ALTER TABLE "job" DROP COLUMN "resizePhase", DROP COLUMN "nextAttemptAt", DROP COLUMN "resizeDeadlineAt", DROP COLUMN "attempt", DROP COLUMN "claimToken", DROP COLUMN "leaseExpiresAt"',
    )
    const runner = db.createQueryRunner()
    try {
      await new AddCloudResizeJobs1793232000000().up(runner)
    } finally {
      await runner.release()
    }
    redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT || 6379) })
    await redis.ping()
    repository = new BoxRepository(db, new EventEmitter2(), { invalidate: jest.fn() } as never)
    usage = new UsageService(
      db.getRepository(BoxUsagePeriod),
      new RedisLockProvider(redis),
      repository,
      {} as never,
      {} as never,
    )
    leases = new ResizeJobService(db.getRepository(Job), usage, cache)
    jobs = new JobService(
      db.getRepository(Job),
      redis,
      { handleJobCompletion: jest.fn().mockResolvedValue(undefined) } as never,
      leases,
    )
    server = createServer((req, res) => {
      resourceQueries++
      if (req.headers.authorization !== 'Bearer test-runner-key') {
        res.writeHead(401).end()
        return
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ resize_jobs_v1: true, resources: runtimeResources }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    coordinator = new BoxResizeService(
      db,
      { findOneByIdOrName: async () => box } as never,
      {
        findAvailableRunner: availableRunner,
        findOne: async () => ({
          apiVersion: '2',
          apiKey: 'test-runner-key',
          apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        }),
      } as never,
      usage,
      { assertOrganizationIsNotSuspended: jest.fn() } as never,
      { get: () => enabled } as never,
      jobs,
      cache,
    )
  })

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (redis) await redis.quit()
    if (db?.isInitialized) {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`)
      await db.destroy()
    }
  })

  beforeEach(async () => {
    enabled = true
    resourceQueries = 0
    availableRunner.mockReset().mockResolvedValue({ apiVersion: '2' })
    removeCache.mockClear()
    runtimeResources = { ...target, cpus: 1, memory_mib: 1024 }
    await db.query('TRUNCATE "job", "box_usage_periods", "box" CASCADE')
    box = Object.assign(new Box('test'), {
      organizationId: randomUUID(),
      osUser: 'root',
      runnerId,
      state: BoxState.STARTED,
      cpu: 1,
      mem: 1,
    })
    await db.getRepository(Box).save(box)
    await db.getRepository(BoxUsagePeriod).save({
      boxId: box.id,
      organizationId: box.organizationId,
      region: box.region,
      cpu: 1,
      mem: 1,
      gpu: 0,
      disk: box.disk,
      startAt: new Date(Date.now() - 60_000),
      endAt: null,
    })
    job = new Job({
      type: JobType.RESIZE_BOX,
      runnerId,
      resourceType: ResourceType.BOX,
      resourceId: box.id,
      payload: JSON.stringify({ version: 1, cpus: 4, memory_mib: 2048, previous: { cpus: 1, memory_mib: 1024 } }),
    })
    job.resizePhase = 'APPLY'
    job.nextAttemptAt = new Date()
    job.resizeDeadlineAt = new Date(Date.now() + RESIZE_MAX_DURATION_MINUTES * 60_000)
    await db.getRepository(Job).insert(job)
    await db.getRepository(Box).update(box.id, { pending: true, resizeJobId: job.id })
    organization = Object.assign(new Organization(), { id: box.organizationId, maxCpuPerBox: 16, maxMemoryPerBox: 8 })
  })

  const claim = () => leases.claim(runnerId, 10)
  const open = () => db.getRepository(BoxUsagePeriod).find({ where: { boxId: box.id, endAt: IsNull() } })
  const freshAdmission = async () => {
    await db.getRepository(Job).delete(job.id)
    await db.getRepository(Box).update(box.id, { cpu: 1, mem: 1, pending: false, resizeJobId: null })
  }
  const untilJob = async (phase: string) => {
    for (let i = 0; i < 100; i++) {
      const found = await db
        .getRepository(Job)
        .findOneBy({ resourceId: box.id, resizePhase: phase as Job['resizePhase'] })
      if (found) return found
      await sleep(20)
    }
    throw new Error(`resize did not reach ${phase}`)
  }
  const stopJob = () => jobs.createJob(null, JobType.STOP_BOX, runnerId, ResourceType.BOX, box.id)

  it('admits a rounded immutable target without changing Box or billing, then commits both on completion', async () => {
    await freshAdmission()
    const request = coordinator.resize(box.id, organization, { cpus: 4, memory_mib: 1537 })
    const accepted = await untilJob('APPLY')
    expect(resourceQueries).toBe(0)
    expect(availableRunner).toHaveBeenCalledWith(runnerId)
    expect(accepted.getPayload()).toMatchObject({ version: 1, cpus: 4, memory_mib: 2048 })
    expect(await db.getRepository(Box).findOneByOrFail({ id: box.id })).toMatchObject({
      cpu: 1,
      mem: 1,
      pending: true,
      resizeJobId: accepted.id,
    })
    expect(await open()).toEqual([expect.objectContaining({ cpu: 1, mem: 1 })])
    await expect(coordinator.resize(box.id, organization, { cpus: 8 })).rejects.toThrow('different resize')
    const [claimed] = await claim()
    await leases.report(
      accepted.id,
      runnerId,
      claimed.claimToken,
      JobStatus.COMPLETED,
      undefined,
      JSON.stringify(target),
    )
    expect(await request).toEqual(target)
    expect(await db.getRepository(Box).findOneByOrFail({ id: box.id })).toMatchObject({
      cpu: 4,
      mem: 2,
      pending: false,
      resizeJobId: null,
    })
    const periods = await db.getRepository(BoxUsagePeriod).find({ order: { startAt: 'ASC' } })
    expect(periods).toHaveLength(2)
    expect(periods[0]).toMatchObject({ cpu: 1, mem: 1 })
    expect(periods[1]).toMatchObject({ cpu: 4, mem: 2, endAt: null })
    expect(periods[0].endAt).toEqual(periods[1].startAt)
    const idKey = boxLookupCacheKeyById({ id: box.id, organizationId: box.organizationId, returnDestroyed: false })
    expect(removeCache.mock.calls.filter(([keys]) => keys.includes(idKey))).toHaveLength(2)
  }, 40_000)

  it('reconciles a runtime already at target while the Box is still old', async () => {
    await freshAdmission()
    runtimeResources = { ...target }
    const request = coordinator.resize(box.id, organization, { cpus: 4, memory_mib: 2048 })
    const accepted = await untilJob('APPLY')
    expect(await db.getRepository(Box).findOneByOrFail({ id: box.id })).toMatchObject({
      cpu: 1,
      mem: 1,
      pending: true,
    })
    const [claimed] = await claim()
    await leases.report(
      accepted.id,
      runnerId,
      claimed.claimToken,
      JobStatus.COMPLETED,
      undefined,
      JSON.stringify(target),
    )
    expect(await request).toEqual(target)
    expect(await db.getRepository(Box).findOneByOrFail({ id: box.id })).toMatchObject({
      cpu: 4,
      mem: 2,
      pending: false,
      resizeJobId: null,
    })
    expect(await db.getRepository(BoxUsagePeriod).count()).toBe(2)
  })

  it('queries actual allocation and rejects unauthorized, disabled, oversized or conflicting changes before writes', async () => {
    await freshAdmission()
    expect(await coordinator.resize(box.id, organization, {})).toEqual(runtimeResources)
    await expect(
      coordinator.resize(box.id, Object.assign(new Organization(), organization, { id: randomUUID() }), { cpus: 2 }),
    ).rejects.toThrow()
    enabled = false
    await expect(coordinator.resize(box.id, organization, { cpus: 2 })).rejects.toThrow('disabled')
    enabled = true
    await expect(coordinator.resize(box.id, organization, { memory_mib: 8193 })).rejects.toThrow('per-box limit')
    organization.maxCpuPerBox = 2
    await expect(coordinator.resize(box.id, organization, { cpus: 4 })).rejects.toThrow('per-box limit')
    await db.getRepository(Box).update(box.id, { pending: true })
    await expect(coordinator.resize(box.id, organization, { cpus: 2 })).rejects.toThrow('Box changed')
    expect(await db.getRepository(Job).count()).toBe(0)
    expect(await open()).toEqual([expect.objectContaining({ cpu: 1, mem: 1 })])
  })

  it.each([null, { apiVersion: '1' }])(
    'rejects an unavailable or incompatible Runner before writes: %j',
    async (runner) => {
      await freshAdmission()
      availableRunner.mockResolvedValue(runner)
      await expect(coordinator.resize(box.id, organization, { cpus: 2 })).rejects.toThrow('unavailable')
      expect(resourceQueries).toBe(0)
      expect(await db.getRepository(Job).count()).toBe(0)
    },
  )

  it.each([1, 1.5])('applies an explicit %s CPU target without observing runtime resources', async (cpus) => {
    await freshAdmission()
    // Admission must not consult these stale boot ceilings, even for a no-op target.
    runtimeResources = { cpus: 1, memory_mib: 1024, max_cpus: 1, max_memory_mib: 1024 }
    const request = coordinator.resize(box.id, organization, { cpus })
    const accepted = await untilJob('APPLY')
    expect(accepted.getPayload()).toMatchObject({ cpus, memory_mib: 1024 })
    expect(resourceQueries).toBe(0)
    availableRunner.mockResolvedValue(null)
    const retry = coordinator.resize(box.id, organization, { cpus })
    const [claimed] = await claim()
    const result = { ...target, cpus, memory_mib: 1024 }
    await leases.report(
      accepted.id,
      runnerId,
      claimed.claimToken,
      JobStatus.COMPLETED,
      undefined,
      JSON.stringify(result),
    )
    expect(await request).toEqual(result)
    expect(await retry).toEqual(result)
    expect(availableRunner).toHaveBeenCalledTimes(1)
    expect(await db.getRepository(Box).findOneByOrFail({ id: box.id })).toMatchObject({ cpu: cpus, mem: 1 })
    expect(await open()).toEqual([expect.objectContaining({ cpu: cpus, mem: 1 })])
    const count = await db.getRepository(BoxUsagePeriod).count()
    await leases.report(
      accepted.id,
      runnerId,
      claimed.claimToken,
      JobStatus.COMPLETED,
      undefined,
      JSON.stringify(result),
    )
    expect(await db.getRepository(BoxUsagePeriod).count()).toBe(count)
  })

  it('treats a duplicate completion as a no-op', async () => {
    const [claimed] = await claim()
    await leases.report(job.id, runnerId, claimed.claimToken, JobStatus.COMPLETED, undefined, JSON.stringify(target))
    const periods = await db.getRepository(BoxUsagePeriod).find({ order: { startAt: 'ASC' } })
    const openPeriods = await open()
    const duplicate = await leases.report(
      job.id,
      runnerId,
      claimed.claimToken,
      JobStatus.COMPLETED,
      undefined,
      JSON.stringify(target),
    )
    expect(duplicate.status).toBe(JobStatus.COMPLETED)
    expect(await db.getRepository(BoxUsagePeriod).count()).toBe(2)
    expect((await db.getRepository(BoxUsagePeriod).find({ order: { startAt: 'ASC' } })).map((row) => row.id)).toEqual(
      periods.map((row) => row.id),
    )
    expect(await open()).toEqual(openPeriods)
  })

  it('claims immediately and completes once under concurrent claims', async () => {
    const claims = (await Promise.all([claim(), claim()])).flat()
    expect(claims).toHaveLength(1)
    expect(claims[0].claimToken).toBeTruthy()
    await leases.report(job.id, runnerId, claims[0].claimToken, JobStatus.COMPLETED, undefined, JSON.stringify(target))
    expect(await claim()).toEqual([])
    expect(await db.getRepository(BoxUsagePeriod).count()).toBe(2)
  })

  it('rolls back Box and Job when the usage close fails, then completes on retry', async () => {
    await db.query(
      `ALTER TABLE "box_usage_periods" ADD CONSTRAINT reject_resize_close CHECK ("boxId" <> '${box.id}' OR "endAt" IS NULL)`,
    )
    try {
      const [claimed] = await claim()
      await expect(
        leases.report(job.id, runnerId, claimed.claimToken, JobStatus.COMPLETED, undefined, JSON.stringify(target)),
      ).rejects.toThrow()
      expect(await db.getRepository(Box).findOneByOrFail({ id: box.id })).toMatchObject({
        cpu: 1,
        mem: 1,
        pending: true,
        resizeJobId: job.id,
      })
      expect(await open()).toEqual([expect.objectContaining({ cpu: 1, mem: 1, endAt: null })])
      expect(await db.getRepository(Job).findOneByOrFail({ id: job.id })).toMatchObject({
        status: JobStatus.IN_PROGRESS,
      })
      await db.query('ALTER TABLE "box_usage_periods" DROP CONSTRAINT reject_resize_close')
      await leases.report(job.id, runnerId, claimed.claimToken, JobStatus.COMPLETED, undefined, JSON.stringify(target))
    } finally {
      await db.query('ALTER TABLE "box_usage_periods" DROP CONSTRAINT IF EXISTS reject_resize_close')
    }
    expect(await db.getRepository(Box).findOneByOrFail({ id: box.id })).toMatchObject({
      cpu: 4,
      mem: 2,
      pending: false,
      resizeJobId: null,
    })
    expect(await db.getRepository(BoxUsagePeriod).count()).toBe(2)
  })

  it('requeues a failure below the bound without changing Box or billing', async () => {
    const [first] = await claim()
    await leases.report(job.id, runnerId, first.claimToken, JobStatus.FAILED, 'temporary guest failure')
    const stored = await db.getRepository(Job).findOneByOrFail({ id: job.id })
    expect(stored).toMatchObject({ status: JobStatus.PENDING, completedAt: null, claimToken: null, attempt: 1 })
    expect(stored.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() - 1000)
    expect(await claim()).toEqual([])
    expect(await db.getRepository(Box).findOneByOrFail({ id: box.id })).toMatchObject({
      cpu: 1,
      mem: 1,
      resizeJobId: job.id,
    })
    expect(await open()).toEqual([expect.objectContaining({ cpu: 1, mem: 1 })])
  })

  it('terminalizes at the attempt bound and releases the lifecycle fence', async () => {
    const [claimed] = await claim()
    await db.query('UPDATE "job" SET "attempt" = $2 WHERE id = $1', [job.id, 10])
    await leases.report(job.id, runnerId, claimed.claimToken, JobStatus.FAILED, 'permanent failure')
    expect(await db.getRepository(Job).findOneByOrFail({ id: job.id })).toMatchObject({
      status: JobStatus.FAILED,
      completedAt: expect.any(Date),
      claimToken: null,
    })
    expect(await db.getRepository(Box).findOneByOrFail({ id: box.id })).toMatchObject({
      cpu: 1,
      mem: 1,
      pending: false,
      resizeJobId: null,
    })
    expect(await open()).toEqual([expect.objectContaining({ cpu: 1, mem: 1 })])
    await expect(stopJob()).resolves.toBeTruthy()
  })

  it('expires a lost lease, fences stale completion, and completes once after reclaim', async () => {
    const [first] = await claim()
    await db.query(`UPDATE "job" SET "leaseExpiresAt" = statement_timestamp() - interval '1 second' WHERE id = $1`, [
      job.id,
    ])
    await leases.reapResizeJobs()
    await db.query('UPDATE "job" SET "nextAttemptAt" = statement_timestamp() WHERE id = $1', [job.id])
    const restarted = new ResizeJobService(db.getRepository(Job), usage, cache)
    const [second] = await restarted.claim(runnerId, 10)
    expect(second.claimToken).not.toBe(first.claimToken)
    await expect(
      leases.report(job.id, runnerId, first.claimToken, JobStatus.COMPLETED, undefined, JSON.stringify(target)),
    ).rejects.toThrow('expired')
    await expect(
      leases.report(job.id, randomUUID(), second.claimToken, JobStatus.COMPLETED, undefined, JSON.stringify(target)),
    ).rejects.toThrow('not found')
    await expect(
      leases.report(
        job.id,
        runnerId,
        second.claimToken,
        JobStatus.COMPLETED,
        undefined,
        JSON.stringify({ ...target, cpus: 2 }),
      ),
    ).rejects.toThrow('immutable target')
    await leases.report(job.id, runnerId, second.claimToken, JobStatus.COMPLETED, undefined, JSON.stringify(target))
    expect(await db.getRepository(Box).findOneByOrFail({ id: box.id })).toMatchObject({
      cpu: 4,
      mem: 2,
      pending: false,
      resizeJobId: null,
    })
    expect(await claim()).toEqual([])
    expect(await db.getRepository(BoxUsagePeriod).count()).toBe(2)
  })

  it('requeues an expired lease without waiting on a job held by another transaction', async () => {
    const [claimed] = await claim()
    await db.query(`UPDATE "job" SET "leaseExpiresAt" = statement_timestamp() - interval '1 second' WHERE id = $1`, [
      claimed.id,
    ])
    const otherBox = Object.assign(new Box('held'), {
      organizationId: randomUUID(),
      osUser: 'root',
      runnerId,
      state: BoxState.STARTED,
      cpu: 1,
      mem: 1,
    })
    await db.getRepository(Box).save(otherBox)
    const held = new Job({
      type: JobType.RESIZE_BOX,
      runnerId,
      resourceType: ResourceType.BOX,
      resourceId: otherBox.id,
      payload: JSON.stringify({ version: 1, cpus: 4, memory_mib: 2048, previous: { cpus: 1, memory_mib: 1024 } }),
    })
    held.resizePhase = 'APPLY'
    held.nextAttemptAt = new Date()
    held.resizeDeadlineAt = new Date(Date.now() + RESIZE_MAX_DURATION_MINUTES * 60_000)
    await db.getRepository(Job).insert(held)
    await db.getRepository(Box).update(otherBox.id, { pending: true, resizeJobId: held.id })
    await db.query(
      `UPDATE "job" SET "status" = $1, "leaseExpiresAt" = statement_timestamp() - interval '1 second'
       WHERE id = $2`,
      [JobStatus.IN_PROGRESS, held.id],
    )

    const holder = db.createQueryRunner()
    await holder.connect()
    await holder.startTransaction()
    let reaping: Promise<void> | undefined
    try {
      await holder.query('SELECT id FROM "job" WHERE id = $1 FOR UPDATE', [held.id])
      reaping = leases.reapResizeJobs()
      let requeued = false
      for (let i = 0; i < 50; i++) {
        const current = await db.getRepository(Job).findOneByOrFail({ id: job.id })
        if (current.status === JobStatus.PENDING) {
          requeued = true
          break
        }
        await sleep(20)
      }
      expect(requeued).toBe(true)
      expect(await db.getRepository(Job).findOneByOrFail({ id: held.id })).toMatchObject({
        status: JobStatus.IN_PROGRESS,
      })
    } finally {
      await holder.rollbackTransaction()
      await holder.release()
      await reaping
    }
  })

  it('bounds terminalization behind a held Box row and retries on the next sweep', async () => {
    await db.query(`UPDATE "job" SET "resizeDeadlineAt" = statement_timestamp() - interval '1 second' WHERE id = $1`, [
      job.id,
    ])
    const holder = db.createQueryRunner()
    await holder.connect()
    await holder.startTransaction()
    let reaping: Promise<void> | undefined
    try {
      await holder.query('SELECT id FROM "box" WHERE id = $1 FOR UPDATE', [box.id])
      reaping = leases.reapResizeJobs()
      await Promise.race([
        reaping,
        sleep(8_000).then(() => {
          throw new Error('reaper exceeded its lock-wait bound')
        }),
      ])
    } finally {
      await holder.rollbackTransaction()
      await holder.release()
      await reaping
    }
    expect(await db.getRepository(Job).findOneByOrFail({ id: job.id })).toMatchObject({
      status: JobStatus.PENDING,
      completedAt: null,
    })
    await leases.reapResizeJobs()
    expect(await db.getRepository(Job).findOneByOrFail({ id: job.id })).toMatchObject({
      status: JobStatus.FAILED,
      completedAt: expect.any(Date),
    })
  }, 20_000)

  it('terminalizes a PENDING job past its deadline and releases the fence', async () => {
    await db.query(`UPDATE "job" SET "resizeDeadlineAt" = statement_timestamp() - interval '1 second' WHERE id = $1`, [
      job.id,
    ])
    await leases.reapResizeJobs()
    expect(await db.getRepository(Job).findOneByOrFail({ id: job.id })).toMatchObject({
      status: JobStatus.FAILED,
      completedAt: expect.any(Date),
    })
    expect(await db.getRepository(Box).findOneByOrFail({ id: box.id })).toMatchObject({
      cpu: 1,
      mem: 1,
      pending: false,
      resizeJobId: null,
    })
    expect(await open()).toEqual([expect.objectContaining({ cpu: 1, mem: 1 })])
    await expect(stopJob()).resolves.toBeTruthy()
  })

  it('terminalizes an IN_PROGRESS job past the deadline plus grace and invalidates cache', async () => {
    await claim()
    await db.query(
      `UPDATE "job" SET "resizeDeadlineAt" = statement_timestamp() - interval '3 minutes',
       "leaseExpiresAt" = statement_timestamp() + interval '1 hour' WHERE id = $1`,
      [job.id],
    )
    await leases.reapResizeJobs()
    expect(await db.getRepository(Job).findOneByOrFail({ id: job.id })).toMatchObject({
      status: JobStatus.FAILED,
      completedAt: expect.any(Date),
    })
    expect(await db.getRepository(Box).findOneByOrFail({ id: box.id })).toMatchObject({
      cpu: 1,
      mem: 1,
      pending: false,
      resizeJobId: null,
    })
    expect(await open()).toEqual([expect.objectContaining({ cpu: 1, mem: 1 })])
    const idKey = boxLookupCacheKeyById({ id: box.id, organizationId: box.organizationId, returnDestroyed: false })
    expect(removeCache.mock.calls.filter(([keys]) => keys.includes(idKey))).toHaveLength(1)
    await expect(stopJob()).resolves.toBeTruthy()
  })

  it('terminalizes an IN_PROGRESS job at the attempt bound when its lease is gone', async () => {
    await claim()
    await db.query(
      `UPDATE "job" SET "attempt" = 10, "leaseExpiresAt" = statement_timestamp() - interval '3 minutes'
       WHERE id = $1`,
      [job.id],
    )
    await leases.reapResizeJobs()
    expect(await db.getRepository(Job).findOneByOrFail({ id: job.id })).toMatchObject({
      status: JobStatus.FAILED,
      completedAt: expect.any(Date),
    })
    expect(await db.getRepository(Box).findOneByOrFail({ id: box.id })).toMatchObject({
      cpu: 1,
      mem: 1,
      pending: false,
      resizeJobId: null,
    })
    expect(await open()).toEqual([expect.objectContaining({ cpu: 1, mem: 1 })])
    const idKey = boxLookupCacheKeyById({ id: box.id, organizationId: box.organizationId, returnDestroyed: false })
    expect(removeCache.mock.calls.filter(([keys]) => keys.includes(idKey))).toHaveLength(1)
    await expect(stopJob()).resolves.toBeTruthy()
  })

  it('rejects a late completion after terminal failure without writing Box or billing', async () => {
    const [claimed] = await claim()
    await db.query('UPDATE "job" SET "attempt" = $2 WHERE id = $1', [job.id, 10])
    await leases.report(job.id, runnerId, claimed.claimToken, JobStatus.FAILED, 'permanent failure')
    await expect(
      leases.report(job.id, runnerId, claimed.claimToken, JobStatus.COMPLETED, undefined, JSON.stringify(target)),
    ).rejects.toThrow('already failed')
    expect(await db.getRepository(Box).findOneByOrFail({ id: box.id })).toMatchObject({ cpu: 1, mem: 1 })
    expect(await db.getRepository(BoxUsagePeriod).count()).toBe(1)
  })

  it('keeps the resize fence through unrelated repository writes', async () => {
    await repository.updateWhere(box.id, { whereCondition: {}, updateData: { labels: { test: 'updated' } } })
    expect(await db.getRepository(Box).findOneByOrFail({ id: box.id })).toMatchObject({
      pending: true,
      resizeJobId: job.id,
    })
  })

  it('rolls APPLY billing daily at the old shape', async () => {
    await db.query(
      'UPDATE "box_usage_periods" SET "startAt" = statement_timestamp() - interval \'2 days\' WHERE "boxId" = $1',
      [box.id],
    )
    await usage.closeAndReopenUsagePeriods()
    const periods = await db.getRepository(BoxUsagePeriod).find({ where: { boxId: box.id }, order: { startAt: 'ASC' } })
    expect(periods).toHaveLength(2)
    expect(periods[0].endAt).toEqual(periods[1].startAt)
    expect(periods[1]).toMatchObject({ cpu: 1, mem: 1, endAt: null })
  })

  it('does not let a delayed STARTED event restore the pre-resize billing snapshot', async () => {
    const event = new BoxStateUpdatedEvent(box, BoxState.STARTING, BoxState.STARTED)
    const [claimed] = await claim()
    await leases.report(job.id, runnerId, claimed.claimToken, JobStatus.COMPLETED, undefined, JSON.stringify(target))
    await usage.handleBoxStateUpdate(event)
    expect(await open()).toEqual([expect.objectContaining({ cpu: 4, mem: 2 })])
  })

  it('keeps old lifecycle claiming and failure semantics while a resize job is not due', async () => {
    await db.query('UPDATE "job" SET "nextAttemptAt" = statement_timestamp() + interval \'1 hour\' WHERE id = $1', [
      job.id,
    ])
    const ordinary = new Job({
      type: JobType.START_BOX,
      runnerId,
      resourceType: ResourceType.BOX,
      resourceId: 'ordinary',
    })
    await db.getRepository(Job).insert(ordinary)
    const claimed = await (jobs as any).claimPendingJobs(runnerId, 10)
    expect(claimed.map((row: Job) => row.id)).toEqual([ordinary.id])
    await jobs.updateJobStatus(ordinary.id, JobStatus.FAILED, 'ordinary failure')
    expect(await db.getRepository(Job).findOneByOrFail({ id: ordinary.id })).toMatchObject({
      status: JobStatus.FAILED,
      completedAt: expect.any(Date),
    })
    await expect(jobs.updateJobStatus(job.id, JobStatus.FAILED)).rejects.toThrow('leased')
  })
})
