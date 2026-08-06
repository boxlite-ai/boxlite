/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { EntityManager, IsNull, LessThan, Not, QueryFailedError, Repository } from 'typeorm'
import { metrics } from '@opentelemetry/api'
import { BoxUsagePeriod } from '../entities/box-usage-period.entity'
import { OnEvent } from '@nestjs/event-emitter'
import { BoxStateUpdatedEvent } from '../../box/events/box-state-updated.event'
import { BoxDesiredStateUpdatedEvent } from '../../box/events/box-desired-state-updated.event'
import { BoxState } from '../../box/enums/box-state.enum'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BoxEvents } from './../../box/constants/box-events.constants'
import { Cron, CronExpression } from '@nestjs/schedule'
import { RedisLockProvider } from '../../box/common/redis-lock.provider'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../../box/constants/box.constants'
import { BoxUsagePeriodArchive } from '../entities/box-usage-period-archive.entity'
import { TrackableJobExecutions } from '../../common/interfaces/trackable-job-executions'
import { TrackJobExecution } from '../../common/decorators/track-job-execution.decorator'
import { setTimeout as sleep } from 'timers/promises'
import { LogExecution } from '../../common/decorators/log-execution.decorator'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'
import { BoxRepository } from '../../box/repositories/box.repository'
import { Box } from '../../box/entities/box.entity'
import { Runner } from '../../box/entities/runner.entity'
import {
  BOX_STATES_BILLING_DISK_ONLY,
  BOX_STATES_WITHOUT_OPEN_PERIOD,
  BOX_STATES_WITH_OPEN_PERIOD,
  RESOURCE_EPSILON,
  UsagePeriodShape,
  expectedOpenPeriod,
  sameShape,
} from './expected-usage-period'

const RECONCILE_BATCH_SIZE = 100
// State-event handlers may wait for the same 60-second per-box lock. Two lock
// TTLs avoids racing a legitimate handler that has not reached the ledger yet.
const RECONCILE_GRACE_MS = 2 * 60 * 1000

const getDriftCounter = () =>
  metrics.getMeter('').createCounter('usage_period_drift_repaired', {
    description: 'Open usage periods brought back in step with their boxes',
  })

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

class DivergentUsageArchiveError extends Error {}

@Injectable()
export class UsageService implements TrackableJobExecutions, OnApplicationShutdown {
  activeJobs = new Set<string>()
  private readonly logger = new Logger(UsageService.name)

  constructor(
    @InjectRepository(BoxUsagePeriod)
    private boxUsagePeriodRepository: Repository<BoxUsagePeriod>,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly boxRepository: BoxRepository,
    @InjectRepository(Runner)
    private readonly runnerRepository: Repository<Runner>,
  ) {}

  async onApplicationShutdown() {
    //  wait for all active jobs to finish
    while (this.activeJobs.size > 0) {
      this.logger.log(`Waiting for ${this.activeJobs.size} active jobs to finish`)
      await sleep(1000)
    }
  }

  @OnEvent(BoxEvents.DESIRED_STATE_UPDATED)
  @TrackJobExecution()
  async handleBoxDesiredStateUpdate(event: BoxDesiredStateUpdatedEvent) {
    await this.waitForLock(event.box.id)

    try {
      switch (event.newDesiredState) {
        case BoxDesiredState.DESTROYED: {
          await this.closeUsagePeriod(event.box.id)
          break
        }
      }
    } finally {
      this.releaseLock(event.box.id).catch((error) => {
        this.logger.error(`Error releasing lock for box ${event.box.id}`, error)
      })
    }
  }

  @OnEvent(BoxEvents.STATE_UPDATED)
  @TrackJobExecution()
  async handleBoxStateUpdate(event: BoxStateUpdatedEvent) {
    await this.waitForLock(event.box.id)

    try {
      switch (event.newState) {
        case BoxState.STARTED: {
          await this.closeUsagePeriod(event.box.id)
          await this.openUsagePeriodFor(event.box, event.newState)
          break
        }
        // Billing stops charging compute the moment a stop is requested, while
        // quota keeps counting it (BOX_STATES_CONSUMING_COMPUTE includes
        // STOPPING) because the runner has not released cpu/memory yet. The two
        // answer different questions; do not "reconcile" them without a pricing
        // decision.
        case BoxState.STOPPING:
          await this.closeUsagePeriod(event.box.id)
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
          if (cpuUsagePeriod) {
            await this.closeUsagePeriod(event.box.id)
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
    } finally {
      this.releaseLock(event.box.id).catch((error) => {
        this.logger.error(`Error releasing lock for box ${event.box.id}`, error)
      })
    }
  }

  private async openUsagePeriodFor(box: Box, state: BoxState) {
    const expected = expectedOpenPeriod({ ...box, state })
    if (expected !== null) {
      await this.createUsagePeriod(box, expected)
    }
  }

  private async createUsagePeriod(
    box: Pick<Box, 'id' | 'organizationId' | 'region'>,
    shape: UsagePeriodShape,
    entityManager?: EntityManager,
    startAt = new Date(),
  ) {
    const usagePeriod = new BoxUsagePeriod()
    usagePeriod.boxId = box.id
    usagePeriod.startAt = startAt
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
    if (!(await this.redisLockProvider.lock(lockKey, 60))) {
      return
    }

    try {
      const usagePeriods = await this.boxUsagePeriodRepository.find({
        where: {
          endAt: IsNull(),
          startAt: LessThan(new Date(Date.now() - 1000 * 60 * 60 * 24)),
          organizationId: Not(BOX_WARM_POOL_UNASSIGNED_ORGANIZATION),
        },
        order: {
          startAt: 'ASC',
        },
        take: 100,
      })

      for (const usagePeriod of usagePeriods) {
        if (!(await this.aquireLock(usagePeriod.boxId))) {
          continue
        }

        try {
          const box = await this.boxRepository.findOne({ where: { id: usagePeriod.boxId } })

          await this.boxUsagePeriodRepository.manager.transaction(async (transactionalEntityManager) => {
            const closeTime = new Date()
            usagePeriod.endAt = closeTime
            await transactionalEntityManager.save(usagePeriod)

            const expected =
              box?.organizationId === BOX_WARM_POOL_UNASSIGNED_ORGANIZATION ? null : expectedOpenPeriod(box)
            if (box && expected !== null) {
              await this.createUsagePeriod(box, expected, transactionalEntityManager, closeTime)
            }
          })
        } catch (error) {
          this.logger.error(`Error closing and reopening usage period ${usagePeriod.boxId}`, error)
        } finally {
          await this.releaseLock(usagePeriod.boxId)
        }
      }
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }

  /**
   * Repairs usage drift left by a dropped or failed in-process state event.
   * This anti-join starts from boxes, so it can find a billable box for which
   * no usage period was ever opened.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'reconcile-usage-periods' })
  @TrackJobExecution()
  @LogExecution('reconcile-usage-periods')
  @WithInstrumentation()
  async reconcileUsagePeriods() {
    const lockKey = 'reconcile-usage-periods'
    if (!(await this.redisLockProvider.lock(lockKey, 300))) {
      return
    }

    try {
      const graceCutoff = new Date(Date.now() - RECONCILE_GRACE_MS)
      // Runner shards keep each indexed scan bounded. The null shard is needed
      // after runner assignment is cleared from stopped and terminal boxes.
      const runners = await this.runnerRepository.find({ select: { id: true } })
      const shards: (string | null)[] = [...runners.map((runner) => runner.id), null]

      for (const shard of shards) {
        const candidates = await this.findDriftCandidates(shard, graceCutoff)
        for (const candidate of candidates) {
          await this.repairDrift(candidate)
        }
      }
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }

  /** Finds stable boxes whose expected open period is missing or disagrees. */
  private findDriftCandidates(runnerId: string | null, graceCutoff: Date): Promise<DriftCandidate[]> {
    return this.boxRepository
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
      .andWhere('b.pending = false')
      .andWhere('(b."billingChangedAt" IS NULL OR b."billingChangedAt" < :graceCutoff)', { graceCutoff })
      .andWhere('b."organizationId" <> :warmPoolOrg', {
        warmPoolOrg: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
      })
      .andWhere('b.state IN (:...trackedStates)', {
        trackedStates: [...BOX_STATES_WITH_OPEN_PERIOD, ...BOX_STATES_WITHOUT_OPEN_PERIOD],
      })
      .andWhere(
        `(
          (b.state IN (:...withStates) AND (
               p.id IS NULL
            OR ABS(p.disk - b.disk) >= :resourceEpsilon
            OR p."organizationId" <> b."organizationId"::text
            OR p.region <> b.region
            OR (b.state = :started AND (
                 ABS(p.cpu - b.cpu) >= :resourceEpsilon
              OR ABS(p.mem - b.mem) >= :resourceEpsilon
              OR ABS(p.gpu - b.gpu) >= :resourceEpsilon
            ))
            OR (b.state IN (:...diskOnlyStates) AND (
                 ABS(p.cpu) >= :resourceEpsilon
              OR ABS(p.mem) >= :resourceEpsilon
              OR ABS(p.gpu) >= :resourceEpsilon
            ))
          ))
          OR (b.state IN (:...withoutStates) AND p.id IS NOT NULL)
        )`,
        {
          withStates: BOX_STATES_WITH_OPEN_PERIOD,
          withoutStates: BOX_STATES_WITHOUT_OPEN_PERIOD,
          diskOnlyStates: BOX_STATES_BILLING_DISK_ONLY,
          started: BoxState.STARTED,
          resourceEpsilon: RESOURCE_EPSILON,
        },
      )
      .orderBy('b."billingChangedAt"', 'ASC', 'NULLS FIRST')
      .limit(RECONCILE_BATCH_SIZE)
      .getRawMany<DriftCandidate>()
  }

  /** Re-checks and repairs one candidate while holding its event-handler lock. */
  private async repairDrift(candidate: DriftCandidate): Promise<void> {
    if (!(await this.aquireLock(candidate.box_id))) {
      return
    }

    try {
      const box = await this.boxRepository.findOne({ where: { id: candidate.box_id } })
      if (box?.organizationId === BOX_WARM_POOL_UNASSIGNED_ORGANIZATION) {
        return
      }

      // The box can move after the scan. Transitional or pending states stay
      // with their event handler instead of racing a second period into place.
      if (
        box &&
        (box.pending !== false ||
          ![...BOX_STATES_WITH_OPEN_PERIOD, ...BOX_STATES_WITHOUT_OPEN_PERIOD].includes(box.state))
      ) {
        return
      }

      const expected = expectedOpenPeriod(box)
      const open = await this.boxUsagePeriodRepository.findOne({
        where: { boxId: candidate.box_id, endAt: IsNull() },
      })
      const observedAt = new Date()
      const cutoverAt = this.repairCutoverAt(box?.billingChangedAt, open?.startAt, observedAt)

      if (expected === null) {
        if (!open) {
          return
        }
        await this.boxUsagePeriodRepository.manager.transaction(async (transactionalEntityManager) => {
          open.endAt = cutoverAt
          await transactionalEntityManager.save(open)
        })
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
        if (open) {
          open.endAt = cutoverAt
          await transactionalEntityManager.save(open)
        }
        await this.createUsagePeriod(box, expected, transactionalEntityManager, cutoverAt)
      })
      this.recordDrift(open ? 'stale_shape' : 'missing', candidate.box_id)
    } catch (error) {
      this.logger.error(`Error reconciling usage period for box ${candidate.box_id}`, error)
    } finally {
      await this.releaseLock(candidate.box_id)
    }
  }

  /**
   * Chooses the tightest durable boundary available after an event was lost.
   *
   * A database trigger advances Box.billingChangedAt in the same statement
   * that changes a billing-relevant state, resource, or attribution field.
   * Unrelated box writes cannot move this boundary and silently erase usage.
   * Clamp it to what this repair actually observed and to the current period's
   * start so clock skew or a later rollover can never create a negative period.
   */
  private repairCutoverAt(
    billingChangedAt: Date | null | undefined,
    priorPeriodStartAt: Date | undefined,
    observedAt: Date,
  ) {
    const observedAtMs = observedAt.getTime()
    const billingChangedAtMs = billingChangedAt?.getTime()
    const durableBoundaryMs =
      billingChangedAtMs !== undefined && Number.isFinite(billingChangedAtMs)
        ? Math.min(billingChangedAtMs, observedAtMs)
        : observedAtMs
    const priorPeriodStartAtMs = priorPeriodStartAt?.getTime()

    return new Date(
      priorPeriodStartAtMs !== undefined && Number.isFinite(priorPeriodStartAtMs)
        ? Math.max(durableBoundaryMs, priorPeriodStartAtMs)
        : durableBoundaryMs,
    )
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
    if (!(await this.redisLockProvider.lock(lockKey, 60))) {
      return
    }

    try {
      const usagePeriods = await this.boxUsagePeriodRepository.find({
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
      const failures: string[] = []

      // One transaction per source row is intentional. A corrupt row or a
      // divergent retry rolls back only its own transaction; later billable
      // rows still leave the hot ledger in this same cycle.
      for (const usagePeriod of usagePeriods) {
        try {
          await this.archiveUsagePeriod(usagePeriod.id)
        } catch (error) {
          if (!this.isIsolatableArchiveError(error)) {
            throw error
          }
          failures.push(usagePeriod.id)
          this.logger.error(
            `Failed to archive usage period ${usagePeriod.id}: ${error instanceof Error ? error.message : 'unknown error'}`,
          )
        }
      }

      if (failures.length > 0) {
        throw new Error(`Failed to archive ${failures.length} usage period(s): ${failures.join(', ')}`)
      }
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }

  private async archiveUsagePeriod(sourceUsagePeriodId: string): Promise<void> {
    await this.boxUsagePeriodRepository.manager.transaction(async (transactionalEntityManager) => {
      const usagePeriod = await transactionalEntityManager.findOne(BoxUsagePeriod, {
        where: {
          id: sourceUsagePeriodId,
          endAt: Not(IsNull()),
        },
        lock: { mode: 'pessimistic_write' },
      })
      if (!usagePeriod || !usagePeriod.endAt) {
        return
      }

      await transactionalEntityManager
        .createQueryBuilder()
        .insert()
        .into(BoxUsagePeriodArchive)
        .values(BoxUsagePeriodArchive.fromUsagePeriod(usagePeriod))
        .orIgnore()
        .execute()

      const archived = await transactionalEntityManager.findOne(BoxUsagePeriodArchive, {
        where: { sourceUsagePeriodId: usagePeriod.id },
        lock: { mode: 'pessimistic_write' },
      })
      if (!archived) {
        throw new Error('archive insert did not produce a row for the source UUID')
      }
      if (!this.archiveMatchesSource(archived, usagePeriod)) {
        throw new DivergentUsageArchiveError('source UUID already belongs to a different archived snapshot')
      }

      // Delete only after the durable archive has been read back and all
      // billable fields exactly match. This makes a retry safe without turning
      // a UUID collision or source mutation into silent usage loss.
      await transactionalEntityManager.delete(BoxUsagePeriod, usagePeriod.id)
    })
  }

  private archiveMatchesSource(archive: BoxUsagePeriodArchive, source: BoxUsagePeriod): boolean {
    const sameNumber = (left: number, right: number) => left === right || (Number.isNaN(left) && Number.isNaN(right))
    return (
      archive.sourceUsagePeriodId === source.id &&
      archive.boxId === source.boxId &&
      archive.organizationId === source.organizationId &&
      archive.region === source.region &&
      archive.startAt.getTime() === source.startAt.getTime() &&
      source.endAt !== null &&
      archive.endAt.getTime() === source.endAt.getTime() &&
      sameNumber(archive.cpu, source.cpu) &&
      sameNumber(archive.gpu, source.gpu) &&
      sameNumber(archive.mem, source.mem) &&
      sameNumber(archive.disk, source.disk)
    )
  }

  private isIsolatableArchiveError(error: unknown): boolean {
    if (error instanceof DivergentUsageArchiveError) {
      return true
    }
    // A NOT VALID CHECK still protects every new archive row. A legacy source
    // row that violates it is poison data local to that row; connection,
    // timeout, and serialization failures are infrastructure errors and must
    // abort the cycle instead of launching hundreds of doomed transactions.
    return error instanceof QueryFailedError && (error.driverError as { code?: string } | undefined)?.code === '23514'
  }

  private async waitForLock(boxId: string) {
    while (!(await this.aquireLock(boxId))) {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  private async aquireLock(boxId: string): Promise<boolean> {
    return await this.redisLockProvider.lock(`usage-period-${boxId}`, 60)
  }

  private async releaseLock(boxId: string) {
    await this.redisLockProvider.unlock(`usage-period-${boxId}`)
  }
}
