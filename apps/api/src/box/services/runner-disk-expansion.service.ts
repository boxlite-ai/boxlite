/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Inject, Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Cron, CronExpression } from '@nestjs/schedule'
import { DataSource, LessThan, MoreThan, Not, Repository } from 'typeorm'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { Counter, metrics } from '@opentelemetry/api'
import { Runner } from '../entities/runner.entity'
import { RunnerDiskExpansion } from '../entities/runner-disk-expansion.entity'
import { RunnerDiskUsageSample } from '../entities/runner-disk-usage-sample.entity'
import { RunnerState } from '../enums/runner-state.enum'
import { RunnerUnschedulableReason } from '../enums/runner-unschedulable-reason.enum'
import { RunnerDiskExpansionStatus } from '../enums/runner-disk-expansion-status.enum'
import { isDiskCapacityExpandable, RunnerDataDiskRef } from '../common/runner-data-disk-ref'
import { RedisLockProvider, withRedisLockLease } from '../common/redis-lock.provider'
import { TypedConfigService } from '../../config/typed-config.service'
import { LogExecution } from '../../common/decorators/log-execution.decorator'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'
import { RunnerEvents } from '../constants/runner-events'
import { RunnerUnschedulableUpdatedEvent } from '../events/runner-unschedulable-updated.event'
import { runnerLookupCacheKeyById } from '../utils/runner-lookup-cache.util'
import { GcpDiskClient, GcpDiskClientLike, GcpDiskRateLimitedError, toExpansionClientError } from './gcp-disk-client'
import { runnerDiskConfig } from '../../config/configuration'

/** Fixed behaviors, deliberately not configurable (misconfiguration surface). */
/** How long a GCP rate-limit 400 keeps the runner out of new attempts. */
export const RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000
/** Fewer samples (or a span shorter than this) means no growth history: H falls back to its floor. */
export const MIN_GROWTH_SAMPLES = 2
export const MIN_GROWTH_SPAN_MS = 30 * 60 * 1000
/** Per round, cap on runners actually sent to GCP; the rest wait for the next round. */
export const MAX_PATCHES_PER_ROUND = 20
/**
 * ext4 metadata keeps the filesystem ~2.1% below the block device (measured:
 * 4.18 GiB on a 200 GiB disk), so the runner's reported diskGiB (a filesystem
 * total) needs this slack before it can count as "reached the new size". The
 * remaining margin is deliberate: if real overhead ever exceeds it,
 * confirmation times out loudly instead of passing silently.
 */
export const CONFIRM_TOLERANCE_RATIO = 0.975

/** Relative cap default multiplier: one default-ceiling generation per 100% growth. */
export const CAP_DEFAULT_MULTIPLIER = 2

const CRON_NAME = 'runner-disk-expansion'
/** The lease key serializing the round across API instances; exported for the integration spec. */
export const CRON_LEASE_KEY = 'runner-disk-expansion'
const CRON_LEASE_TTL_SECONDS = 60

/** Values of runner_disk_expansion.error that carry structural meaning. */
export const EXPANSION_ERROR = {
  RATE_LIMITED: 'rate_limited',
  NOT_ACCEPTED: 'not_accepted',
  UNCONFIRMED: 'unconfirmed',
} as const

let expansionCounter: Counter | undefined
function resultCounter(): Counter {
  return (expansionCounter ??= metrics
    .getMeter('')
    .createCounter('runner_disk_expansion_total', {
      description: 'Runner data-disk expansion attempts by outcome',
    }))
}

export interface GrowthSample {
  bucketAt: Date
  usedGiB: number
}

type RunnerDiskSettings = ReturnType<typeof runnerDiskConfig>
type ExpansionSettings = RunnerDiskSettings['expansion']

/**
 * Worst usage growth inside any window of `windowMs` across the retained
 * samples: max over all sample pairs whose timestamps span at most the window.
 *
 * "Any" window, not just the trailing one: a spike five hours ago has already
 * left a trailing 4h window, but it is exactly the growth a resize must be
 * sized for, so pairs anywhere in the retention period count. O(n²) over at
 * most 288 samples is negligible.
 *
 * Too little history (fewer than two samples, or the oldest sample younger
 * than MIN_GROWTH_SPAN_MS) yields 0 — the caller's headroom then degenerates
 * to its floor, which is the conservative answer for a new or cold disk.
 */
export function maxGrowthWithinWindow(samples: GrowthSample[], windowMs: number, now: Date): number {
  const sorted = [...samples].sort((a, b) => a.bucketAt.getTime() - b.bucketAt.getTime())
  if (sorted.length < MIN_GROWTH_SAMPLES) {
    return 0
  }
  if (now.getTime() - sorted[0].bucketAt.getTime() < MIN_GROWTH_SPAN_MS) {
    return 0
  }
  let max = 0
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].bucketAt.getTime() - sorted[i].bucketAt.getTime() > windowMs) {
        break
      }
      max = Math.max(max, sorted[j].usedGiB - sorted[i].usedGiB)
    }
  }
  return max
}

/** Headroom target H: worst-window growth times the safety factor, never below the floor. */
export function headroomGiB(growthGiB: number, safetyFactor: number, floorGiB: number): number {
  return Math.max(growthGiB * safetyFactor, floorGiB)
}

/** The expansion cap, or undefined when neither config key is set — a configuration gap the caller must surface. */
export function resolveCapGiB(capGiB: number | undefined, expandLimitGiB: number | undefined): number | undefined {
  return capGiB ?? expandLimitGiB
}

/**
 * Trigger when free space falls below the larger of the percentage line and
 * the headroom target.
 *
 * The comparison is deliberately insensitive to float error: both sides sit at
 * whole-GiB scale (the headroom floor, a percentage of capacity), while double
 * storage round-trips exactly and the runner's float32 reporting quantizes
 * below ~1e-4 GiB even at multi-TiB sizes — orders of magnitude from any
 * decision boundary. Keep it that way: no float equality, and never tighten
 * the threshold gap to sub-GiB.
 */
export function shouldTrigger(
  freeGiB: number,
  capacityGiB: number,
  headroomGiB: number,
  triggerPercentage: number,
): boolean {
  return freeGiB < Math.max((capacityGiB * triggerPercentage) / 100, headroomGiB)
}

/** Hyperdisk Balanced's ceiling per GCP docs (64 TiB); the relative cap default clamps to it. */
export const HYPERDISK_BALANCED_MAX_GIB = 65536

/**
 * Cap applied when neither RUNNER_DISK_EXPANSION_CAP_GIB nor the admission
 * expand limit is configured: twice the disk's current size, clamped to the
 * Hyperdisk ceiling, so RUNNER_DISK_EXPANSION_ENABLED alone turns the feature
 * on with a sane ceiling instead of a configuration-gap dead end. Undefined
 * only for a nonsensical diskGiB (0 or less), which the uncapped gauge then
 * surfaces as the defensive counter it is.
 */
export function resolveEffectiveCapGiB(
  capGiB: number | undefined,
  expandLimitGiB: number | undefined,
  diskGiB: number,
): number | undefined {
  const explicit = resolveCapGiB(capGiB, expandLimitGiB)
  if (explicit !== undefined) return explicit
  if (!Number.isFinite(diskGiB) || diskGiB <= 0) return undefined
  return Math.min(HYPERDISK_BALANCED_MAX_GIB, diskGiB * CAP_DEFAULT_MULTIPLIER)
}

/** New size: capacity plus the larger of headroom and the step share, clamped to the cap, rounded up to whole GiB. */
export function nextSizeGiB(capacityGiB: number, headroomGiB: number, stepPercentage: number, capGiB: number): number {
  const step = Math.max(headroomGiB, (capacityGiB * stepPercentage) / 100)
  return Math.ceil(Math.min(capGiB, capacityGiB + step))
}

/** Sample-bucket start: `now` truncated down to the sampling interval. */
export function sampleBucketAt(now: Date, intervalMinutes: number): Date {
  const ms = intervalMinutes * 60_000
  return new Date(Math.floor(now.getTime() / ms) * ms)
}

/**
 * Grows a runner's cloud data disk when free space crosses the water level.
 *
 * One cron round does, in order: resolve pending expansions (poll the zone
 * operation, confirm via the runner's reported diskGiB), then evaluate every
 * READY runner that reports a GCP disk: lift stale exhaustion marks, record a
 * usage sample, and where gates allow (no pending attempt, no rate-limit
 * cooldown, budget remaining, under the cap, water level crossed) issue one
 * `disks.update`. Budget exhaustion or reaching the cap marks the runner
 * unschedulable as `disk_expand_exhausted` — unconditionally of the water
 * level, because a runner that cannot grow should take no new boxes; the mark
 * lifts itself once usage drops, budget frees up, and the cap has room again.
 * A single Redis lease keeps multiple API instances from running the round.
 *
 * Everything is dormant while RUNNER_DISK_EXPANSION_ENABLED is off (default):
 * no sampling, no marks, no GCP calls.
 */
@Injectable()
export class RunnerDiskExpansionService {
  private readonly logger = new Logger(RunnerDiskExpansionService.name)
  private readonly gaugeValues = { pending: 0, exhausted: 0, missingRef: 0, uncapped: 0 }

  constructor(
    @InjectRepository(RunnerDiskExpansion)
    private readonly expansions: Repository<RunnerDiskExpansion>,
    @InjectRepository(RunnerDiskUsageSample)
    private readonly samplesRepository: Repository<RunnerDiskUsageSample>,
    @InjectRepository(Runner)
    private readonly runnerRepository: Repository<Runner>,
    @Inject(GcpDiskClient)
    private readonly gcpDiskClient: GcpDiskClientLike,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly configService: TypedConfigService,
    private readonly dataSource: DataSource,
    @Inject(EventEmitter2)
    private readonly eventEmitter: EventEmitter2,
  ) {
    const meter = metrics.getMeter('')
    const gauge = (name: string, description: string, read: () => number) =>
      meter.createObservableGauge(name, { description }).addCallback((observation) => observation.observe(read()))
    gauge('runner_disk_expansion_pending', 'Runners with a data-disk expansion awaiting confirmation', () =>
      this.gaugeValues.pending,
    )
    gauge(
      'runner_disk_expand_exhausted_runners',
      'Runners unschedulable because their data disk cannot grow further',
      () => this.gaugeValues.exhausted,
    )
    gauge(
      'runner_disk_missing_ref',
      'Ready runners reporting no data-disk identity (rollout gap on GCP stages; expected on AWS stages)',
      () => this.gaugeValues.missingRef,
    )
    gauge(
      'runner_disk_expansion_uncapped',
      'Runners skipped because expansion is on without any cap configured',
      () => this.gaugeValues.uncapped,
    )
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: CRON_NAME, waitForCompletion: true })
  @LogExecution(CRON_NAME)
  @WithInstrumentation()
  async evaluateAndConfirm(): Promise<void> {
    if (!this.configService.getOrThrow('runnerDisk.expansion.enabled')) {
      return
    }
    const lease = await this.redisLockProvider.acquireLease(CRON_LEASE_KEY, CRON_LEASE_TTL_SECONDS)
    if (!lease) {
      return
    }

    await withRedisLockLease(lease, async (signal) => {
      const now = new Date()
      await this.confirmPendingExpansions(signal, now)
      await this.evaluateRunners(signal, now)
      await this.cleanupSamples(now)
      await this.refreshGauges()
    })
  }

  /** Resolution half of the round: drive every pending expansion to confirmed or failed. */
  private async confirmPendingExpansions(signal: AbortSignal, now: Date): Promise<void> {
    const confirmTimeoutMs = this.configService.getOrThrow('runnerDisk.expansion.confirmTimeoutMinutes') * 60_000
    const pendings = await this.expansions.find({ where: { status: RunnerDiskExpansionStatus.PENDING }, take: 100 })

    for (const row of pendings) {
      signal.throwIfAborted()
      try {
        const runner = await this.runnerRepository.findOne({
          where: { id: row.runnerId },
          select: ['id', 'diskGiB', 'dataDiskRef'],
        })
        if (!runner || !isDiskCapacityExpandable(runner.dataDiskRef)) {
          // Runner gone, or its disk identity changed under the pending attempt.
          // Wait out the confirm timeout rather than failing fast: the identity
          // may arrive with the next heartbeat.
          if (now.getTime() - row.requestedAt.getTime() > confirmTimeoutMs) {
            await this.closePending(row, RunnerDiskExpansionStatus.FAILED, EXPANSION_ERROR.UNCONFIRMED, now)
            resultCounter().add(1, { result: EXPANSION_ERROR.UNCONFIRMED })
          }
          continue
        }

        const op = await this.gcpDiskClient.getZoneOperation(runner.dataDiskRef, row.operation)
        if (op.status === 'DONE' && op.error) {
          // Zone capacity or quota failures surface here immediately, minutes
          // before any confirmation timeout would.
          await this.closePending(row, RunnerDiskExpansionStatus.FAILED, op.error, now)
          resultCounter().add(1, { result: 'op_failed' })
        } else if (op.status === 'DONE') {
          if (runner.diskGiB >= row.toGiB * CONFIRM_TOLERANCE_RATIO) {
            await this.closePending(row, RunnerDiskExpansionStatus.CONFIRMED, null, now)
            resultCounter().add(1, { result: 'confirmed' })
          } else if (now.getTime() - row.requestedAt.getTime() > confirmTimeoutMs) {
            await this.closePending(row, RunnerDiskExpansionStatus.FAILED, EXPANSION_ERROR.UNCONFIRMED, now)
            resultCounter().add(1, { result: EXPANSION_ERROR.UNCONFIRMED })
          }
        }
        // PENDING/RUNNING, or DONE while the filesystem has not caught up yet
        // within the timeout: leave it pending.
      } catch (e) {
        // A failed zoneOperations.get is transient; the timeout path above
        // eventually closes the attempt if it persists.
        this.logger.warn(`Zone operation poll failed for runner ${row.runnerId}: ${errorMessage(e)}`)
      }
    }
  }

  private async closePending(
    row: RunnerDiskExpansion,
    status: RunnerDiskExpansionStatus,
    error: string | null,
    now: Date,
  ): Promise<void> {
    // Conditional on still-pending: the lease makes a concurrent writer
    // impossible, but the row may already be terminal if a previous round's
    // update raced a crash-restart.
    const result = await this.expansions.update(
      { id: row.id, status: RunnerDiskExpansionStatus.PENDING },
      {
        status,
        error,
        confirmedAt: status === RunnerDiskExpansionStatus.CONFIRMED ? now : row.confirmedAt,
      },
    )
    if (!result.affected) {
      return
    }
    const latencyMs = Math.round(now.getTime() - row.requestedAt.getTime())
    const attributes = {
      'event.name': 'runner.disk_expansion',
      'runner.id': row.runnerId,
      'disk.from_gib': row.fromGiB,
      'disk.to_gib': row.toGiB,
      'disk.expansion_result': status,
      'disk.expansion_latency_ms': latencyMs,
      ...(error ? { 'disk.expansion_error': error } : {}),
    }
    // A terminal failure is not ignorable: the failing alarm's log filter is
    // severity>=ERROR, and the operation-FAILED and never-confirmed closes are
    // that alarm's only notice for them. Confirmations stay informational.
    if (status === RunnerDiskExpansionStatus.FAILED) {
      this.logger.error(`Runner ${row.runnerId} data disk expansion failed: ${error}`, attributes)
    } else {
      this.logger.log(`Runner ${row.runnerId} data disk expansion ${status}`, attributes)
    }
  }

  /** Evaluation half of the round: sample, gate, and where allowed, grow. */
  private async evaluateRunners(signal: AbortSignal, now: Date): Promise<void> {
    const expansion = this.configService.getOrThrow('runnerDisk.expansion')
    const { expandLimitGiB } = this.configService.getOrThrow('runnerDisk')
    const windowMs = expansion.growthWindowHours * 3600_000
    const retentionCutoff = new Date(now.getTime() - expansion.sampleRetentionHours * 3600_000)

    const ready = await this.runnerRepository.find({ where: { state: RunnerState.READY } })
    this.gaugeValues.missingRef = ready.filter((r) => !isDiskCapacityExpandable(r.dataDiskRef)).length
    this.gaugeValues.uncapped = 0

    let patchesThisRound = 0
    for (const runner of ready) {
      signal.throwIfAborted()
      if (patchesThisRound >= MAX_PATCHES_PER_ROUND) {
        break
      }
      const dataDiskRef = runner.dataDiskRef
      if (!isDiskCapacityExpandable(dataDiskRef)) {
        continue
      }
      try {
        const patched = await this.evaluateRunner(runner, {
          expansion,
          expandLimitGiB,
          windowMs,
          retentionCutoff,
          now,
          dataDiskRef,
        })
        patchesThisRound += patched ? 1 : 0
      } catch (e) {
        this.logger.error(`Error evaluating data-disk expansion for runner ${runner.id}`, e)
      }
    }
  }

  /** One runner through lift → sample → gates → resize. Returns whether a PATCH was issued. */
  private async evaluateRunner(
    runner: Runner,
    ctx: {
      expansion: ExpansionSettings
      expandLimitGiB: number | undefined
      windowMs: number
      retentionCutoff: Date
      now: Date
      dataDiskRef: RunnerDataDiskRef
    },
  ): Promise<boolean> {
    const { expansion, expandLimitGiB, windowMs, retentionCutoff, now } = ctx
    const budgetWindowStart = new Date(now.getTime() - expansion.growthWindowHours * 3600_000)
    // Lift and cap gates share the effective cap: explicit cap, admission
    // limit, or the per-runner relative default — never an undefined dead end.
    const cap = resolveEffectiveCapGiB(expansion.capGiB, expandLimitGiB, runner.diskGiB)

    // 0) Lift first, ahead of every skip: a recovered runner returns to the
    // pool as soon as usage, budget, and cap allow, even if this round will
    // not grow it for other reasons.
    if (runner.unschedulable && runner.unschedulableReason === RunnerUnschedulableReason.DISK_EXPAND_EXHAUSTED) {
      const budgetFree =
        (await this.expansions.count({
          where: { runnerId: runner.id, accepted: true, requestedAt: MoreThan(budgetWindowStart) },
        })) < expansion.maxExpansionsPerWindow
      const capHasRoom = cap !== undefined && runner.diskGiB < cap
      if (runner.currentDiskUsagePercentage < expansion.liftPercentage && budgetFree && capHasRoom) {
        await this.liftExhaustedMark(runner)
      }
    }

    // 1) Record this round's usage sample (bucket max upsert).
    await this.upsertSample(runner, now)

    // 2) A pending attempt owns the next word: no new request until it resolves.
    if (await this.expansions.exist({ where: { runnerId: runner.id, status: RunnerDiskExpansionStatus.PENDING } })) {
      return false
    }
    // A recent GCP 400 keeps the runner quiet for the cooldown.
    const cooldownStart = new Date(now.getTime() - RATE_LIMIT_COOLDOWN_MS)
    if (
      await this.expansions.exist({
        where: { runnerId: runner.id, error: EXPANSION_ERROR.RATE_LIMITED, requestedAt: MoreThan(cooldownStart) },
      })
    ) {
      return false
    }

    // 3) Budget: locally counted accepted attempts inside the trailing window.
    const accepted = await this.expansions.count({
      where: { runnerId: runner.id, accepted: true, requestedAt: MoreThan(budgetWindowStart) },
    })
    if (accepted >= expansion.maxExpansionsPerWindow) {
      await this.markExhausted(runner, 'budget exhausted')
      return false
    }

    // 4) Cap: the effective cap resolves to the relative default when unset,
    // so this branch is defensive — a nonsensical diskGiB (0 or less from a
    // broken healthcheck) is the only way in, and the gauge counts it.
    if (cap === undefined) {
      this.gaugeValues.uncapped += 1
      return false
    }
    if (runner.diskGiB >= cap) {
      await this.markExhausted(runner, `cap ${cap}GiB reached`)
      return false
    }

    // 5) Water level from retained samples.
    const samples = await this.samplesRepository.find({
      where: { runnerId: runner.id, bucketAt: MoreThan(retentionCutoff) },
      select: ['bucketAt', 'usedGiB'],
      order: { bucketAt: 'ASC' },
    })
    const growth = maxGrowthWithinWindow(samples, windowMs, now)
    const headroom = headroomGiB(growth, expansion.safetyFactor, expansion.headroomFloorGiB)
    const freeGiB = runner.diskGiB - runner.currentAllocatedDiskGiB
    if (!shouldTrigger(freeGiB, runner.diskGiB, headroom, expansion.triggerPercentage)) {
      return false
    }

    // 6) One PATCH per runner per round.
    const toGiB = nextSizeGiB(runner.diskGiB, headroom, expansion.stepPercentage, cap)
    await this.initiate(runner, ctx.dataDiskRef, toGiB, now)
    return true
  }

  private async initiate(runner: Runner, ref: RunnerDataDiskRef, toGiB: number, now: Date): Promise<void> {
    try {
      const { operation } = await this.gcpDiskClient.resizeDisk(ref, toGiB)
      await this.expansions.insert({
        runnerId: runner.id,
        fromGiB: runner.diskGiB,
        toGiB,
        accepted: true,
        operation,
        status: RunnerDiskExpansionStatus.PENDING,
        error: null,
        requestedAt: now,
        confirmedAt: null,
      })
      this.logger.log(`Runner ${runner.id} data disk expansion requested`, {
        'event.name': 'runner.disk_expansion',
        'runner.id': runner.id,
        'disk.from_gib': runner.diskGiB,
        'disk.to_gib': toGiB,
        'disk.expansion_result': 'requested',
      })
    } catch (e) {
      const mapped = toExpansionClientError(e)
      const rateLimited = mapped instanceof GcpDiskRateLimitedError
      await this.expansions.insert({
        runnerId: runner.id,
        fromGiB: runner.diskGiB,
        toGiB,
        accepted: false,
        operation: null,
        status: RunnerDiskExpansionStatus.FAILED,
        error: rateLimited ? EXPANSION_ERROR.RATE_LIMITED : EXPANSION_ERROR.NOT_ACCEPTED,
        requestedAt: now,
        confirmedAt: null,
      })
      resultCounter().add(1, { result: rateLimited ? EXPANSION_ERROR.RATE_LIMITED : EXPANSION_ERROR.NOT_ACCEPTED })
      this.logger.error(`Runner ${runner.id} data disk resize to ${toGiB}GiB rejected: ${errorMessage(mapped)}`, {
        'event.name': 'runner.disk_expansion',
        'runner.id': runner.id,
        'disk.from_gib': runner.diskGiB,
        'disk.to_gib': toGiB,
        'disk.expansion_result': rateLimited ? EXPANSION_ERROR.RATE_LIMITED : EXPANSION_ERROR.NOT_ACCEPTED,
      })
    }
  }

  private async upsertSample(runner: Runner, now: Date): Promise<void> {
    const intervalMinutes = this.configService.getOrThrow('runnerDisk.expansion.sampleIntervalMinutes')
    const bucketAt = sampleBucketAt(now, intervalMinutes)
    // The raw upsert is the whole point: TypeORM's upsert() cannot express
    // GREATEST(), and read-then-write would lose the max under the (rare)
    // concurrent round another instance runs before taking the lease.
    await this.dataSource.query(
      `INSERT INTO "runner_disk_usage_sample" ("runnerId", "bucketAt", "usedGiB", "capacityGiB")
       VALUES ($1, $2, $3, $4)
       ON CONFLICT ("runnerId", "bucketAt") DO UPDATE
       SET "usedGiB" = GREATEST("runner_disk_usage_sample"."usedGiB", EXCLUDED."usedGiB"),
           "capacityGiB" = EXCLUDED."capacityGiB"`,
      [runner.id, bucketAt, runner.currentAllocatedDiskGiB, runner.diskGiB],
    )
  }

  private async cleanupSamples(now: Date): Promise<void> {
    const retentionHours = this.configService.getOrThrow('runnerDisk.expansion.sampleRetentionHours')
    await this.samplesRepository.delete({ bucketAt: LessThan(new Date(now.getTime() - retentionHours * 3600_000)) })
  }

  private async refreshGauges(): Promise<void> {
    this.gaugeValues.pending = await this.expansions.count({ where: { status: RunnerDiskExpansionStatus.PENDING } })
    this.gaugeValues.exhausted = await this.runnerRepository.count({
      where: { unschedulableReason: RunnerUnschedulableReason.DISK_EXPAND_EXHAUSTED },
    })
  }

  /**
   * Marks the runner unschedulable as disk_expand_exhausted. Unconditional on
   * the water level (a runner that cannot grow should take no new boxes), but
   * never over another mark: the conditional update only lands when the runner
   * is currently schedulable, so operator and disk-pressure marks stay theirs.
   */
  private async markExhausted(runner: Runner, reason: string): Promise<void> {
    const result = await this.runnerRepository.update(
      { id: runner.id, unschedulable: false, state: Not(RunnerState.DECOMMISSIONED) },
      { unschedulable: true, unschedulableReason: RunnerUnschedulableReason.DISK_EXPAND_EXHAUSTED },
    )
    if (!result.affected) {
      return
    }
    this.logger.warn(`Runner ${runner.id} marked unschedulable (disk_expand_exhausted): ${reason}`, {
      'event.name': 'runner.disk_expansion',
      'runner.id': runner.id,
      'disk.expansion_result': 'exhausted',
      'runner.unschedulable_reason': reason,
    })
    this.invalidateRunnerCache(runner.id)
    const marked = Object.assign(Object.create(Runner.prototype) as Runner, runner, {
      unschedulable: true,
      unschedulableReason: RunnerUnschedulableReason.DISK_EXPAND_EXHAUSTED,
    })
    this.eventEmitter.emit(RunnerEvents.UNSCHEDULABLE_UPDATED, new RunnerUnschedulableUpdatedEvent(marked, false, true))
  }

  /**
   * Lifts this controller's own mark only. The conditional update keys on the
   * reason being disk_expand_exhausted, so operator and disk-pressure marks
   * are never touched.
   */
  private async liftExhaustedMark(runner: Runner): Promise<void> {
    const result = await this.runnerRepository.update(
      { id: runner.id, unschedulableReason: RunnerUnschedulableReason.DISK_EXPAND_EXHAUSTED },
      { unschedulable: false, unschedulableReason: null },
    )
    if (!result.affected) {
      return
    }
    this.logger.log(`Runner ${runner.id} disk_expand_exhausted mark lifted`, {
      'event.name': 'runner.disk_expansion',
      'runner.id': runner.id,
      'disk.expansion_result': 'recovered',
    })
    this.invalidateRunnerCache(runner.id)
    const lifted = Object.assign(Object.create(Runner.prototype) as Runner, runner, {
      unschedulable: false,
      unschedulableReason: null,
    })
    this.eventEmitter.emit(RunnerEvents.UNSCHEDULABLE_UPDATED, new RunnerUnschedulableUpdatedEvent(lifted, true, false))
  }

  // update() bypasses the entity subscriber that normally invalidates the
  // runner lookup cache and emits notifications; the emit is done by the
  // callers above, the cache flush here.
  private invalidateRunnerCache(runnerId: string): void {
    const cache = this.dataSource.queryResultCache
    if (!cache) {
      return
    }
    cache
      .remove([runnerLookupCacheKeyById(runnerId)])
      .catch((error) =>
        this.logger.warn(
          `Failed to invalidate runner lookup cache for ${runnerId}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
