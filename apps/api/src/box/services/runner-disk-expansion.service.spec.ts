/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Logger } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { DataSource } from 'typeorm'
import { Runner } from '../entities/runner.entity'
import { RunnerDiskExpansion } from '../entities/runner-disk-expansion.entity'
import { RunnerDiskUsageSample } from '../entities/runner-disk-usage-sample.entity'
import { RunnerState } from '../enums/runner-state.enum'
import { RunnerUnschedulableReason } from '../enums/runner-unschedulable-reason.enum'
import { RunnerDiskExpansionStatus } from '../enums/runner-disk-expansion-status.enum'
import { RunnerDataDiskRef } from '../common/runner-data-disk-ref'
import { RedisLockProvider } from '../common/redis-lock.provider'
import { TypedConfigService } from '../../config/typed-config.service'
import {
  CONFIRM_TOLERANCE_RATIO,
  EXPANSION_ERROR,
  HYPERDISK_BALANCED_MAX_GIB,
  MAX_PATCHES_PER_ROUND,
  RunnerDiskExpansionService,
  headroomGiB,
  maxGrowthWithinWindow,
  nextSizeGiB,
  resolveCapGiB,
  resolveEffectiveCapGiB,
  sampleBucketAt,
  shouldTrigger,
} from './runner-disk-expansion.service'
import { GcpDiskClientLike, GcpZoneOperation } from './gcp-disk-client'
import { runnerDiskConfig } from '../../config/configuration'

const HOUR = 3600_000
const ref: RunnerDataDiskRef = { provider: 'gcp', project: 'proj', zone: 'z1', diskName: 'disk-1' }

describe('water-level planning functions', () => {
  describe('maxGrowthWithinWindow', () => {
    // The signature anti-simplification case: the spike sat five hours ago, so
    // it has already left any trailing 4h window, but it is inside the 48h
    // retention — an implementation that only compares against the newest
    // sample reports 0 and sizes the resize for nothing.
    it('captures a spike that has rolled out of the trailing window but stays in retention', () => {
      const now = new Date('2026-11-09T12:00:00Z')
      const samples = [
        { bucketAt: new Date(now.getTime() - 6 * HOUR), usedGiB: 10 },
        { bucketAt: new Date(now.getTime() - 5 * HOUR), usedGiB: 100 },
        { bucketAt: new Date(now.getTime() - 1 * HOUR), usedGiB: 100 },
      ]
      expect(maxGrowthWithinWindow(samples, 4 * HOUR, now)).toBe(90)
    })

    it('excludes pairs spanning more than the window', () => {
      const now = new Date('2026-11-09T12:00:00Z')
      const samples = [
        { bucketAt: new Date(now.getTime() - 10 * HOUR), usedGiB: 10 },
        { bucketAt: new Date(now.getTime() - 5 * HOUR), usedGiB: 500 },
      ]
      expect(maxGrowthWithinWindow(samples, 4 * HOUR, now)).toBe(0)
    })

    it('counts a pair exactly as long as the window', () => {
      const now = new Date('2026-11-09T12:00:00Z')
      const samples = [
        { bucketAt: new Date(now.getTime() - 2 * HOUR), usedGiB: 10 },
        { bucketAt: new Date(now.getTime() - 2 * HOUR + 4 * HOUR), usedGiB: 30 },
      ]
      expect(maxGrowthWithinWindow(samples, 4 * HOUR, now)).toBe(20)
    })

    it('degenerates to zero on insufficient history', () => {
      const now = new Date('2026-11-09T12:00:00Z')
      expect(maxGrowthWithinWindow([], 4 * HOUR, now)).toBe(0)
      expect(maxGrowthWithinWindow([{ bucketAt: now, usedGiB: 5 }], 4 * HOUR, now)).toBe(0)
      // Two samples, but the oldest one is younger than 30 minutes: the
      // runner may just have booted, and one bucket says nothing about growth.
      const young = [
        { bucketAt: new Date(now.getTime() - 20 * 60_000), usedGiB: 5 },
        { bucketAt: new Date(now.getTime() - 10 * 60_000), usedGiB: 30 },
      ]
      expect(maxGrowthWithinWindow(young, 4 * HOUR, now)).toBe(0)
    })
  })

  it('headroomGiB takes the larger of scaled growth and floor', () => {
    expect(headroomGiB(30, 2.0, 20)).toBe(60)
    expect(headroomGiB(5, 2.0, 20)).toBe(20)
  })

  it('resolveCapGiB prefers the expansion cap, then the admission limit, then reports none', () => {
    expect(resolveCapGiB(4096, 2048)).toBe(4096)
    expect(resolveCapGiB(undefined, 2048)).toBe(2048)
    expect(resolveCapGiB(undefined, undefined)).toBeUndefined()
  })

  it('resolveEffectiveCapGiB prefers explicit caps, then defaults to twice the disk size', () => {
    // Explicit cap and admission limit keep their precedence over the default.
    expect(resolveEffectiveCapGiB(4096, 2048, 200)).toBe(4096)
    expect(resolveEffectiveCapGiB(undefined, 2048, 200)).toBe(2048)
    // No explicit cap: twice the current size.
    expect(resolveEffectiveCapGiB(undefined, undefined, 200)).toBe(400)
    // Clamped to the Hyperdisk ceiling for large disks.
    expect(resolveEffectiveCapGiB(undefined, undefined, 100_000)).toBe(HYPERDISK_BALANCED_MAX_GIB)
    // A nonsensical disk size yields no cap — the uncapped gauge's only way in.
    expect(resolveEffectiveCapGiB(undefined, undefined, 0)).toBeUndefined()
    expect(resolveEffectiveCapGiB(undefined, undefined, -5)).toBeUndefined()
  })

  describe('shouldTrigger', () => {
    const capacity = 200
    it('triggers below the percentage line when it dominates', () => {
      // 20% of 200 = 40; H = 20 is below it.
      expect(shouldTrigger(39.9, capacity, 20, 20)).toBe(true)
      expect(shouldTrigger(40, capacity, 20, 20)).toBe(false)
    })
    it('triggers below the headroom target when it dominates', () => {
      // H = 80 beats the 40 percentage line.
      expect(shouldTrigger(79, capacity, 80, 20)).toBe(true)
      expect(shouldTrigger(80, capacity, 80, 20)).toBe(false)
    })
  })

  it('nextSizeGiB grows by the larger step, clamps to the cap and rounds up', () => {
    // step share = 25% of 200 = 50 > H = 20
    expect(nextSizeGiB(200, 20, 25, 4096)).toBe(250)
    // H = 60 beats the 50 step share
    expect(nextSizeGiB(200, 60, 25, 4096)).toBe(260)
    // cap clamps below the natural step
    expect(nextSizeGiB(200, 20, 25, 240)).toBe(240)
    // a fractional H above the step share rounds up to a whole GiB: 200 + 55.5 = 255.5
    expect(nextSizeGiB(200, 55.5, 25, 4096)).toBe(256)
  })

  it('sampleBucketAt truncates down to the interval', () => {
    expect(sampleBucketAt(new Date('2026-11-09T12:17:31Z'), 10)).toEqual(new Date('2026-11-09T12:10:00Z'))
    expect(sampleBucketAt(new Date('2026-11-09T12:00:00Z'), 10)).toEqual(new Date('2026-11-09T12:00:00Z'))
  })
})

/** Unit harness: every repository/client call is scripted, decisions asserted. */
function makeService(opts: {
  expansion?: Record<string, unknown>
  expandLimitGiB?: number
  readyRunners?: Runner[]
  pendingExpansions?: RunnerDiskExpansion[]
  zoneOperation?: GcpZoneOperation
  acceptedCount?: number
  hasPending?: boolean
  hasRecentRateLimit?: boolean
  samples?: RunnerDiskUsageSample[]
  acquireLease?: boolean
}) {
  const expansion = {
    ...runnerDiskConfig({ RUNNER_DISK_EXPANSION_ENABLED: 'true' }).expansion,
    capGiB: 4096,
    ...opts.expansion,
  }
  const values: Record<string, unknown> = {
    'runnerDisk': { expandLimitGiB: opts.expandLimitGiB },
    'runnerDisk.expansion': expansion,
    'runnerDisk.expansion.enabled': expansion.enabled,
    'runnerDisk.expansion.sampleIntervalMinutes': expansion.sampleIntervalMinutes,
    'runnerDisk.expansion.sampleRetentionHours': expansion.sampleRetentionHours,
    'runnerDisk.expansion.confirmTimeoutMinutes': expansion.confirmTimeoutMinutes,
  }
  const configService = { getOrThrow: (key: string) => values[key] } as unknown as TypedConfigService

  const expansions = {
    find: jest.fn(async () => opts.pendingExpansions ?? []),
    count: jest.fn(async () => opts.acceptedCount ?? 0),
    exist: jest.fn(async (criteria: { where: Partial<RunnerDiskExpansion> }) =>
      criteria.where.status === RunnerDiskExpansionStatus.PENDING
        ? (opts.hasPending ?? false)
        : (opts.hasRecentRateLimit ?? false),
    ),
    insert: jest.fn(),
    update: jest.fn(async () => ({ affected: 1, raw: [], generatedMaps: [] })),
  }

  const samplesRepository = {
    find: jest.fn(async () => opts.samples ?? []),
    delete: jest.fn(),
  }

  const runnerRepository = {
    find: jest.fn(async () => opts.readyRunners ?? [gcpRunner()]),
    findOne: jest.fn(async () => opts.readyRunners?.[0] ?? null),
    count: jest.fn(async () => 0),
    update: jest.fn(async () => ({ affected: 1, raw: [], generatedMaps: [] })),
  }

  const gcpDiskClient: GcpDiskClientLike = {
    resizeDisk: jest.fn(async () => ({ operation: 'op-1' })),
    getZoneOperation: jest.fn(async () => opts.zoneOperation ?? { status: 'PENDING' as const }),
  }

  const lease = { signal: new AbortController().signal, release: jest.fn() }
  const redisLockProvider = {
    acquireLease: jest.fn(async () => (opts.acquireLease === false ? null : lease)),
  } as unknown as RedisLockProvider

  const dataSource = { query: jest.fn(), queryResultCache: undefined } as unknown as DataSource
  const eventEmitter = { emit: jest.fn() } as unknown as EventEmitter2

  const service = new RunnerDiskExpansionService(
    expansions as never,
    samplesRepository as never,
    runnerRepository as never,
    gcpDiskClient,
    redisLockProvider,
    configService,
    dataSource,
    eventEmitter,
  )
  return { service, expansions, samplesRepository, runnerRepository, gcpDiskClient, redisLockProvider, eventEmitter }
}

function gcpRunner(overrides: Partial<Runner> = {}): Runner {
  const runner = new Runner({
    region: 'us',
    name: 'runner-1',
    apiKey: 'key',
    apiVersion: '2',
    cpu: 8,
    memoryGiB: 32,
    diskGiB: 200,
  })
  runner.id = '11111111-1111-4111-8111-111111111111'
  runner.state = RunnerState.READY
  runner.availabilityScore = 100
  // 10 GiB free on a 200 GiB disk: below the 20% line (40) and H (20) both.
  runner.currentAllocatedDiskGiB = 190
  runner.currentDiskUsagePercentage = 95
  runner.dataDiskRef = { ...ref }
  Object.assign(runner, overrides)
  return runner
}

describe('RunnerDiskExpansionService round', () => {
  it('stays dormant while disabled', async () => {
    const { service, expansions, redisLockProvider } = makeService({ expansion: { enabled: false } })

    await service.evaluateAndConfirm()

    expect(expansions.find).not.toHaveBeenCalled()
    expect(redisLockProvider.acquireLease).not.toHaveBeenCalled()
  })

  it('does nothing without the lease', async () => {
    const { service, expansions } = makeService({ acquireLease: false })

    await service.evaluateAndConfirm()

    expect(expansions.find).not.toHaveBeenCalled()
  })

  it('grows a runner below the water level and records the pending attempt', async () => {
    const { service, expansions, gcpDiskClient } = makeService({})

    await service.evaluateAndConfirm()

    expect(gcpDiskClient.resizeDisk).toHaveBeenCalledWith(ref, 250)
    expect(expansions.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        runnerId: '11111111-1111-4111-8111-111111111111',
        fromGiB: 200,
        toGiB: 250,
        accepted: true,
        operation: 'op-1',
        status: RunnerDiskExpansionStatus.PENDING,
      }),
    )
  })

  it('leaves a runner alone above the water level', async () => {
    const runner = gcpRunner({ currentAllocatedDiskGiB: 100 }) // 100 free > 40
    const { service, gcpDiskClient } = makeService({ readyRunners: [runner] })

    await service.evaluateAndConfirm()

    expect(gcpDiskClient.resizeDisk).not.toHaveBeenCalled()
  })

  it('skips runners without a usable disk identity', async () => {
    const runner = gcpRunner({ dataDiskRef: null })
    const { service, gcpDiskClient } = makeService({ readyRunners: [runner] })

    await service.evaluateAndConfirm()

    expect(gcpDiskClient.resizeDisk).not.toHaveBeenCalled()
  })

  it('holds back while an attempt is pending', async () => {
    const { service, gcpDiskClient } = makeService({ hasPending: true })

    await service.evaluateAndConfirm()

    expect(gcpDiskClient.resizeDisk).not.toHaveBeenCalled()
  })

  it('holds back during the 400 cooldown', async () => {
    const { service, gcpDiskClient } = makeService({ hasRecentRateLimit: true })

    await service.evaluateAndConfirm()

    expect(gcpDiskClient.resizeDisk).not.toHaveBeenCalled()
  })

  describe('budget', () => {
    it('marks unschedulable once the window budget is spent', async () => {
      const runner = gcpRunner()
      const { service, runnerRepository, gcpDiskClient } = makeService({ readyRunners: [runner], acceptedCount: 2 })

      await service.evaluateAndConfirm()

      expect(gcpDiskClient.resizeDisk).not.toHaveBeenCalled()
      expect(runnerRepository.update).toHaveBeenCalledWith(
        { id: runner.id, unschedulable: false, state: expect.anything() },
        { unschedulable: true, unschedulableReason: RunnerUnschedulableReason.DISK_EXPAND_EXHAUSTED },
      )
    })

    it('lifts the mark once usage drops, budget frees up and the cap has room', async () => {
      const runner = gcpRunner({
        unschedulable: true,
        unschedulableReason: RunnerUnschedulableReason.DISK_EXPAND_EXHAUSTED,
        currentDiskUsagePercentage: 50,
        currentAllocatedDiskGiB: 100, // recovered: 100 free, no new growth needed
      })
      const { service, runnerRepository, gcpDiskClient } = makeService({
        readyRunners: [runner],
        acceptedCount: 0,
      })

      await service.evaluateAndConfirm()

      // Lift keys on the reason being ours, so an operator's boolean-only
      // mark (reason NULL) is never touched by this controller.
      expect(runnerRepository.update).toHaveBeenCalledWith(
        { id: runner.id, unschedulableReason: RunnerUnschedulableReason.DISK_EXPAND_EXHAUSTED },
        { unschedulable: false, unschedulableReason: null },
      )
      // The lifted runner is back in the pool and, having plenty of free
      // space, is not resized this round.
      expect(gcpDiskClient.resizeDisk).not.toHaveBeenCalled()
    })

    it('does not lift while usage stays above the lift line', async () => {
      const runner = gcpRunner({
        unschedulable: true,
        unschedulableReason: RunnerUnschedulableReason.DISK_EXPAND_EXHAUSTED,
        currentDiskUsagePercentage: 80,
      })
      const { service, runnerRepository } = makeService({ readyRunners: [runner], acceptedCount: 0 })

      await service.evaluateAndConfirm()

      expect(runnerRepository.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ unschedulableReason: RunnerUnschedulableReason.DISK_EXPAND_EXHAUSTED }),
        expect.objectContaining({ unschedulable: false }),
      )
    })
  })

  describe('cap', () => {
    it('falls back to twice the disk size when no cap is configured', async () => {
      const { service, gcpDiskClient, expansions } = makeService({ expansion: { capGiB: undefined } })

      await service.evaluateAndConfirm()

      // Default ceiling = 2 × 200 = 400; the natural step (250) fits under it,
      // so the expansion proceeds with the sane relative default.
      expect(gcpDiskClient.resizeDisk).toHaveBeenCalledWith(ref, 250)
      expect(expansions.insert).toHaveBeenCalledWith(
        expect.objectContaining({ fromGiB: 200, toGiB: 250, accepted: true }),
      )
      expect((service as unknown as { gaugeValues: { uncapped: number } }).gaugeValues.uncapped).toBe(0)
    })

    it('skips and gauges only for a nonsensical disk size', async () => {
      const runner = gcpRunner({ diskGiB: 0 })
      const { service, gcpDiskClient } = makeService({ readyRunners: [runner], expansion: { capGiB: undefined } })

      await service.evaluateAndConfirm()

      expect(gcpDiskClient.resizeDisk).not.toHaveBeenCalled()
      expect((service as unknown as { gaugeValues: { uncapped: number } }).gaugeValues.uncapped).toBe(1)
    })

    it('marks unschedulable at the cap and never resizes past it', async () => {
      const runner = gcpRunner()
      const { service, runnerRepository, gcpDiskClient } = makeService({
        readyRunners: [runner],
        expansion: { capGiB: 200 },
      })

      await service.evaluateAndConfirm()

      expect(gcpDiskClient.resizeDisk).not.toHaveBeenCalled()
      expect(runnerRepository.update).toHaveBeenCalledWith(
        { id: runner.id, unschedulable: false, state: expect.anything() },
        { unschedulable: true, unschedulableReason: RunnerUnschedulableReason.DISK_EXPAND_EXHAUSTED },
      )
    })

    it('falls back to the admission expandLimit as the cap', async () => {
      const runner = gcpRunner()
      // resolveCapGiB(undefined, 240) = 240: capacity 200 under it, so the
      // natural 250 clamps to 240 — the two cap keys resolve as one chain.
      const { service, gcpDiskClient } = makeService({
        readyRunners: [runner],
        expansion: { capGiB: undefined },
        expandLimitGiB: 240,
      })

      await service.evaluateAndConfirm()

      expect(gcpDiskClient.resizeDisk).toHaveBeenCalledWith(ref, 240)
    })
  })

  it('stops issuing PATCHes after the per-round limit', async () => {
    const runners = Array.from({ length: MAX_PATCHES_PER_ROUND + 5 }, (_, i) =>
      gcpRunner({ id: `runner-${i}`, dataDiskRef: { ...ref, diskName: `disk-${i}` } }),
    )
    const { service, gcpDiskClient } = makeService({ readyRunners: runners })

    await service.evaluateAndConfirm()

    expect(gcpDiskClient.resizeDisk).toHaveBeenCalledTimes(MAX_PATCHES_PER_ROUND)
  })

  it('sizes by observed growth, not just the floor', async () => {
    const now = new Date()
    const samples = [
      { runnerId: 'r', bucketAt: new Date(now.getTime() - 6 * HOUR), usedGiB: 60 },
      { bucketAt: new Date(now.getTime() - 5 * HOUR), usedGiB: 160 },
    ] as RunnerDiskUsageSample[]
    // Growth 100 in-window → H = 200 > step share 50 → 200 + 200 = 400.
    const { service, gcpDiskClient } = makeService({ samples })

    await service.evaluateAndConfirm()

    expect(gcpDiskClient.resizeDisk).toHaveBeenCalledWith(ref, 400)
  })

  describe('resize failures', () => {
    it('records a rate-limited rejection and does not spend the budget', async () => {
      const { service, expansions, gcpDiskClient } = makeService({})
      // Rejected lazily: an eagerly-created rejected promise can surface as an
      // unhandled rejection before the service awaits it.
      ;(gcpDiskClient.resizeDisk as jest.Mock).mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error('rate limit exceeded'), { code: 400 })),
      )

      await service.evaluateAndConfirm()

      expect(expansions.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          accepted: false,
          status: RunnerDiskExpansionStatus.FAILED,
          error: EXPANSION_ERROR.RATE_LIMITED,
        }),
      )
    })

    it('records any other rejection as not accepted', async () => {
      const { service, expansions, gcpDiskClient } = makeService({})
      ;(gcpDiskClient.resizeDisk as jest.Mock).mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error('disk not found'), { code: 404 })),
      )

      await service.evaluateAndConfirm()

      expect(expansions.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          accepted: false,
          status: RunnerDiskExpansionStatus.FAILED,
          error: EXPANSION_ERROR.NOT_ACCEPTED,
        }),
      )
    })
  })

  describe('confirmation', () => {
    const pendingRow = () =>
      ({
        id: 'row-1',
        runnerId: '11111111-1111-4111-8111-111111111111',
        fromGiB: 200,
        toGiB: 250,
        accepted: true,
        operation: 'op-1',
        status: RunnerDiskExpansionStatus.PENDING,
        error: null,
        requestedAt: new Date(Date.now() - 2 * 60_000),
        confirmedAt: null,
      }) as RunnerDiskExpansion

    it('confirms once the runner reports the new filesystem size', async () => {
      // 0.979 sits between the 0.975 tolerance and 1.0 — the measured ext4
      // overhead zone. A confirmation that only passed on exact equality
      // would flag every real resize as unconfirmed.
      const runner = gcpRunner({ diskGiB: 250 * 0.979 })
      const { service, expansions } = makeService({
        readyRunners: [runner],
        pendingExpansions: [pendingRow()],
        zoneOperation: { status: 'DONE' },
      })

      await service.evaluateAndConfirm()

      expect(expansions.update).toHaveBeenCalledWith(
        { id: 'row-1', status: RunnerDiskExpansionStatus.PENDING },
        expect.objectContaining({ status: RunnerDiskExpansionStatus.CONFIRMED, confirmedAt: expect.any(Date) }),
      )
    })

    it('fails immediately when the zone operation failed', async () => {
      const { service, expansions } = makeService({
        readyRunners: [gcpRunner()],
        pendingExpansions: [pendingRow()],
        zoneOperation: { status: 'DONE', error: 'ZONE_CAPACITY: no room' },
      })

      await service.evaluateAndConfirm()

      expect(expansions.update).toHaveBeenCalledWith(
        { id: 'row-1', status: RunnerDiskExpansionStatus.PENDING },
        expect.objectContaining({ status: RunnerDiskExpansionStatus.FAILED, error: 'ZONE_CAPACITY: no room' }),
      )
    })

    it('fails as unconfirmed past the confirm timeout even when the operation is done', async () => {
      const row = pendingRow()
      row.requestedAt = new Date(Date.now() - 11 * 60_000)
      const runner = gcpRunner({ diskGiB: 200 }) // never grew
      const { service, expansions } = makeService({
        readyRunners: [runner],
        pendingExpansions: [row],
        zoneOperation: { status: 'DONE' },
      })

      await service.evaluateAndConfirm()

      expect(expansions.update).toHaveBeenCalledWith(
        { id: 'row-1', status: RunnerDiskExpansionStatus.PENDING },
        expect.objectContaining({ status: RunnerDiskExpansionStatus.FAILED, error: EXPANSION_ERROR.UNCONFIRMED }),
      )
    })

    it('logs terminal failures at error severity and confirmations at info', async () => {
      // The failing alarm's log filter is severity>=ERROR, and this close-out
      // is that alarm's only notice for the two failure modes it must report
      // (operation FAILED, never confirmed). Logging them at info would leave
      // the alarm silent exactly when it matters. confirmed stays informational.
      const errorSpy = jest.spyOn(Logger.prototype, 'error')
      const logSpy = jest.spyOn(Logger.prototype, 'log')

      // unconfirmed: op DONE but the filesystem never grew, past the timeout.
      const row = pendingRow()
      row.requestedAt = new Date(Date.now() - 11 * 60_000)
      const failed = makeService({
        readyRunners: [gcpRunner({ diskGiB: 200 })],
        pendingExpansions: [row],
        zoneOperation: { status: 'DONE' },
      })
      await failed.service.evaluateAndConfirm()

      // confirmed: op DONE and the runner reports the grown size.
      const confirmed = makeService({
        readyRunners: [gcpRunner({ diskGiB: 250 * 0.979 })],
        pendingExpansions: [pendingRow()],
        zoneOperation: { status: 'DONE' },
      })
      await confirmed.service.evaluateAndConfirm()

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed'),
        expect.objectContaining({ 'event.name': 'runner.disk_expansion' }),
      )
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('confirmed'),
        expect.objectContaining({ 'event.name': 'runner.disk_expansion' }),
      )

      errorSpy.mockRestore()
      logSpy.mockRestore()
    })

    it('leaves in-flight operations pending', async () => {
      const { service, expansions } = makeService({
        readyRunners: [gcpRunner()],
        pendingExpansions: [pendingRow()],
        zoneOperation: { status: 'RUNNING' },
      })

      await service.evaluateAndConfirm()

      expect(expansions.update).not.toHaveBeenCalled()
    })

    it('still waits out the timeout when the runner identity disappeared', async () => {
      const runner = gcpRunner({ dataDiskRef: null })
      const row = pendingRow()
      row.requestedAt = new Date(Date.now() - 11 * 60_000)
      const { service, expansions } = makeService({
        readyRunners: [runner],
        pendingExpansions: [row],
      })

      await service.evaluateAndConfirm()

      expect(expansions.update).toHaveBeenCalledWith(
        { id: 'row-1', status: RunnerDiskExpansionStatus.PENDING },
        expect.objectContaining({ status: RunnerDiskExpansionStatus.FAILED, error: EXPANSION_ERROR.UNCONFIRMED }),
      )
    })
  })

  it('confirm tolerance covers the measured ext4 overhead', () => {
    // 200 GiB disk: statfs total is ~195.8 GiB (4.18 GiB overhead, measured).
    // 195.8 / 200 = 0.979 > 0.975, so a correct resize confirms.
    expect(195.8 / 200).toBeGreaterThan(CONFIRM_TOLERANCE_RATIO)
  })
})
