/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { EntityManager, IsNull, LessThan, Not, Repository } from 'typeorm'
import { metrics, type Counter } from '@opentelemetry/api'
import { BoxUsagePeriod } from '../entities/box-usage-period.entity'
import { OnEvent } from '@nestjs/event-emitter'
import { BoxStateUpdatedEvent } from '../../box/events/box-state-updated.event'
import { BoxDesiredStateUpdatedEvent } from '../../box/events/box-desired-state-updated.event'
import { BoxState } from '../../box/enums/box-state.enum'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BoxEvents } from './../../box/constants/box-events.constants'
import { Cron, CronExpression } from '@nestjs/schedule'
import { RedisLockLease, RedisLockProvider, withRedisLockLease } from '../../box/common/redis-lock.provider'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../../box/constants/box.constants'
import { BoxUsagePeriodArchive } from '../entities/box-usage-period-archive.entity'
import { TrackableJobExecutions } from '../../common/interfaces/trackable-job-executions'
import { TrackJobExecution } from '../../common/decorators/track-job-execution.decorator'
import { setTimeout as sleep } from 'timers/promises'
import { LogExecution } from '../../common/decorators/log-execution.decorator'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'
import { BoxRepository } from '../../box/repositories/box.repository'
import { UsageExportOutboxService } from './usage-export-outbox.service'
import { Box } from '../../box/entities/box.entity'
import { Runner } from '../../box/entities/runner.entity'
import {
  BOX_STATES_BILLING_DISK_ONLY,
  BOX_STATES_WITHOUT_OPEN_PERIOD,
  BOX_STATES_WITH_OPEN_PERIOD,
  UsagePeriodShape,
  expectedOpenPeriod,
  sameShape,
} from './expected-usage-period'

/** How many drifted boxes one reconcile pass repairs per runner shard. */
const RECONCILE_BATCH_SIZE = 100

// A box that changed hands moments ago may still be waiting for its event
// handler to acquire the renewable per-box lease or finish its ledger write.
// Reconciling immediately would create avoidable contention and could select
// stale input, although the shared lease remains the correctness boundary. Two
// minutes absorbs normal scheduling and database delay before the repair pass
// treats the mismatch as drift.
const RECONCILE_GRACE_MS = 2 * 60 * 1000

let driftCounter: Counter | undefined

const getDriftCounter = (): Counter => {
  if (!driftCounter) {
    driftCounter = metrics.getMeter('').createCounter('usage_period_drift_repaired', {
      description: 'Open usage periods brought back in step with the box they bill for',
    })
  }
  return driftCounter
}

/** What one drifted box looks like, joined against its open period (if any). */
interface DriftCandidate {
  box_id: string
  box_state: BoxState
  box_cpu: number
  box_gpu: number
  box_mem: number
  box_disk: number
  box_org: string
  box_region: string
  period_id: string | null
}

@Injectable()
export class UsageService implements TrackableJobExecutions, OnApplicationShutdown {
  activeJobs = new Set<string>()
  private readonly logger = new Logger(UsageService.name)
  private readonly shutdownController = new AbortController()

  constructor(
    @InjectRepository(BoxUsagePeriod)
    private boxUsagePeriodRepository: Repository<BoxUsagePeriod>,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly boxRepository: BoxRepository,
    private readonly usageExportOutboxService: UsageExportOutboxService,
    @InjectRepository(Runner)
    private readonly runnerRepository: Repository<Runner>,
  ) {}

  async onApplicationShutdown() {
    this.shutdownController.abort(new Error('UsageService is shutting down'))
    //  wait for all active jobs to finish
    while (this.activeJobs.size > 0) {
      this.logger.log(`Waiting for ${this.activeJobs.size} active jobs to finish`)
      await sleep(1000)
    }
  }

  @OnEvent(BoxEvents.DESIRED_STATE_UPDATED)
  @TrackJobExecution()
  async handleBoxDesiredStateUpdate(event: BoxDesiredStateUpdatedEvent) {
    const lease = await this.waitForLock(event.box.id)

    await this.withLease(lease, async (signal) => {
      signal.throwIfAborted()
      switch (event.newDesiredState) {
        case BoxDesiredState.DESTROYED: {
          await this.closeUsagePeriod(event.box.id)
          break
        }
      }
    }, `box ${event.box.id}`)
  }

  @OnEvent(BoxEvents.STATE_UPDATED)
  @TrackJobExecution()
  async handleBoxStateUpdate(event: BoxStateUpdatedEvent) {
    const lease = await this.waitForLock(event.box.id)

    await this.withLease(lease, async (signal) => {
      signal.throwIfAborted()
      switch (event.newState) {
        case BoxState.STARTED: {
          await this.closeUsagePeriod(event.box.id)
          signal.throwIfAborted()
          await this.openUsagePeriodFor(event.box, event.newState)
          break
        }
        // Billing stops charging compute the moment a stop is requested.
        case BoxState.STOPPING:
          await this.closeUsagePeriod(event.box.id)
          signal.throwIfAborted()
          await this.openUsagePeriodFor(event.box, event.newState)
          break
        // Safeguards if STOPPING state is skipped
        case BoxState.STOPPED: {
          const cpuUsagePeriod = await this.boxUsagePeriodRepository.findOne({
            where: {
              boxId: event.box.id,
              endAt: IsNull(),
              cpu: Not(0),
            },
          })
          signal.throwIfAborted()
          if (cpuUsagePeriod) {
            await this.closeUsagePeriod(event.box.id)
            signal.throwIfAborted()
            await this.openUsagePeriodFor(event.box, event.newState)
          }
          break
        }
        case BoxState.ERROR:
        case BoxState.ARCHIVED:
        case BoxState.DESTROYING:
        case BoxState.DESTROYED: {
          await this.closeUsagePeriod(event.box.id)
          break
        }
      }
    }, `box ${event.box.id}`)
  }

  /**
   * Opens the period the box's current state calls for. A box that bills nothing
   * (terminal) or whose state is still in flight gets none — the caller has
   * already closed whatever was open.
   */
  private async openUsagePeriodFor(box: Box, state: BoxState) {
    // The event's newState is the authority on where the box landed; the entity
    // it carries is a snapshot, and a synthetic transition may have been built
    // with a state of its own (see the warm-pool claim in box.service.ts).
    const expected = expectedOpenPeriod({ ...box, state })
    if (expected === null) {
      return
    }
    await this.createUsagePeriod(box, expected)
  }

  private async createUsagePeriod(
    box: Pick<Box, 'id' | 'organizationId' | 'region'>,
    shape: UsagePeriodShape,
    entityManager?: EntityManager,
  ) {
    const usagePeriod = new BoxUsagePeriod()
    usagePeriod.boxId = box.id
    usagePeriod.startAt = new Date()
    usagePeriod.endAt = null
    usagePeriod.cpu = shape.cpu
    usagePeriod.gpu = shape.gpu
    usagePeriod.mem = shape.mem
    usagePeriod.disk = shape.disk
    usagePeriod.organizationId = box.organizationId
    usagePeriod.region = box.region

    await (entityManager ? entityManager.save(usagePeriod) : this.boxUsagePeriodRepository.save(usagePeriod))
  }

  private async closeUsagePeriod(boxId: string) {
    const lastUsagePeriod = await this.boxUsagePeriodRepository.findOne({
      where: {
        boxId,
        endAt: IsNull(),
      },
    })

    if (lastUsagePeriod) {
      lastUsagePeriod.endAt = new Date()
      await this.boxUsagePeriodRepository.save(lastUsagePeriod)
    }
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'close-and-reopen-usage-periods' })
  @TrackJobExecution()
  @LogExecution('close-and-reopen-usage-periods')
  @WithInstrumentation()
  async closeAndReopenUsagePeriods() {
    const lockKey = 'close-and-reopen-usage-periods'
    const lease = await this.redisLockProvider.acquireLease(lockKey, 60)
    if (!lease) {
      return
    }

    await this.withLease(lease, async (signal) => {
      const usagePeriods = await this.boxUsagePeriodRepository.find({
        where: {
          endAt: IsNull(),
          // 1 day ago
          startAt: LessThan(new Date(Date.now() - 1000 * 60 * 60 * 24)),
          organizationId: Not(BOX_WARM_POOL_UNASSIGNED_ORGANIZATION),
        },
        order: {
          startAt: 'ASC',
        },
        take: 100,
      })

      for (const usagePeriod of usagePeriods) {
        signal.throwIfAborted()
        const boxLease = await this.acquireLease(usagePeriod.boxId)
        if (!boxLease) {
          continue
        }

        // validate that the usage period should remain active just in case
        await this.withLease(boxLease, async (boxSignal) => {
          const box = await this.boxRepository.findOne({
            where: {
              id: usagePeriod.boxId,
            },
          })

          await this.boxUsagePeriodRepository.manager.transaction(async (transactionalEntityManager) => {
            boxSignal.throwIfAborted()
            // Close usage period
            const closeTime = new Date()
            usagePeriod.endAt = closeTime
            await transactionalEntityManager.save(usagePeriod)

            // Roll over with the resources the box calls for *now*, not the ones
            // the closing period happened to carry. Copying the old figures kept
            // any drift alive forever: a period left charging no cpu for a running
            // box was re-copied every day, and a disk resize that landed while the
            // box was stopped never reached the ledger at all. A box that is gone
            // or terminal yields no shape and so is not reopened, which is what
            // stops a deleted box from accruing.
            const expected = expectedOpenPeriod(box)
            if (expected !== null) {
              const newUsagePeriod = BoxUsagePeriod.fromUsagePeriod(usagePeriod)
              newUsagePeriod.startAt = closeTime
              newUsagePeriod.endAt = null
              newUsagePeriod.cpu = expected.cpu
              newUsagePeriod.gpu = expected.gpu
              newUsagePeriod.mem = expected.mem
              newUsagePeriod.disk = expected.disk
              await transactionalEntityManager.save(newUsagePeriod)
            }
            boxSignal.throwIfAborted()
          })
        }, `usage period ${usagePeriod.boxId}`).catch((error) => {
          this.logger.error(`Error closing and reopening usage period ${usagePeriod.boxId}`, error)
        })
      }
    }, lockKey)
  }

  /**
   * Brings open periods back in step with the boxes they bill for.
   *
   * The ledger is maintained by in-process events, which are fire-and-forget: a
   * handler that dies, throws, or loses its process leaves the box and its period
   * disagreeing, and nothing notices. The roll-over cannot: it scans the period
   * table, so a box with no period at all is invisible to it, and its one-day
   * cutoff lets a wrong period bill for a further day.
   *
   * This pass scans from the *box* side instead, which is why both are needed —
   * their blind spots are opposite. The roll-over is the only place that can see
   * a period whose box row was deleted outright; this one is the only place that
   * can see a box that never got a period.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'reconcile-usage-periods' })
  @TrackJobExecution()
  @LogExecution('reconcile-usage-periods')
  @WithInstrumentation()
  async reconcileUsagePeriods() {
    const lockKey = 'reconcile-usage-periods'
    const lease = await this.redisLockProvider.acquireLease(lockKey, 300)
    if (!lease) {
      return
    }

    await this.withLease(lease, async (signal) => {
      signal.throwIfAborted()
      const graceCutoff = new Date(Date.now() - RECONCILE_GRACE_MS)
      // Shard by runner so each scan rides a runnerId index rather than reading
      // the box table end to end. Measured on 20k boxes across 50 runners, the
      // planner takes box_runnerid_idx (bitmap index scan, ~400 rows rechecked,
      // ~1.7ms) — runnerId is selective enough on its own that it prefers that
      // over the composite box_runner_state_desired_idx.
      //
      // Every runner is scanned, not just the ready ones: a box stranded on an
      // unhealthy runner is the likeliest to have missed its event. The trailing
      // null shard is not optional — a box that
      // reached DESTROYED or ARCHIVED has had its runnerId cleared, and those are
      // exactly the boxes whose periods must be closed.
      const runners = await this.runnerRepository.find({ select: { id: true } })
      signal.throwIfAborted()
      const shards: (string | null)[] = [...runners.map((runner) => runner.id), null]

      for (const shard of shards) {
        signal.throwIfAborted()
        const candidates = await this.findDriftCandidates(shard, graceCutoff)
        signal.throwIfAborted()
        for (const candidate of candidates) {
          signal.throwIfAborted()
          await this.repairDrift(candidate)
          signal.throwIfAborted()
        }
      }
    }, lockKey)
  }

  /**
   * Boxes whose open period disagrees with them, in one left join.
   *
   * The resource comparison has to be qualified by state. A bare `p.cpu <> b.cpu`
   * is permanently true for every stopped box — a stopped period *should* charge
   * no cpu — and those false positives would fill each page and starve the real
   * drift out of the batch forever.
   */
  private findDriftCandidates(runnerId: string | null, graceCutoff: Date): Promise<DriftCandidate[]> {
    return (
      this.boxRepository
        .createQueryBuilder('b')
        .leftJoin(BoxUsagePeriod, 'p', 'p."boxId" = b.id AND p."endAt" IS NULL')
        .select([
          'b.id AS box_id',
          'b.state AS box_state',
          'b.cpu AS box_cpu',
          'b.gpu AS box_gpu',
          'b.mem AS box_mem',
          'b.disk AS box_disk',
          'b."organizationId" AS box_org',
          'b.region AS box_region',
          'p.id AS period_id',
        ])
        .where(runnerId === null ? 'b."runnerId" IS NULL' : 'b."runnerId" = :runnerId', { runnerId })
        // Written as equality to match the partial indexes' own `WHERE "pending"
        // = false`, so the planner may pick one where the data makes it
        // worthwhile. A null pending predates the column default; both spellings
        // exclude it.
        .andWhere('b.pending = false')
        .andWhere('b."updatedAt" < :graceCutoff', { graceCutoff })
        .andWhere('b.state IN (:...trackedStates)', {
          trackedStates: [...BOX_STATES_WITH_OPEN_PERIOD, ...BOX_STATES_WITHOUT_OPEN_PERIOD],
        })
        .andWhere(
          `(
           (b.state IN (:...withStates) AND (
                p.id IS NULL
             OR p.disk <> b.disk
             -- the ledger stores organizationId as text, the box table as uuid
             OR p."organizationId" <> b."organizationId"::text
             OR p.region <> b.region
             OR (b.state = :started AND (p.cpu <> b.cpu OR p.mem <> b.mem OR p.gpu <> b.gpu))
             OR (b.state IN (:...diskOnlyStates) AND (p.cpu <> 0 OR p.mem <> 0 OR p.gpu <> 0))
           ))
        OR (b.state IN (:...withoutStates) AND p.id IS NOT NULL)
        )`,
          {
            withStates: BOX_STATES_WITH_OPEN_PERIOD,
            withoutStates: BOX_STATES_WITHOUT_OPEN_PERIOD,
            diskOnlyStates: BOX_STATES_BILLING_DISK_ONLY,
            started: BoxState.STARTED,
          },
        )
        .orderBy('b."updatedAt"', 'ASC')
        .limit(RECONCILE_BATCH_SIZE)
        .getRawMany<DriftCandidate>()
    )
  }

  /**
   * Re-derives the period from the box and writes only if it still disagrees.
   *
   * The SQL above is a wide filter; the authority on what a period should charge
   * is {@link expectedOpenPeriod}, re-applied here under the per-box lock so a
   * candidate the event handler fixed in the meantime is left alone. Corrections
   * start now and are never backdated: the window a box spent mis-billed cannot
   * be reconstructed (its updatedAt has moved on for unrelated reasons), and
   * guessing it would replace a known gap with an invented charge.
   */
  private async repairDrift(candidate: DriftCandidate): Promise<void> {
    const lease = await this.acquireLease(candidate.box_id)
    if (!lease) {
      return
    }

    await this.withLease(lease, async (signal) => {
      signal.throwIfAborted()
      const box = await this.boxRepository.findOne({ where: { id: candidate.box_id } })
      signal.throwIfAborted()
      const expected = expectedOpenPeriod(box)

      const open = await this.boxUsagePeriodRepository.findOne({
        where: { boxId: candidate.box_id, endAt: IsNull() },
      })
      signal.throwIfAborted()

      if (expected === null) {
        if (!open) {
          return
        }
        await this.closeUsagePeriod(candidate.box_id)
        signal.throwIfAborted()
        this.recordDrift('orphan', candidate.box_id)
        return
      }

      if (
        open &&
        sameShape(open, expected) &&
        open.organizationId === box.organizationId &&
        open.region === box.region
      ) {
        return
      }

      await this.boxUsagePeriodRepository.manager.transaction(async (transactionalEntityManager) => {
        signal.throwIfAborted()
        if (open) {
          open.endAt = new Date()
          await transactionalEntityManager.save(open)
        }
        signal.throwIfAborted()
        await this.createUsagePeriod(box, expected, transactionalEntityManager)
        signal.throwIfAborted()
      })
      signal.throwIfAborted()
      this.recordDrift(open ? 'stale_shape' : 'missing', candidate.box_id)
    }, `usage period ${candidate.box_id}`).catch((error) => {
      this.logger.error(`Error reconciling usage period for box ${candidate.box_id}`, error)
    })
  }

  private recordDrift(kind: 'missing' | 'orphan' | 'stale_shape', boxId: string): void {
    getDriftCounter().add(1, { kind })
    this.logger.warn(`Repaired ${kind} usage period drift for box ${boxId}`)
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'archive-usage-periods' })
  @TrackJobExecution()
  @LogExecution('archive-usage-periods')
  @WithInstrumentation()
  async archiveUsagePeriods() {
    const lockKey = 'archive-usage-periods'
    const lease = await this.redisLockProvider.acquireLease(lockKey, 60)
    if (!lease) {
      return
    }

    await this.withLease(lease, async (signal) => {
      await this.boxUsagePeriodRepository.manager.transaction(async (transactionalEntityManager) => {
        signal.throwIfAborted()
        const usagePeriods = await transactionalEntityManager.find(BoxUsagePeriod, {
          where: {
            endAt: Not(IsNull()),
          },
          order: {
            startAt: 'ASC',
          },
          take: 1000,
        })

        if (usagePeriods.length === 0) {
          return
        }

        this.logger.debug(`Found ${usagePeriods.length} usage periods to archive`)

        await transactionalEntityManager.delete(
          BoxUsagePeriod,
          usagePeriods.map((usagePeriod) => usagePeriod.id),
        )
        await transactionalEntityManager.save(usagePeriods.map(BoxUsagePeriodArchive.fromUsagePeriod))
        // Same transaction as the archive write, so a usage period can never be
        // archived without an export intent, nor an intent survive a rollback.
        await this.usageExportOutboxService.enqueue(transactionalEntityManager, usagePeriods)
        signal.throwIfAborted()
      })
    }, lockKey)
  }

  private async waitForLock(boxId: string): Promise<RedisLockLease> {
    // Box state events are not durable or replayed, so a normal-operation
    // deadline would permanently drop a billing transition. Only shutdown
    // cancels the wait; acquired leases still stop on ownership loss.
    return this.redisLockProvider.waitForLease(`usage-period-${boxId}`, 60, this.shutdownController.signal)
  }

  private async acquireLease(boxId: string): Promise<RedisLockLease | null> {
    return this.redisLockProvider.acquireLease(`usage-period-${boxId}`, 60)
  }

  private withLease<T>(lease: RedisLockLease, operation: (signal: AbortSignal) => Promise<T>, context: string) {
    return withRedisLockLease(lease, operation, (releaseError) => {
      this.logger.error(`Error releasing Redis lock lease after ${context} operation failed`, releaseError)
    })
  }
}
