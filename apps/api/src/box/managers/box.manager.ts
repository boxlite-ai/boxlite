/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectRepository } from '@nestjs/typeorm'
import { MoreThan, Repository } from 'typeorm'
import { randomUUID } from 'crypto'

import { BoxConflictError } from '../errors/box-conflict.error'
import { JobConflictError } from '../errors/job-conflict.error'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { RunnerService } from '../services/runner.service'

import { RedisLockProvider, LockCode } from '../common/redis-lock.provider'

import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../constants/box.constants'

import { BoxEvents } from '../constants/box-events.constants'
import { BoxStoppedEvent } from '../events/box-stopped.event'
import { BoxStartedEvent } from '../events/box-started.event'
import { BoxDestroyedEvent } from '../events/box-destroyed.event'
import { BoxCreatedEvent } from '../events/box-create.event'

import { WithInstrumentation, WithSpan } from '../../common/decorators/otel.decorator'

import { BoxStartAction } from './box-actions/box-start.action'
import { BoxStopAction } from './box-actions/box-stop.action'
import { BoxDestroyAction } from './box-actions/box-destroy.action'
import { SYNC_AGAIN, DONT_SYNC_AGAIN } from './box-actions/box.action'

import { TrackJobExecution } from '../../common/decorators/track-job-execution.decorator'
import { TrackableJobExecutions } from '../../common/interfaces/trackable-job-executions'
import { setTimeout } from 'timers/promises'
import { LogExecution } from '../../common/decorators/log-execution.decorator'
import { BoxRepository } from '../repositories/box.repository'
import { getStateChangeLockKey } from '../utils/lock-key.util'
import { OnAsyncEvent } from '../../common/decorators/on-async-event.decorator'
import { sanitizeBoxError } from '../utils/sanitize-error.util'
import { Box } from '../entities/box.entity'
import { Job } from '../entities/job.entity'
import { JobType } from '../enums/job-type.enum'
import { JobStatus } from '../enums/job-status.enum'
import { ResourceType } from '../enums/resource-type.enum'

//  Auto-recovery bounds for the reconcile-errored loop.
const MAX_RECOVER_ATTEMPTS = 5
const MAX_RECONCILE_PER_RUN = 200
//  Only reconcile boxes whose last change has settled for this long.
const RECONCILE_MIN_AGE_MS = 60_000
//  Window over which prior failed recovery attempts are counted against a box.
//  Bounds auto-recovery within a burst while letting a long-quiet box be retried again later.
const RECONCILE_FAILURE_WINDOW_MS = 60 * 60 * 1000

@Injectable()
export class BoxManager implements TrackableJobExecutions, OnApplicationShutdown {
  activeJobs = new Set<string>()

  private readonly logger = new Logger(BoxManager.name)

  constructor(
    private readonly boxRepository: BoxRepository,
    private readonly runnerService: RunnerService,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly boxStartAction: BoxStartAction,
    private readonly boxStopAction: BoxStopAction,
    private readonly boxDestroyAction: BoxDestroyAction,
    @InjectRepository(Job)
    private readonly jobRepository: Repository<Job>,
  ) {}

  async onApplicationShutdown() {
    //  wait for all active jobs to finish
    while (this.activeJobs.size > 0) {
      this.logger.log(`Waiting for ${this.activeJobs.size} active jobs to finish`)
      await setTimeout(1000)
    }
  }

  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'auto-stop-check' })
  @TrackJobExecution()
  @WithInstrumentation()
  @LogExecution('auto-stop-check')
  @WithInstrumentation()
  async autostopCheck(): Promise<void> {
    const lockKey = 'auto-stop-check-worker-selected'
    //  lock the sync to only run one instance at a time
    if (!(await this.redisLockProvider.lock(lockKey, 60))) {
      return
    }

    try {
      const readyRunners = await this.runnerService.findAllReady()

      // Process all runners in parallel
      await Promise.all(
        readyRunners.map(async (runner) => {
          const boxes = await this.boxRepository
            .createQueryBuilder('box')
            .innerJoin('box_last_activity', 'activity', 'activity."boxId" = box.id')
            .where('box."runnerId" = :runnerId', { runnerId: runner.id })
            .andWhere('box."organizationId" != :warmPoolOrg', {
              warmPoolOrg: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
            })
            .andWhere('box.state = :state', { state: BoxState.STARTED })
            .andWhere('box."desiredState" = :desiredState', {
              desiredState: BoxDesiredState.STARTED,
            })
            .andWhere('box.pending != true')
            .andWhere('box."autoStopInterval" != 0')
            .andWhere('activity."lastActivityAt" < NOW() - INTERVAL \'1 minute\' * box."autoStopInterval"')
            .limit(100)
            .getMany()

          await Promise.all(
            boxes.map(async (box) => {
              const lockKey = getStateChangeLockKey(box.id)
              const acquired = await this.redisLockProvider.lock(lockKey, 30)
              if (!acquired) {
                return
              }

              let updateData: Partial<Box> = {}

              //  if auto-delete interval is 0, delete the box immediately
              if (box.autoDeleteInterval === 0) {
                updateData = Box.getSoftDeleteUpdate(box)
              } else {
                updateData.pending = true
                updateData.desiredState = BoxDesiredState.STOPPED
              }

              this.logger.log(
                `Auto-stopping box ${box.id}: autoStopInterval=${box.autoStopInterval}min, autoDeleteInterval=${box.autoDeleteInterval}`,
              )

              try {
                await this.boxRepository.updateWhere(box.id, {
                  updateData,
                  whereCondition: { pending: false, state: box.state },
                })

                this.syncInstanceState(box.id).catch(this.logger.error)
              } catch (error) {
                this.logger.error(`Error processing auto-stop state for box ${box.id}:`, error)
              } finally {
                await this.redisLockProvider.unlock(lockKey)
              }
            }),
          )
        }),
      )
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }

  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'auto-delete-check' })
  @TrackJobExecution()
  @LogExecution('auto-delete-check')
  @WithInstrumentation()
  async autoDeleteCheck(): Promise<void> {
    const lockKey = 'auto-delete-check-worker-selected'
    //  lock the sync to only run one instance at a time
    if (!(await this.redisLockProvider.lock(lockKey, 60))) {
      return
    }

    try {
      const readyRunners = await this.runnerService.findAllReady()

      // Process all runners in parallel
      await Promise.all(
        readyRunners.map(async (runner) => {
          const boxes = await this.boxRepository
            .createQueryBuilder('box')
            .innerJoin('box_last_activity', 'activity', 'activity."boxId" = box.id')
            .where('box."runnerId" = :runnerId', { runnerId: runner.id })
            .andWhere('box."organizationId" != :warmPoolOrg', {
              warmPoolOrg: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
            })
            .andWhere('box.state = :state', { state: BoxState.STOPPED })
            .andWhere('box."desiredState" = :desiredState', {
              desiredState: BoxDesiredState.STOPPED,
            })
            .andWhere('box.pending != true')
            .andWhere('box."autoDeleteInterval" >= 0')
            .andWhere('activity."lastActivityAt" < NOW() - INTERVAL \'1 minute\' * box."autoDeleteInterval"')
            .orderBy('activity."lastActivityAt"', 'ASC')
            .limit(100)
            .getMany()

          await Promise.all(
            boxes.map(async (box) => {
              const lockKey = getStateChangeLockKey(box.id)
              const acquired = await this.redisLockProvider.lock(lockKey, 30)
              if (!acquired) {
                return
              }

              this.logger.log(`Auto-deleting box ${box.id}: autoDeleteInterval=${box.autoDeleteInterval}min`)

              try {
                const updateData = Box.getSoftDeleteUpdate(box)
                await this.boxRepository.updateWhere(box.id, {
                  updateData,
                  whereCondition: { pending: false, state: box.state },
                })

                this.syncInstanceState(box.id).catch(this.logger.error)
              } catch (error) {
                this.logger.error(`Error processing auto-delete state for box ${box.id}:`, error)
              } finally {
                await this.redisLockProvider.unlock(lockKey)
              }
            }),
          )
        }),
      )
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }

  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'sync-states' })
  @TrackJobExecution()
  @WithInstrumentation()
  @LogExecution('sync-states')
  async syncStates(): Promise<void> {
    const globalLockKey = 'sync-states'
    const lockTtl = 10 * 60 // seconds (10 min)
    if (!(await this.redisLockProvider.lock(globalLockKey, lockTtl))) {
      return
    }

    try {
      const queryBuilder = this.boxRepository
        .createQueryBuilder('box')
        .select(['box.id'])
        .leftJoin('box_last_activity', 'activity', 'activity."boxId" = box.id')
        .where('box.state NOT IN (:...excludedStates)', {
          excludedStates: [BoxState.DESTROYED, BoxState.ERROR, BoxState.RESIZING],
        })
        .andWhere('box."desiredState"::text != box.state::text')
        .andWhere('box."desiredState"::text IN (:...supportedDesiredStates)', {
          supportedDesiredStates: [BoxDesiredState.STARTED, BoxDesiredState.STOPPED, BoxDesiredState.DESTROYED],
        })
        .orderBy('activity."lastActivityAt"', 'DESC', 'NULLS LAST')

      const stream = await queryBuilder.stream()
      let processedCount = 0
      const maxProcessPerRun = 1000
      const pendingProcesses: Promise<void>[] = []

      try {
        await new Promise<void>((resolve, reject) => {
          stream.on('data', async (row: any) => {
            if (processedCount >= maxProcessPerRun) {
              resolve()
              return
            }

            const lockKey = getStateChangeLockKey(row.box_id)
            if (await this.redisLockProvider.isLocked(lockKey)) {
              // Box is already being processed, skip it
              return
            }

            // Process box asynchronously but track the promise
            const processPromise = this.syncInstanceState(row.box_id).catch((err) => {
              this.logger.error(`Error syncing box state for ${row.box_id}`, err)
            })
            pendingProcesses.push(processPromise)
            processedCount++

            // Limit concurrent processing to avoid overwhelming the system
            if (pendingProcesses.length >= 10) {
              stream.pause()
              Promise.allSettled(pendingProcesses.splice(0, pendingProcesses.length))
                .then(() => stream.resume())
                .catch(reject)
            }
          })

          stream.on('end', () => {
            Promise.allSettled(pendingProcesses)
              .then(() => {
                resolve()
              })
              .catch(reject)
          })

          stream.on('error', reject)
        })
      } finally {
        if (!stream.destroyed) {
          stream.destroy()
        }
      }
    } finally {
      await this.redisLockProvider.unlock(globalLockKey)
    }
  }

  /**
   * Reconcile boxes that are stuck in ERROR but want to be STARTED.
   *
   * v2 runners report state only through job outcomes; a transient runner failure
   * (saturation, timeout, a CREATE job that failed late while the box actually exists)
   * sediments into a terminal ERROR that the regular sync loop deliberately skips, even
   * though the box is healthy on the runner. This drives such boxes back toward their
   * desired state by transitioning ERROR -> STOPPED, which lets the normal start flow
   * issue an idempotent START_BOX (not a non-idempotent CREATE_BOX) on the existing box.
   *
   * Eligibility is deliberately NOT gated on the box.recoverable flag: that flag is set true
   * only for storage-expansion errors (the runner's sole recoverable pattern), whereas the
   * split-brain errors this loop targets — "box already exists" from a late-failing CREATE,
   * job timeouts — are reported recoverable=false. The safety net is not that pre-filter but
   * the idempotent START_BOX plus the bounded retry below: a box that truly cannot start fails
   * START_BOX up to MAX_RECOVER_ATTEMPTS times and is then left alone, while a box that is
   * actually alive on the runner is recovered on the first retry.
   *
   * Recovery is bounded by counting recent failed START_BOX jobs for the box so a genuinely
   * dead box is not retried forever; the count is derived from the job table, not stored state.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'reconcile-errored' })
  @TrackJobExecution()
  @WithInstrumentation()
  @LogExecution('reconcile-errored')
  async reconcileErroredBoxes(): Promise<void> {
    const globalLockKey = 'reconcile-errored'
    const lockTtl = 5 * 60 // seconds
    if (!(await this.redisLockProvider.lock(globalLockKey, lockTtl))) {
      return
    }

    try {
      // Only retry boxes whose last change has settled, to avoid racing an in-flight
      // failure and to space out successive recovery attempts.
      const settledBefore = new Date(Date.now() - RECONCILE_MIN_AGE_MS)

      const candidates = await this.boxRepository
        .createQueryBuilder('box')
        .select(['box.id', 'box.runnerId'])
        .where('box.state = :state', { state: BoxState.ERROR })
        .andWhere('box.pending = false')
        .andWhere('box."desiredState"::text = :desired', { desired: BoxDesiredState.STARTED })
        .andWhere('box."updatedAt" < :settledBefore', { settledBefore })
        .orderBy('box."updatedAt"', 'ASC')
        .limit(MAX_RECONCILE_PER_RUN)
        .getMany()

      const failureWindowStart = new Date(Date.now() - RECONCILE_FAILURE_WINDOW_MS)

      for (const candidate of candidates) {
        if (!candidate.runnerId) {
          continue
        }

        // Scope to v2 runners: this is where the job-driven model produces the
        // ERROR/runner split-brain. v1 runners are reconciled by their own paths.
        if ((await this.runnerService.getRunnerApiVersion(candidate.runnerId)) !== '2') {
          continue
        }

        // Bound auto-recovery: each reconcile drives a START_BOX, so the number of recent
        // failed START_BOX jobs for this box equals how many times we have already retried.
        const recentFailures = await this.jobRepository.count({
          where: {
            resourceType: ResourceType.BOX,
            resourceId: candidate.id,
            type: JobType.START_BOX,
            status: JobStatus.FAILED,
            createdAt: MoreThan(failureWindowStart),
          },
        })
        if (recentFailures >= MAX_RECOVER_ATTEMPTS) {
          continue
        }

        // Skip boxes the sync loop is already touching.
        const lockKey = getStateChangeLockKey(candidate.id)
        if (await this.redisLockProvider.isLocked(lockKey)) {
          continue
        }

        try {
          // Atomic ERROR -> STOPPED transition; the conditional whereCondition ensures
          // only one transition wins and we never clobber a concurrent state change.
          await this.boxRepository.updateWhere(candidate.id, {
            updateData: {
              state: BoxState.STOPPED,
              errorReason: null,
              recoverable: false,
            },
            whereCondition: {
              state: BoxState.ERROR,
              pending: false,
              desiredState: BoxDesiredState.STARTED,
              runnerId: candidate.runnerId,
            },
          })
          this.logger.warn(
            `Reconcile: box ${candidate.id} ERROR -> STOPPED (attempt ${recentFailures + 1}/${MAX_RECOVER_ATTEMPTS}), letting start flow re-drive it`,
          )
        } catch (error) {
          if (error instanceof BoxConflictError) {
            // Box changed under us (e.g. recovered or destroyed); nothing to do.
            continue
          }
          this.logger.error(`Reconcile: failed to transition box ${candidate.id} out of ERROR`, error)
        }
      }
    } finally {
      await this.redisLockProvider.unlock(globalLockKey)
    }
  }

  /**
   * Sync the state of a box.
   *
   * Loop to handle SYNC_AGAIN without releasing the lock or re-fetching.
   * The box entity is mutated in-place by repository.update() on each iteration,
   * and the lock guarantees no concurrent modification.
   */
  async syncInstanceState(boxId: string, force?: boolean): Promise<void> {
    // Track the start time of the sync operation.
    const startedAt = new Date()

    // Generate a random lock code to prevent race condition if box action continues after the lock expires.
    const lockCode = new LockCode(randomUUID())

    // Prevent syncState cron from running multiple instances of the same box.
    const lockKey = getStateChangeLockKey(boxId)
    const acquired = await this.redisLockProvider.lock(lockKey, 30, lockCode)
    if (!acquired) {
      return
    }

    try {
      const box = await this.boxRepository.findOneOrFail({
        where: { id: boxId },
      })

      while (new Date().getTime() - startedAt.getTime() <= 10000) {
        if ([BoxState.DESTROYED, BoxState.RESIZING].includes(box.state) || box.state === BoxState.ERROR) {
          // Break sync loop if box reaches a terminal state.
          break
        }

        if (String(box.state) === String(box.desiredState)) {
          this.logger.warn(`Box ${boxId} is already in the desired state ${box.desiredState}, skipping sync`)
          // Break sync loop if box is already in the desired state.
          break
        }

        // Rely on the box action to return SYNC_AGAIN or DONT_SYNC_AGAIN to continue/break the sync loop.
        let syncState = DONT_SYNC_AGAIN

        try {
          switch (box.desiredState) {
            case BoxDesiredState.STARTED: {
              syncState = await this.boxStartAction.run(box, lockCode)
              break
            }
            case BoxDesiredState.STOPPED: {
              syncState = await this.boxStopAction.run(box, lockCode, force)
              break
            }
            case BoxDesiredState.DESTROYED: {
              syncState = await this.boxDestroyAction.run(box, lockCode)
              break
            }
          }
        } catch (error) {
          if (error instanceof BoxConflictError) {
            this.logger.warn(`Box ${boxId} was modified by another operation during sync, skipping error transition`)
            break
          }

          if (error instanceof JobConflictError) {
            this.logger.debug(`Job already in progress for box ${boxId}, skipping`)
            break
          }

          this.logger.error(`Error processing desired state for box ${boxId}:`, error)

          const { recoverable, errorReason } = sanitizeBoxError(error)

          // A START_BOX attempt can throw before runnerAdapter.startBox() ever
          // persists its START_BOX job (e.g. a synchronous runner lookup or
          // adapter-creation failure). The reconcile retry ceiling counts FAILED
          // START_BOX jobs, so without a record here it would keep flipping this
          // box out of ERROR indefinitely. Record a terminal FAILED START_BOX job
          // so the ceiling counts this attempt — best-effort, never blocking the
          // ERROR transition. completedAt is set so the row stays outside the
          // "one incomplete job per box" partial-unique index.
          if (box.desiredState === BoxDesiredState.STARTED && box.runnerId) {
            try {
              await this.jobRepository.insert(
                new Job({
                  type: JobType.START_BOX,
                  runnerId: box.runnerId,
                  resourceType: ResourceType.BOX,
                  resourceId: boxId,
                  status: JobStatus.FAILED,
                  errorMessage: errorReason ?? null,
                  completedAt: new Date(),
                }),
              )
            } catch (jobError) {
              this.logger.error(
                `Failed to record FAILED START_BOX job for box ${boxId}; retry ceiling may undercount`,
                jobError,
              )
            }
          }

          const updateData: Partial<Box> = {
            state: BoxState.ERROR,
            errorReason,
            recoverable,
          }

          // Update box to error state without safeguards
          await this.boxRepository.updateWhere(boxId, { updateData, whereCondition: {} })

          // Break sync loop since box is in error state.
          break
        }

        // Do not sync again for v2 runners
        // Job completion will update the box state
        if (box.runnerId && (await this.runnerService.getRunnerApiVersion(box.runnerId)) === '2') {
          break
        }

        // Break sync loop if box action returned DONT_SYNC_AGAIN.
        if (syncState !== SYNC_AGAIN) {
          break
        }
      }
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }

  @OnAsyncEvent({
    event: BoxEvents.DESTROYED,
  })
  @TrackJobExecution()
  @WithSpan()
  private async handleBoxDestroyedEvent(event: BoxDestroyedEvent) {
    await this.syncInstanceState(event.box.id)
  }

  @OnAsyncEvent({
    event: BoxEvents.STARTED,
  })
  @TrackJobExecution()
  @WithSpan()
  private async handleBoxStartedEvent(event: BoxStartedEvent) {
    await this.syncInstanceState(event.box.id)
  }

  @OnAsyncEvent({
    event: BoxEvents.STOPPED,
  })
  @TrackJobExecution()
  @WithSpan()
  private async handleBoxStoppedEvent(event: BoxStoppedEvent) {
    await this.syncInstanceState(event.box.id, event.force)
  }

  @OnAsyncEvent({
    event: BoxEvents.CREATED,
  })
  @TrackJobExecution()
  @WithSpan()
  private async handleBoxCreatedEvent(event: BoxCreatedEvent) {
    await this.syncInstanceState(event.box.id)
  }
}
