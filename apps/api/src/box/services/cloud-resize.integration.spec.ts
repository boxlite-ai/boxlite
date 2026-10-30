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
      'ALTER TABLE "job" DROP COLUMN "resizePhase", DROP COLUMN "nextAttemptAt", DROP COLUMN "attempt", DROP COLUMN "claimToken", DROP COLUMN "leaseExpiresAt"',
    )
    const runner = db.createQueryRunner()
    try {
      await new AddCloudResizeJobs1793232000000().up(runner)
    } finally {
      await runner.release()
    }
    redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) })
    repository = new BoxRepository(db, new EventEmitter2(), { invalidate: jest.fn() } as never)
    usage = new UsageService(
      db.getRepository(BoxUsagePeriod),
      new RedisLockProvider(redis),
      repository,
      {} as never,
      {} as never,
    )
    leases = new ResizeJobService(db.getRepository(Job), cache)
    jobs = new JobService(
      db.getRepository(Job),
      redis,
      { handleJobCompletion: jest.fn().mockResolvedValue(undefined) } as never,
      leases,
    )
    server = createServer((req, res) => {
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
    await db
      .getRepository(BoxUsagePeriod)
      .save({
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
    job.resizePhase = 'BILLING_PENDING'
    await db.getRepository(Job).insert(job)
    await db.getRepository(Box).update(box.id, { cpu: 4, mem: 2, pending: true, resizeJobId: job.id })
    organization = Object.assign(new Organization(), { id: box.organizationId, maxCpuPerBox: 16, maxMemoryPerBox: 8 })
  })

  const claim = () => leases.claim(runnerId, 10)
  const activate = () => usage.activateResizeJob(job.id)
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

  it('admits a rounded immutable target before billing and reuses retries across API recovery', async () => {
    await freshAdmission()
    await db.query('ALTER TABLE "box_usage_periods" ADD CONSTRAINT fail_billing CHECK (cpu <> 4)')
    const request = coordinator.resize(box.id, organization, { cpus: 4, memory_mib: 1537 })
    try {
      const accepted = await untilJob('BILLING_PENDING')
      expect(accepted.getPayload()).toMatchObject({ version: 1, cpus: 4, memory_mib: 2048 })
      expect(await db.getRepository(Box).findOneByOrFail({ id: box.id })).toMatchObject({
        cpu: 4,
        mem: 2,
        pending: true,
      })
      expect(await open()).toEqual([expect.objectContaining({ cpu: 1, mem: 1 })])
      expect(await claim()).toEqual([])
      await expect(coordinator.resize(box.id, organization, { cpus: 8 })).rejects.toThrow('different resize')
      await db.query('ALTER TABLE "box_usage_periods" DROP CONSTRAINT fail_billing')
      // Startup scan, including a lost phase-B response, must be idempotent.
      await db.query('UPDATE "job" SET "nextAttemptAt" = NULL WHERE id = $1', [accepted.id])
      await coordinator.onApplicationBootstrap()
      await coordinator.recoverBilling()
      const repeat = coordinator.resize(box.id, organization, { cpus: 4, memory_mib: 1537 })
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
      expect(await repeat).toEqual(target)
      expect(await db.getRepository(Job).count()).toBe(1)
      expect(await db.getRepository(BoxUsagePeriod).count()).toBe(2)
      const idKey = boxLookupCacheKeyById({ id: box.id, organizationId: box.organizationId, returnDestroyed: false })
      expect(removeCache.mock.calls.filter(([keys]) => keys.includes(idKey))).toHaveLength(2)
    } finally {
      await db.query('ALTER TABLE "box_usage_periods" DROP CONSTRAINT IF EXISTS fail_billing')
      await request.catch(() => {})
    }
  }, 40_000)

  it('queries actual allocation and rejects unauthorized, disabled, oversized or conflicting changes before writes', async () => {
    await freshAdmission()
    expect(await coordinator.resize(box.id, organization, {})).toEqual(runtimeResources)
    expect(await coordinator.resize(box.id, organization, { cpus: 1 })).toEqual(runtimeResources)
    await expect(
      coordinator.resize(box.id, Object.assign(new Organization(), organization, { id: randomUUID() }), { cpus: 2 }),
    ).rejects.toThrow()
    enabled = false
    await expect(coordinator.resize(box.id, organization, { cpus: 2 })).rejects.toThrow('disabled')
    enabled = true
    await expect(coordinator.resize(box.id, organization, { memory_mib: 8193 })).rejects.toThrow('ceilings')
    organization.maxCpuPerBox = 2
    await expect(coordinator.resize(box.id, organization, { cpus: 4 })).rejects.toThrow('per-box limit')
    await db.getRepository(Box).update(box.id, { pending: true })
    await expect(coordinator.resize(box.id, organization, { cpus: 2 })).rejects.toThrow('Box changed')
    expect(await db.getRepository(Job).count()).toBe(0)
    expect(await open()).toEqual([expect.objectContaining({ cpu: 1, mem: 1 })])
  })

  it('cannot claim before billing, then rolls over exactly once under concurrent activation', async () => {
    expect(await claim()).toEqual([])
    await Promise.allSettled([activate(), activate()])
    await activate()
    const periods = await db.getRepository(BoxUsagePeriod).find({ order: { startAt: 'ASC' } })
    expect(periods).toHaveLength(2)
    expect(periods[0].cpu).toBe(1)
    expect(periods[0].endAt).toEqual(periods[1].startAt)
    expect(periods[1]).toMatchObject({ cpu: 4, mem: 2, endAt: null })
    const claims = (await Promise.all([claim(), claim()])).flat()
    expect(claims).toHaveLength(1)
    expect(claims[0].claimToken).toBeTruthy()
  })

  it('preserves accepted configuration when billing fails and recovers after service restart', async () => {
    await db.query(`ALTER TABLE "box_usage_periods" ADD CONSTRAINT reject_new_resize_period CHECK (cpu <> 4)`)
    try {
      await expect(activate()).rejects.toThrow()
    } finally {
      await db.query('ALTER TABLE "box_usage_periods" DROP CONSTRAINT reject_new_resize_period')
    }
    expect(await open()).toEqual([expect.objectContaining({ cpu: 1, endAt: null })])
    expect(await db.getRepository(Box).findOneByOrFail({ id: box.id })).toMatchObject({ cpu: 4, mem: 2, pending: true })
    expect(await claim()).toEqual([])
    const restarted = new UsageService(
      db.getRepository(BoxUsagePeriod),
      new RedisLockProvider(redis),
      repository,
      {} as never,
      {} as never,
    )
    await restarted.activateResizeJob(job.id)
    expect(await open()).toEqual([expect.objectContaining({ cpu: 4, mem: 2 })])
  })

  it('requeues failure without rolling back target or closing the job', async () => {
    await activate()
    const [first] = await claim()
    await leases.report(job.id, runnerId, first.claimToken, JobStatus.FAILED, 'temporary guest failure')
    const stored = await db.getRepository(Job).findOneByOrFail({ id: job.id })
    expect(stored).toMatchObject({ status: JobStatus.PENDING, completedAt: null, claimToken: null, attempt: 1 })
    expect(stored.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() - 1000)
    expect(await claim()).toEqual([])
    expect(await db.getRepository(Box).findOneByOrFail({ id: box.id })).toMatchObject({
      cpu: 4,
      mem: 2,
      resizeJobId: job.id,
    })
    expect(await open()).toEqual([expect.objectContaining({ cpu: 4, mem: 2 })])
  })

  it('expires a lost lease, fences stale completion, and completes once after reclaim', async () => {
    await activate()
    const [first] = await claim()
    await db.query(`UPDATE "job" SET "leaseExpiresAt" = statement_timestamp() - interval '1 second' WHERE id = $1`, [
      job.id,
    ])
    await leases.recoverExpired()
    await db.query('UPDATE "job" SET "nextAttemptAt" = statement_timestamp() WHERE id = $1', [job.id])
    const restarted = new ResizeJobService(db.getRepository(Job), cache)
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

  it('keeps the resize fence through unrelated repository writes', async () => {
    await repository.updateWhere(box.id, { whereCondition: {}, updateData: { labels: { test: 'updated' } } })
    expect(await db.getRepository(Box).findOneByOrFail({ id: box.id })).toMatchObject({
      pending: true,
      resizeJobId: job.id,
    })
  })

  it('rolls APPLY billing daily and does not let 100 billing-pending boxes starve other periods', async () => {
    const older = new Date(Date.now() - 3 * 86_400_000)
    const blocked = Array.from({ length: 100 }, () => {
      const row = Object.assign(new Box('test'), {
        organizationId: box.organizationId,
        osUser: 'root',
        runnerId,
        state: BoxState.STARTED,
        cpu: 4,
        mem: 2,
        pending: true,
      })
      const queued = new Job({
        type: JobType.RESIZE_BOX,
        runnerId,
        resourceType: ResourceType.BOX,
        resourceId: row.id,
        payload: job.payload,
      })
      queued.resizePhase = 'BILLING_PENDING'
      row.resizeJobId = queued.id
      return { row, queued }
    })
    await db.getRepository(Box).save(blocked.map(({ row }) => row))
    await db.getRepository(Job).save(blocked.map(({ queued }) => queued))
    await db
      .getRepository(BoxUsagePeriod)
      .save(
        blocked.map(({ row }) => ({
          boxId: row.id,
          organizationId: row.organizationId,
          region: row.region,
          cpu: 1,
          mem: 1,
          gpu: 0,
          disk: row.disk,
          startAt: older,
          endAt: null,
        })),
      )
    await activate()
    const [active] = await open()
    await db.getRepository(BoxUsagePeriod).update(active.id, { startAt: new Date(Date.now() - 2 * 86_400_000) })
    await usage.closeAndReopenUsagePeriods()
    expect(await open()).toEqual([expect.objectContaining({ cpu: 4, mem: 2, startAt: expect.any(Date) })])
    expect((await open())[0].id).not.toBe(active.id)
    expect(await db.getRepository(BoxUsagePeriod).count({ where: { endAt: IsNull() } })).toBe(101)
    expect(await db.getRepository(Job).count({ where: { resizePhase: 'BILLING_PENDING' } })).toBe(100)
  })

  it('does not let a delayed STARTED event restore the pre-resize billing snapshot', async () => {
    const event = new BoxStateUpdatedEvent(box, BoxState.STARTING, BoxState.STARTED)
    await activate()
    const [claimed] = await claim()
    await leases.report(job.id, runnerId, claimed.claimToken, JobStatus.COMPLETED, undefined, JSON.stringify(target))
    await usage.handleBoxStateUpdate(event)
    expect(await open()).toEqual([expect.objectContaining({ cpu: 4, mem: 2 })])
  })

  it('keeps old lifecycle claiming and failure semantics while hiding unready resize jobs', async () => {
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
