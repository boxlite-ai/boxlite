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
import { BoxBillingTransition } from '../entities/box-billing-transition.entity'
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
  box_desired_state: BoxDesiredState
  box_cpu: number
  box_gpu: number
  box_mem: number
  box_disk: number
  box_org: string
  box_region: string
  period_id: string | null
}

interface PendingTransitionShard {
  runner_id: string | null
}

interface PendingTransitionBox {
  box_id: string
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
    @InjectRepository(BoxBillingTransition)
    private readonly billingTransitionRepository: Repository<BoxBillingTransition>,
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
      await this.processPendingBillingTransitionsForBox(event.box.id)
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
      await this.processPendingBillingTransitionsForBox(event.box.id)
    } finally {
      this.releaseLock(event.box.id).catch((error) => {
        this.logger.error(`Error releasing lock for box ${event.box.id}`, error)
      })
    }
  }

  private async createUsagePeriod(
    box: Pick<Box, 'id' | 'organizationId' | 'region'>,
    shape: UsagePeriodShape,
    entityManager?: EntityManager,
    startAt = new Date(),
  ): Promise<BoxUsagePeriod> {
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

    return await (entityManager ? entityManager.save(usagePeriod) : this.boxUsagePeriodRepository.save(usagePeriod))
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
          if ((await this.processPendingBillingTransitionsForBox(usagePeriod.boxId)) > 0) {
            continue
          }

          let pendingAfterBoxLock = false
          await this.boxUsagePeriodRepository.manager.transaction(async (transactionalEntityManager) => {
            // Lock Box before the open ledger row. Every lifecycle UPDATE must
            // take the same PostgreSQL row lock, so no new trigger boundary can
            // commit between this snapshot and the rollover write.
            const box = await this.lockBillingBox(transactionalEntityManager, usagePeriod.boxId)
            if (
              await transactionalEntityManager.exists(BoxBillingTransition, {
                where: { boxId: usagePeriod.boxId, processedAt: IsNull() },
              })
            ) {
              pendingAfterBoxLock = true
              return
            }

            const lockedUsagePeriod = await transactionalEntityManager.findOne(BoxUsagePeriod, {
              where: { id: usagePeriod.id, endAt: IsNull() },
              lock: { mode: 'pessimistic_write' },
            })
            if (!lockedUsagePeriod) {
              return
            }

            const expected =
              box?.organizationId === BOX_WARM_POOL_UNASSIGNED_ORGANIZATION ? null : expectedOpenPeriod(box)
            const observedAt = new Date()
            // Old pre-outbox state can still disagree with the ledger. Preserve
            // its durable last-change boundary instead of moving it to this
            // daily rollover's observation time.
            const shapeChanged =
              box &&
              (expected === null ||
                !sameShape(lockedUsagePeriod, expected) ||
                lockedUsagePeriod.organizationId !== box.organizationId ||
                lockedUsagePeriod.region !== box.region)
            const closeTime = shapeChanged
              ? this.repairCutoverAt(box.billingChangedAt, lockedUsagePeriod.startAt, observedAt)
              : observedAt

            lockedUsagePeriod.endAt = closeTime
            await transactionalEntityManager.save(lockedUsagePeriod)

            if (box && expected !== null) {
              await this.createUsagePeriod(box, expected, transactionalEntityManager, closeTime)
            }
          })

          if (pendingAfterBoxLock) {
            await this.processPendingBillingTransitionsForBox(usagePeriod.boxId)
          }
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

  private async lockBillingBox(entityManager: EntityManager, boxId: string): Promise<Box | null> {
    const rows = (await entityManager.query(
      `SELECT
         id,
         "organizationId",
         region,
         state,
         "desiredState",
         pending,
         cpu,
         gpu,
         mem,
         disk,
         "billingChangedAt"
       FROM "box"
       WHERE id = $1
       FOR UPDATE`,
      [boxId],
    )) as Box[]
    return rows[0] ?? null
  }

  /**
   * Applies every durable billing boundary for one box in insertion order.
   *
   * The trigger writes these snapshots in the same transaction as the Box
   * update. Applying the ledger changes and processedAt markers in this second
   * transaction makes retries safe: either both commit or neither does.
   */
  private async processPendingBillingTransitionsForBox(boxId: string): Promise<number> {
    const hasPendingTransition = await this.billingTransitionRepository.exists({
      where: { boxId, processedAt: IsNull() },
    })
    if (!hasPendingTransition) {
      return 0
    }

    return await this.boxUsagePeriodRepository.manager.transaction(async (transactionalEntityManager) => {
      const transitions = await transactionalEntityManager.find(BoxBillingTransition, {
        where: { boxId, processedAt: IsNull() },
        order: { id: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      })
      if (transitions.length === 0) {
        return 0
      }

      let open = await transactionalEntityManager.findOne(BoxUsagePeriod, {
        where: { boxId, endAt: IsNull() },
        lock: { mode: 'pessimistic_write' },
      })
      const processedAt = new Date()

      for (const transition of transitions) {
        const expected = this.expectedTransitionPeriod(transition)
        if (expected !== undefined) {
          const cutoverAt = this.repairCutoverAt(transition.occurredAt, open?.startAt, processedAt)

          if (expected === null) {
            if (open) {
              open.endAt = cutoverAt
              await transactionalEntityManager.save(open)
              open = null
            }
          } else if (
            !open ||
            !sameShape(open, expected) ||
            open.organizationId !== transition.organizationId ||
            open.region !== transition.region
          ) {
            if (open) {
              open.endAt = cutoverAt
              await transactionalEntityManager.save(open)
            }
            open = await this.createUsagePeriod(
              {
                id: transition.boxId,
                organizationId: transition.organizationId,
                region: transition.region,
              },
              expected,
              transactionalEntityManager,
              cutoverAt,
            )
          }
        }

        transition.processedAt = processedAt
      }

      await transactionalEntityManager.save(BoxBillingTransition, transitions)
      return transitions.length
    })
  }

  /** Undefined means the snapshot is transitional and must not alter billing. */
  private expectedTransitionPeriod(transition: BoxBillingTransition): UsagePeriodShape | null | undefined {
    if (
      transition.organizationId === BOX_WARM_POOL_UNASSIGNED_ORGANIZATION ||
      transition.desiredState === BoxDesiredState.DESTROYED
    ) {
      return null
    }

    if (transition.state === BoxState.STARTED) {
      return {
        cpu: transition.cpu,
        gpu: transition.gpu,
        mem: transition.mem,
        disk: transition.disk,
      }
    }
    if (BOX_STATES_BILLING_DISK_ONLY.includes(transition.state)) {
      return { cpu: 0, gpu: 0, mem: 0, disk: transition.disk }
    }
    if (BOX_STATES_WITHOUT_OPEN_PERIOD.includes(transition.state)) {
      return null
    }
    return undefined
  }

  /** Drains trigger-captured boundaries using the runner shard at capture time. */
  private async reconcilePendingBillingTransitions(): Promise<void> {
    const shards = await this.billingTransitionRepository
      .createQueryBuilder('transition')
      .select('transition."runnerId"', 'runner_id')
      .where('transition."processedAt" IS NULL')
      .groupBy('transition."runnerId"')
      .getRawMany<PendingTransitionShard>()

    for (const shard of shards) {
      const boxes = await this.billingTransitionRepository
        .createQueryBuilder('transition')
        .select('transition."boxId"', 'box_id')
        .addSelect('MIN(transition.id)', 'first_transition_id')
        .where('transition."processedAt" IS NULL')
        .andWhere(shard.runner_id === null ? 'transition."runnerId" IS NULL' : 'transition."runnerId" = :runnerId', {
          runnerId: shard.runner_id,
        })
        .groupBy('transition."boxId"')
        .orderBy('MIN(transition.id)', 'ASC')
        .limit(RECONCILE_BATCH_SIZE)
        .getRawMany<PendingTransitionBox>()

      for (const box of boxes) {
        if (!(await this.aquireLock(box.box_id))) {
          continue
        }

        try {
          await this.processPendingBillingTransitionsForBox(box.box_id)
        } catch (error) {
          this.logger.error(`Error applying billing transitions for box ${box.box_id}`, error)
        } finally {
          await this.releaseLock(box.box_id)
        }
      }
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
      await this.reconcilePendingBillingTransitions()

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
        'b."desiredState" AS box_desired_state',
        'b.cpu AS box_cpu',
        'b.gpu AS box_gpu',
        'b.mem AS box_mem',
        'b.disk AS box_disk',
        'b."organizationId" AS box_org',
        'b.region AS box_region',
        'p.id AS period_id',
      ])
      .where(runnerId === null ? 'b."runnerId" IS NULL' : 'b."runnerId" = :runnerId', { runnerId })
      .andWhere('(b.pending = false OR b."desiredState" = :destroyedDesired)', {
        destroyedDesired: BoxDesiredState.DESTROYED,
      })
      .andWhere('(b."billingChangedAt" IS NULL OR b."billingChangedAt" < :graceCutoff)', { graceCutoff })
      .andWhere(
        `NOT EXISTS (
        SELECT 1
          FROM "box_billing_transitions" transition
         WHERE transition."boxId" = b.id
           AND transition."processedAt" IS NULL
      )`,
      )
      .andWhere('b."organizationId" <> :warmPoolOrg', {
        warmPoolOrg: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
      })
      .andWhere('(b."desiredState" = :destroyedDesired OR b.state IN (:...trackedStates))', {
        destroyedDesired: BoxDesiredState.DESTROYED,
        trackedStates: [...BOX_STATES_WITH_OPEN_PERIOD, ...BOX_STATES_WITHOUT_OPEN_PERIOD],
      })
      .andWhere(
        `(
          (b."desiredState" <> :destroyedDesired AND b.state IN (:...withStates) AND (
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
          OR ((b."desiredState" = :destroyedDesired OR b.state IN (:...withoutStates)) AND p.id IS NOT NULL)
        )`,
        {
          destroyedDesired: BoxDesiredState.DESTROYED,
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
      if ((await this.processPendingBillingTransitionsForBox(candidate.box_id)) > 0) {
        return
      }

      let pendingAfterBoxLock = false
      let repairedKind: 'missing' | 'orphan' | 'stale_shape' | null = null
      await this.boxUsagePeriodRepository.manager.transaction(async (transactionalEntityManager) => {
        // Serialize the state snapshot, the final pending-outbox check, and
        // the ledger mutation with every lifecycle UPDATE. A transition that
        // commits before this lock is visible here; one that commits after it
        // necessarily runs after this ledger transaction and remains durable
        // for the outbox worker's next pass.
        const box = await this.lockBillingBox(transactionalEntityManager, candidate.box_id)
        if (
          await transactionalEntityManager.exists(BoxBillingTransition, {
            where: { boxId: candidate.box_id, processedAt: IsNull() },
          })
        ) {
          pendingAfterBoxLock = true
          return
        }

        if (box?.organizationId === BOX_WARM_POOL_UNASSIGNED_ORGANIZATION) {
          return
        }

        // The box can move after the initial scan. Transitional or pending
        // states stay with their event handler instead of racing a second
        // period into place. A pending destroy is billable as terminal now.
        if (
          box &&
          box.desiredState !== BoxDesiredState.DESTROYED &&
          (box.pending !== false ||
            ![...BOX_STATES_WITH_OPEN_PERIOD, ...BOX_STATES_WITHOUT_OPEN_PERIOD].includes(box.state))
        ) {
          return
        }

        const open = await transactionalEntityManager.findOne(BoxUsagePeriod, {
          where: { boxId: candidate.box_id, endAt: IsNull() },
          lock: { mode: 'pessimistic_write' },
        })
        const expected = expectedOpenPeriod(box)
        const observedAt = new Date()
        const cutoverAt = this.repairCutoverAt(box?.billingChangedAt, open?.startAt, observedAt)

        if (expected === null) {
          if (!open) {
            return
          }
          open.endAt = cutoverAt
          await transactionalEntityManager.save(open)
          repairedKind = 'orphan'
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

        if (open) {
          open.endAt = cutoverAt
          await transactionalEntityManager.save(open)
        }
        await this.createUsagePeriod(box, expected, transactionalEntityManager, cutoverAt)
        repairedKind = open ? 'stale_shape' : 'missing'
      })

      if (pendingAfterBoxLock) {
        await this.processPendingBillingTransitionsForBox(candidate.box_id)
      } else if (repairedKind !== null) {
        this.recordDrift(repairedKind, candidate.box_id)
      }
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
