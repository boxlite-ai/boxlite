/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { DataSource, Repository } from 'typeorm'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { RedisLockProvider } from '../common/redis-lock.provider'
import { Runner } from '../entities/runner.entity'
import { RunnerDiskExpansion } from '../entities/runner-disk-expansion.entity'
import { RunnerDiskUsageSample } from '../entities/runner-disk-usage-sample.entity'
import { RunnerState } from '../enums/runner-state.enum'
import { RunnerUnschedulableReason } from '../enums/runner-unschedulable-reason.enum'
import { RunnerDiskExpansionStatus } from '../enums/runner-disk-expansion-status.enum'
import { RunnerDataDiskRef } from '../common/runner-data-disk-ref'
import { RunnerService } from './runner.service'
import {
  CRON_LEASE_KEY,
  EXPANSION_ERROR,
  RunnerDiskExpansionService,
  sampleBucketAt,
} from './runner-disk-expansion.service'
import { GcpDiskClientLike } from './gcp-disk-client'
import { runnerDiskConfig } from '../../config/configuration'
import { TypedConfigService } from '../../config/typed-config.service'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip

// Its own database for the same reason the runner-assignment suite uses one:
// uuid-ossp extension creation is not atomic across concurrent suites.
const databaseName = `runner_disk_expansion_${process.pid}_${randomUUID().replaceAll('-', '')}`

const ref: RunnerDataDiskRef = { provider: 'gcp', project: 'proj', zone: 'z1', diskName: 'disk-1' }

describeIfDatabase('RunnerDiskExpansionService (integration, real Postgres)', () => {
  let dataSource: DataSource
  let runners: Repository<Runner>
  let expansions: Repository<RunnerDiskExpansion>
  let samples: Repository<RunnerDiskUsageSample>
  let redis: Redis
  let lockProvider: RedisLockProvider
  let service: RunnerDiskExpansionService
  let resizeDisk: jest.Mock
  let runnerService: RunnerService
  let ownsDatabase = false

  function configServiceWith(expansion: Record<string, unknown> = {}): TypedConfigService {
    const expansionBlock = {
      ...runnerDiskConfig({ RUNNER_DISK_EXPANSION_ENABLED: 'true' }).expansion,
      capGiB: 4096,
      ...expansion,
    }
    const runnerDisk = { ...runnerDiskConfig({}), expansion: expansionBlock }
    const values: Record<string, unknown> = {
      'runnerDisk': runnerDisk,
      'runnerDisk.expansion': expansionBlock,
      'runnerDisk.expansion.enabled': expansionBlock.enabled,
      'runnerDisk.expansion.sampleIntervalMinutes': expansionBlock.sampleIntervalMinutes,
      'runnerDisk.expansion.sampleRetentionHours': expansionBlock.sampleRetentionHours,
      'runnerDisk.expansion.confirmTimeoutMinutes': expansionBlock.confirmTimeoutMinutes,
      // RunnerService's constructor reads the availability-score block.
      'runnerScore.thresholds.availability': 10,
      ...Object.fromEntries(
        [
          'cpuUsage',
          'memoryUsage',
          'diskUsage',
          'allocatedCpu',
          'allocatedMemory',
          'allocatedDisk',
          'startedBoxes',
        ].map((weight) => [`runnerScore.weights.${weight}`, 0.1]),
      ),
      ...Object.fromEntries(
        ['cpu', 'cpuLoadAvg', 'memory', 'disk'].map((threshold) => [`runnerScore.penalty.thresholds.${threshold}`, 90]),
      ),
      ...Object.fromEntries(
        ['cpu', 'cpuLoadAvg', 'memory', 'disk'].map((exp) => [`runnerScore.penalty.exponents.${exp}`, 0.1]),
      ),
      ...Object.fromEntries(
        ['cpu', 'memory', 'disk'].flatMap((resource) => [
          [`runnerScore.targetValues.optimal.${resource}`, 0],
          [`runnerScore.targetValues.critical.${resource}`, 100],
        ]),
      ),
      'runnerScore.targetValues.optimal.allocCpu': 100,
      'runnerScore.targetValues.optimal.allocMem': 100,
      'runnerScore.targetValues.optimal.allocDisk': 100,
      'runnerScore.targetValues.optimal.startedBoxes': 0,
      'runnerScore.targetValues.critical.allocCpu': 500,
      'runnerScore.targetValues.critical.allocMem': 500,
      'runnerScore.targetValues.critical.allocDisk': 500,
      'runnerScore.targetValues.critical.startedBoxes': 100,
    }
    return { getOrThrow: (key: string) => values[key] } as unknown as TypedConfigService
  }

  function makeService(expansion: Record<string, unknown> = {}) {
    const gcpDiskClient: GcpDiskClientLike = {
      resizeDisk: resizeDisk,
      getZoneOperation: jest.fn(async () => ({ status: 'PENDING' as const })),
    }
    return new RunnerDiskExpansionService(
      expansions,
      samples,
      runners,
      gcpDiskClient,
      lockProvider,
      configServiceWith(expansion),
      dataSource,
      new EventEmitter2(),
    )
  }

  async function saveRunner(overrides: Partial<Runner> = {}): Promise<Runner> {
    const runner = new Runner({
      region: 'us',
      name: `runner-${randomUUID().slice(0, 8)}`,
      apiKey: 'key',
      apiVersion: '2',
      cpu: 8,
      memoryGiB: 32,
      diskGiB: 200,
    })
    runner.state = RunnerState.READY
    runner.availabilityScore = 100
    runner.lastChecked = new Date()
    runner.dataDiskRef = { ...ref }
    Object.assign(runner, overrides)
    return runners.save(runner)
  }

  // A runner whose free space sits below the water level: it wants to grow.
  function thirstyRunner(overrides: Partial<Runner> = {}): Promise<Runner> {
    return saveRunner({
      currentAllocatedDiskGiB: 190,
      currentDiskUsagePercentage: 95,
      ...overrides,
    })
  }

  beforeAll(async () => {
    const connection = {
      type: 'postgres' as const,
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
    }
    const admin = await new DataSource({ ...connection, database: process.env.DB_DATABASE }).initialize()
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      ownsDatabase = true
    } finally {
      await admin.destroy()
    }

    dataSource = await new DataSource({
      ...connection,
      database: databaseName,
      entities: [Runner, RunnerDiskExpansion, RunnerDiskUsageSample],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      // RunnerService.findOne reads through the query result cache; without
      // this the cache option on that path would misbehave on this DataSource.
      cache: true,
      synchronize: false,
    }).initialize()
    await dataSource.synchronize()

    runners = dataSource.getRepository(Runner)
    expansions = dataSource.getRepository(RunnerDiskExpansion)
    samples = dataSource.getRepository(RunnerDiskUsageSample)

    redis = new Redis({ host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT || 6379), lazyConnect: false })
    lockProvider = new RedisLockProvider(redis)
    resizeDisk = jest.fn(async () => ({ operation: 'op-integration' }))

    service = makeService()
    runnerService = new RunnerService(
      runners,
      {} as never,
      {} as never,
      lockProvider,
      configServiceWith(),
      {} as never,
      new EventEmitter2(),
      dataSource,
      redis,
    )
  })

  // Rounds sweep every READY runner in the table, so leftover fixtures would
  // leak into later rounds' call counts. Cascades take the expansion and
  // sample rows with the runner rows.
  afterEach(async () => {
    await runners?.clear()
    await redis?.del(CRON_LEASE_KEY)
  })

  afterAll(async () => {
    await redis?.quit().catch(() => undefined)
    await dataSource?.destroy().catch(() => undefined)
    if (ownsDatabase) {
      const connection = {
        type: 'postgres' as const,
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 5432),
        username: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_DATABASE,
      }
      const admin = await new DataSource(connection).initialize()
      try {
        await admin.query(`DROP DATABASE "${databaseName}"`)
      } finally {
        await admin.destroy()
      }
    }
  })

  describe('dataDiskRef persistence', () => {
    it('refreshes the identity on a heartbeat that carries it and keeps it when one does not', async () => {
      const runner = await saveRunner({ dataDiskRef: null })

      await runnerService.updateRunnerHealth(
        runner.id,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { ...ref, diskName: 'disk-new' },
      )
      let stored = await runners.findOneByOrFail({ id: runner.id })
      expect(stored.dataDiskRef).toEqual({ ...ref, diskName: 'disk-new' })

      // An older runner binary reporting no field must not erase it: the
      // controller would skip this runner forever after such a heartbeat.
      await runnerService.updateRunnerHealth(runner.id, undefined, undefined, undefined, undefined)
      stored = await runners.findOneByOrFail({ id: runner.id })
      expect(stored.dataDiskRef).toEqual({ ...ref, diskName: 'disk-new' })
    })
  })

  describe('usage samples', () => {
    it('keeps the max inside a bucket and rolls into a new bucket', async () => {
      const runner = await saveRunner()
      const bucket = sampleBucketAt(new Date(), 10)

      const serviceInternals = service as unknown as { upsertSample: (r: Runner, now: Date) => Promise<void> }
      runner.currentAllocatedDiskGiB = 100
      await serviceInternals.upsertSample(runner, bucket)
      // A quieter reading in the same bucket must not drag the max down.
      runner.currentAllocatedDiskGiB = 60
      await serviceInternals.upsertSample(runner, bucket)
      runner.currentAllocatedDiskGiB = 90
      await serviceInternals.upsertSample(runner, bucket)

      const inBucket = await samples.find({ where: { runnerId: runner.id } })
      expect(inBucket).toHaveLength(1)
      expect(inBucket[0].usedGiB).toBe(100)
      expect(inBucket[0].capacityGiB).toBe(200)

      const nextBucket = new Date(bucket.getTime() + 10 * 60_000)
      await serviceInternals.upsertSample(runner, nextBucket)
      expect(await samples.count({ where: { runnerId: runner.id } })).toBe(2)
    })

    it('deletes samples past the retention window', async () => {
      const runner = await saveRunner()
      const now = new Date()
      const retentionHours = runnerDiskConfig({}).expansion.sampleRetentionHours
      await samples.save([
        { runnerId: runner.id, bucketAt: new Date(now.getTime() - (retentionHours - 1) * 3600_000), usedGiB: 1, capacityGiB: 200 },
        { runnerId: runner.id, bucketAt: new Date(now.getTime() - (retentionHours + 1) * 3600_000), usedGiB: 1, capacityGiB: 200 },
      ] as RunnerDiskUsageSample[])

      const cleanup = service as unknown as { cleanupSamples: (now: Date) => Promise<void> }
      await cleanup.cleanupSamples(now)

      const remaining = await samples.find({ where: { runnerId: runner.id }, order: { bucketAt: 'ASC' } })
      expect(remaining).toHaveLength(1)
      expect(remaining[0].usedGiB).toBe(1)
    })
  })

  describe('unschedulable state machine', () => {
    it('marks only schedulable runners and lifts only its own mark', async () => {
      const internals = service as unknown as {
        markExhausted: (runner: Runner, reason: string) => Promise<void>
        liftExhaustedMark: (runner: Runner) => Promise<void>
      }

      const fresh = await saveRunner()
      // The operator endpoint flips the boolean only and never writes the
      // reason column, so a foreign mark is `unschedulable` with a NULL
      // reason. Neither half of the state machine may touch it: marking keys
      // on `unschedulable = false`, lifting keys on the reason being ours
      // (a NULL reason never matches).
      const operatorMarked = await saveRunner({ unschedulable: true, unschedulableReason: null })

      await internals.markExhausted(fresh, 'budget exhausted')
      await internals.markExhausted(operatorMarked, 'budget exhausted')

      expect((await runners.findOneByOrFail({ id: fresh.id })).unschedulableReason).toBe(
        RunnerUnschedulableReason.DISK_EXPAND_EXHAUSTED,
      )
      // Someone else's mark is never overwritten (marking keys on
      // unschedulable = false) and never lifted (lifting keys on the reason
      // being ours; a NULL reason never matches).
      expect((await runners.findOneByOrFail({ id: operatorMarked.id })).unschedulableReason).toBeNull()

      await internals.liftExhaustedMark(operatorMarked)
      expect((await runners.findOneByOrFail({ id: operatorMarked.id })).unschedulable).toBe(true)

      await internals.liftExhaustedMark(fresh)
      const lifted = await runners.findOneByOrFail({ id: fresh.id })
      expect(lifted.unschedulable).toBe(false)
      expect(lifted.unschedulableReason).toBeNull()
    })
  })

  describe('round behavior', () => {
    it('is serialized by the lease', async () => {
      const lease = await lockProvider.acquireLease(CRON_LEASE_KEY, 60)
      if (!lease) {
        throw new Error('expected to acquire the lease')
      }
      resizeDisk.mockClear()

      try {
        await thirstyRunner()
        await service.evaluateAndConfirm()
        expect(resizeDisk).not.toHaveBeenCalled()
      } finally {
        await lease.release()
      }
    })

    it('grows once and holds back while the attempt is pending', async () => {
      resizeDisk.mockClear()
      const runner = await thirstyRunner()

      await service.evaluateAndConfirm()
      expect(resizeDisk).toHaveBeenCalledTimes(1)
      expect(resizeDisk).toHaveBeenCalledWith(runner.dataDiskRef, 250)

      const attempts = await expansions.find({ where: { runnerId: runner.id } })
      expect(attempts).toHaveLength(1)
      expect(attempts[0]).toMatchObject({
        fromGiB: 200,
        toGiB: 250,
        accepted: true,
        status: RunnerDiskExpansionStatus.PENDING,
        operation: 'op-integration',
      })

      resizeDisk.mockClear()
      await service.evaluateAndConfirm()
      // The pending attempt owns the next word.
      expect(resizeDisk).not.toHaveBeenCalled()
    })

    it('records a rate-limited rejection and cools down', async () => {
      resizeDisk.mockImplementationOnce(async () => {
        throw Object.assign(new Error('rate limit exceeded'), { code: 400 })
      })
      const runner = await thirstyRunner()

      await service.evaluateAndConfirm()

      const rejected = await expansions.findOne({
        where: { runnerId: runner.id, error: EXPANSION_ERROR.RATE_LIMITED },
      })
      expect(rejected).toMatchObject({ accepted: false, status: RunnerDiskExpansionStatus.FAILED })

      // Inside the 30-minute cooldown the runner is not re-attempted, even
      // though the rejection spent no budget.
      resizeDisk.mockClear()
      await service.evaluateAndConfirm()
      expect(resizeDisk).not.toHaveBeenCalled()
    })
  })
})
