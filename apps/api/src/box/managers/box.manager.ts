/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { In, IsNull, Not } from 'typeorm'
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
import { BoxArchivedEvent } from '../events/box-archived.event'
import { BoxDestroyedEvent } from '../events/box-destroyed.event'
import { BoxCreatedEvent } from '../events/box-create.event'

import { WithInstrumentation, WithSpan } from '../../common/decorators/otel.decorator'

import { BoxStartAction } from './box-actions/box-start.action'
import { BoxStopAction } from './box-actions/box-stop.action'
import { BoxDestroyAction } from './box-actions/box-destroy.action'
import { BoxArchiveAction } from './box-actions/box-archive.action'
import { SYNC_AGAIN, DONT_SYNC_AGAIN } from './box-actions/box.action'

import { TrackJobExecution } from '../../common/decorators/track-job-execution.decorator'
import { TrackableJobExecutions } from '../../common/interfaces/trackable-job-executions'
import { setTimeout } from 'timers/promises'
import { LogExecution } from '../../common/decorators/log-execution.decorator'
import { BoxRepository } from '../repositories/box.repository'
import { getStateChangeLockKey } from '../utils/lock-key.util'
import { BackupState } from '../enums/backup-state.enum'
import { OnAsyncEvent } from '../../common/decorators/on-async-event.decorator'
import { sanitizeBoxError } from '../utils/sanitize-error.util'
import { Box } from '../entities/box.entity'
import { RunnerAdapterFactory } from '../runner-adapter/runnerAdapter'
import { DockerRegistryService } from '../../docker-registry/services/docker-registry.service'
import { OrganizationService } from '../../organization/services/organization.service'
import { TypedConfigService } from '../../config/typed-config.service'
import { BackupManager } from './backup.manager'
import { InjectRedis } from '@nestjs-modules/ioredis'
import Redis from 'ioredis'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'

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
    private readonly boxArchiveAction: BoxArchiveAction,
    private readonly configService: TypedConfigService,
    private readonly dockerRegistryService: DockerRegistryService,
    private readonly organizationService: OrganizationService,
    private readonly runnerAdapterFactory: RunnerAdapterFactory,
    private readonly backupManager: BackupManager,
    @InjectRedis() private readonly redis: Redis,
    @InjectDataSource() private readonly dataSource: DataSource,
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
            .orderBy('box."lastBackupAt"', 'ASC')
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

  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'auto-archive-check' })
  @TrackJobExecution()
  @LogExecution('auto-archive-check')
  @WithInstrumentation()
  async autoArchiveCheck(): Promise<void> {
    const lockKey = 'auto-archive-check-worker-selected'
    //  lock the sync to only run one instance at a time
    if (!(await this.redisLockProvider.lock(lockKey, 60))) {
      return
    }

    try {
      const boxes = await this.boxRepository
        .createQueryBuilder('box')
        .innerJoin('box_last_activity', 'activity', 'activity."boxId" = box.id')
        .where('box."organizationId" != :warmPoolOrg', {
          warmPoolOrg: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
        })
        .andWhere('box.state = :state', { state: BoxState.STOPPED })
        .andWhere('box."desiredState" = :desiredState', {
          desiredState: BoxDesiredState.STOPPED,
        })
        .andWhere('box.pending != true')
        .andWhere('box."autoArchiveInterval" != 0')
        .andWhere('activity."lastActivityAt" < NOW() - INTERVAL \'1 minute\' * box."autoArchiveInterval"')
        .orderBy('box."lastBackupAt"', 'ASC')
        .limit(100)
        .getMany()

      await Promise.all(
        boxes.map(async (box) => {
          const lockKey = getStateChangeLockKey(box.id)
          const acquired = await this.redisLockProvider.lock(lockKey, 30)
          if (!acquired) {
            return
          }

          this.logger.log(`Auto-archiving box ${box.id}: autoArchiveInterval=${box.autoArchiveInterval}min`)

          try {
            const updateData: Partial<Box> = {
              desiredState: BoxDesiredState.ARCHIVED,
            }
            await this.boxRepository.updateWhere(box.id, {
              updateData,
              whereCondition: { pending: false, state: box.state },
            })

            this.syncInstanceState(box.id).catch(this.logger.error)
          } catch (error) {
            this.logger.error(`Error processing auto-archive state for box ${box.id}:`, error)
          } finally {
            await this.redisLockProvider.unlock(lockKey)
          }
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

  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'draining-runner-boxes-check' })
  @TrackJobExecution()
  @LogExecution('draining-runner-boxes-check')
  @WithInstrumentation()
  async drainingRunnerBoxesCheck(): Promise<void> {
    const lockKey = 'draining-runner-boxes-check'
    const lockTtl = 10 * 60 // seconds (10 min)
    if (!(await this.redisLockProvider.lock(lockKey, lockTtl))) {
      return
    }

    try {
      const skip = (await this.redis.get('draining-runner-boxes-skip')) || 0

      const drainingRunners = await this.runnerService.findDrainingPaginated(Number(skip), 10)

      this.logger.debug(`Checking ${drainingRunners.length} draining runners for box migration (offset: ${skip})`)

      if (drainingRunners.length === 0) {
        await this.redis.set('draining-runner-boxes-skip', 0)
        return
      }

      await this.redis.set('draining-runner-boxes-skip', Number(skip) + drainingRunners.length)

      await Promise.allSettled(
        drainingRunners.map(async (runner) => {
          try {
            const boxes = await this.boxRepository.find({
              where: {
                runnerId: runner.id,
                state: BoxState.STOPPED,
                desiredState: BoxDesiredState.STOPPED,
                backupState: BackupState.COMPLETED,
                backupSnapshot: Not(IsNull()),
              },
              take: 100,
            })

            this.logger.debug(`Found ${boxes.length} eligible boxes on draining runner ${runner.id} for migration`)

            await Promise.allSettled(
              boxes.map(async (box) => {
                const boxLockKey = getStateChangeLockKey(box.id)
                const hasBoxLock = await this.redisLockProvider.lock(boxLockKey, 60)
                if (!hasBoxLock) {
                  return
                }

                try {
                  const startScoreThreshold = this.configService.get('runnerScore.thresholds.start') || 0
                  const targetRunner = await this.runnerService.getRandomAvailableRunner({
                    snapshotRef: box.backupSnapshot,
                    excludedRunnerIds: [runner.id],
                    availabilityScoreThreshold: startScoreThreshold,
                  })

                  await this.reassignBox(box, runner.id, targetRunner.id)
                } catch (e) {
                  this.logger.error(`Error migrating box ${box.id} from draining runner ${runner.id}`, e)
                } finally {
                  await this.redisLockProvider.unlock(boxLockKey)
                }
              }),
            )

            // Archive ERROR boxes that have completed backups on this draining runner
            await this.archiveErroredBoxesOnDrainingRunner(runner.id)

            // Recover recoverable ERROR boxes in-place (expand disk) so they become STOPPED
            await this.recoverRecoverableBoxesOnDrainingRunner(runner.id)

            // Retry backups for non-started boxes with errored backup state
            await this.retryErroredBackupsOnDrainingRunner(runner.id)
          } catch (e) {
            this.logger.error(`Error processing draining runner ${runner.id} for box migration`, e)
          }
        }),
      )
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }

  private async archiveErroredBoxesOnDrainingRunner(runnerId: string): Promise<void> {
    const erroredBoxes = await this.boxRepository.find({
      where: {
        runnerId,
        state: BoxState.ERROR,
        recoverable: false,
        desiredState: Not(In([BoxDesiredState.DESTROYED, BoxDesiredState.ARCHIVED])),
        backupState: BackupState.COMPLETED,
        backupSnapshot: Not(IsNull()),
      },
      take: 100,
    })

    if (erroredBoxes.length === 0) {
      return
    }

    this.logger.debug(
      `Found ${erroredBoxes.length} errored boxes with completed backups on draining runner ${runnerId}`,
    )

    await Promise.allSettled(
      erroredBoxes.map(async (box) => {
        const boxLockKey = getStateChangeLockKey(box.id)
        const acquired = await this.redisLockProvider.lock(boxLockKey, 30)
        if (!acquired) {
          return
        }

        try {
          this.logger.warn(
            `Setting desired state to ARCHIVED for errored box ${box.id} on draining runner ${runnerId} (previous desired state: ${box.desiredState})`,
          )
          const updateData: Partial<Box> = {
            desiredState: BoxDesiredState.ARCHIVED,
          }
          await this.boxRepository.updateWhere(box.id, {
            updateData,
            whereCondition: { state: BoxState.ERROR },
          })
        } catch (e) {
          this.logger.error(
            `Failed to set desired state to ARCHIVED for errored box ${box.id} on draining runner ${runnerId}`,
            e,
          )
        } finally {
          await this.redisLockProvider.unlock(boxLockKey)
        }
      }),
    )
  }

  private static readonly DRAINING_BACKUP_RETRY_TTL_SECONDS = 12 * 60 * 60 // 12 hours
  private static readonly DRAINING_RECOVER_TTL_SECONDS = 12 * 60 * 60 // 12 hours

  private async retryErroredBackupsOnDrainingRunner(runnerId: string): Promise<void> {
    const erroredBoxes = await this.boxRepository.find({
      where: [
        {
          runnerId,
          state: BoxState.STOPPED,
          recoverable: false,
          desiredState: BoxDesiredState.STOPPED,
          backupState: BackupState.ERROR,
        },
        {
          runnerId,
          state: BoxState.ERROR,
          recoverable: false,
          backupState: In([BackupState.ERROR, BackupState.NONE]),
          desiredState: Not(BoxDesiredState.DESTROYED),
        },
      ],
      take: 100,
    })

    if (erroredBoxes.length === 0) {
      return
    }

    this.logger.debug(`Found ${erroredBoxes.length} boxes with errored backups on draining runner ${runnerId}`)

    await Promise.allSettled(
      erroredBoxes.map(async (box) => {
        const redisKey = `draining:backup-retry:${box.id}`

        // Check if we've already retried within the last 12 hours
        const alreadyRetried = await this.redis.exists(redisKey)
        if (alreadyRetried) {
          this.logger.debug(
            `Skipping backup retry for box ${box.id} on draining runner ${runnerId} — already retried within 12 hours`,
          )
          return
        }

        try {
          await this.backupManager.setBackupPending(box)
          await this.redis.set(redisKey, '1', 'EX', BoxManager.DRAINING_BACKUP_RETRY_TTL_SECONDS)
          this.logger.log(`Retried backup for box ${box.id} on draining runner ${runnerId}`)
        } catch (e) {
          this.logger.error(`Failed to retry backup for box ${box.id} on draining runner ${runnerId}`, e)
        }
      }),
    )
  }

  private async recoverRecoverableBoxesOnDrainingRunner(runnerId: string): Promise<void> {
    const recoverableBoxes = await this.boxRepository.find({
      where: {
        runnerId,
        recoverable: true,
        desiredState: Not(In([BoxDesiredState.DESTROYED])),
        backupSnapshot: Not(IsNull()),
      },
      take: 100,
    })

    if (recoverableBoxes.length === 0) {
      return
    }

    this.logger.debug(`Found ${recoverableBoxes.length} recoverable boxes on draining runner ${runnerId}`)

    const runner = await this.runnerService.findOneOrFail(runnerId)

    if (runner.apiVersion === '2') {
      this.logger.debug(`Skipping recovery for boxes on draining runner ${runnerId} — not supported for runner API v2`)
      return
    }

    const runnerAdapter = await this.runnerAdapterFactory.create(runner)

    await Promise.allSettled(
      recoverableBoxes.map(async (box) => {
        const redisKey = `draining:recover:${box.id}`

        // Check if we've already attempted recovery within the last 12 hours
        const alreadyAttempted = await this.redis.exists(redisKey)
        if (alreadyAttempted) {
          this.logger.debug(
            `Skipping recovery for box ${box.id} on draining runner ${runnerId} — already attempted within 12 hours`,
          )
          return
        }

        const boxLockKey = getStateChangeLockKey(box.id)
        const acquired = await this.redisLockProvider.lock(boxLockKey, 60)
        if (!acquired) {
          return
        }

        try {
          await runnerAdapter.recoverBox(box)

          const updateData: Partial<Box> = {
            state: BoxState.STOPPED,
            desiredState: BoxDesiredState.STOPPED,
            errorReason: null,
            recoverable: false,
            backupState: BackupState.NONE,
          }

          await this.boxRepository.updateWhere(box.id, {
            updateData,
            whereCondition: { pending: false, state: box.state },
          })

          this.logger.log(`Recovered box ${box.id} on draining runner ${runnerId}`)
        } catch (e) {
          await this.redis.set(redisKey, '1', 'EX', BoxManager.DRAINING_RECOVER_TTL_SECONDS)
          this.logger.error(`Failed to recover box ${box.id} on draining runner ${runnerId}`, e)
        } finally {
          await this.redisLockProvider.unlock(boxLockKey)
        }
      }),
    )
  }

  private async reassignBox(box: Box, oldRunnerId: string, newRunnerId: string): Promise<void> {
    this.logger.debug(`Starting box reassignment for ${box.id} from runner ${oldRunnerId} to runner ${newRunnerId}`)

    // Safety check: ensure box is not pending
    if (box.pending) {
      this.logger.warn(
        `Box ${box.id} is pending, skipping reassignment from runner ${oldRunnerId} to runner ${newRunnerId}`,
      )
      return
    }

    if (!box.backupRegistryId) {
      throw new Error(`Box ${box.id} has no backup registry`)
    }

    const registry = await this.dockerRegistryService.findOne(box.backupRegistryId)
    if (!registry) {
      throw new Error(`Registry ${box.backupRegistryId} not found for box ${box.id}`)
    }

    const organization = await this.organizationService.findOne(box.organizationId)

    const metadata = {
      ...organization?.boxMetadata,
      boxName: box.name,
    }

    const newRunner = await this.runnerService.findOneOrFail(newRunnerId)
    const newRunnerAdapter = await this.runnerAdapterFactory.create(newRunner)

    try {
      // Pass undefined for entrypoint as the backup snapshot already has it baked in and use skipStart
      await newRunnerAdapter.createBox(box, box.backupSnapshot, registry, undefined, metadata, undefined, true)
      this.logger.debug(`Created box ${box.id} on new runner ${newRunnerId} with skipStart`)
    } catch (e) {
      this.logger.error(`Failed to create box ${box.id} on new runner ${newRunnerId}`, e)
      throw e
    }

    // Re-fetch box from DB to get fresh state (the in-memory entity may be stale)
    const freshBox = await this.boxRepository.findOne({ where: { id: box.id } })
    if (!freshBox || freshBox.pending) {
      this.logger.warn(
        `Box ${box.id} is pending or missing, aborting reassignment from runner ${oldRunnerId} to runner ${newRunnerId}`,
      )

      // Roll back: remove the box from the new runner since we won't complete the migration
      try {
        await newRunnerAdapter.destroyBox(box.id)
        this.logger.debug(`Rolled back box ${box.id} creation on new runner ${newRunnerId}`)
      } catch (rollbackErr) {
        this.logger.error(
          `Failed to roll back box ${box.id} on new runner ${newRunnerId} after pending check`,
          rollbackErr,
        )
      }
      return
    }

    // Update the box to use the new runner; roll back on failure
    try {
      const updateData: Partial<Box> = {
        prevRunnerId: box.runnerId,
        runnerId: newRunnerId,
      }
      await this.boxRepository.update(
        box.id,
        {
          updateData,
        },
        true,
      )
    } catch (e) {
      this.logger.error(`Failed to update box ${box.id} runnerId to ${newRunnerId}, rolling back`, e)

      // Roll back: remove the box from the new runner
      try {
        await newRunnerAdapter.destroyBox(box.id)
        this.logger.debug(`Rolled back box ${box.id} creation on new runner ${newRunnerId}`)
      } catch (rollbackErr) {
        this.logger.error(
          `Failed to roll back box ${box.id} on new runner ${newRunnerId} after DB update failure`,
          rollbackErr,
        )
      }
      throw e
    }

    this.logger.log(`Migrated box ${box.id} from draining runner ${oldRunnerId} to runner ${newRunnerId}`)

    // Best effort deletion of the box on the old runner
    try {
      const oldRunner = await this.runnerService.findOne(oldRunnerId)
      if (oldRunner) {
        const oldRunnerAdapter = await this.runnerAdapterFactory.create(oldRunner)
        await oldRunnerAdapter.destroyBox(box.id)
        this.logger.debug(`Deleted box ${box.id} from old runner ${oldRunnerId}`)
      }
    } catch (e) {
      this.logger.warn(`Best effort deletion failed for box ${box.id} on old runner ${oldRunnerId}`, e)
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
          excludedStates: [BoxState.DESTROYED, BoxState.ERROR, BoxState.BUILD_FAILED, BoxState.RESIZING],
        })
        .andWhere('box."desiredState"::text != box.state::text')
        .andWhere('box."desiredState"::text != :archived', { archived: BoxDesiredState.ARCHIVED })
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

  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'sync-archived-desired-states' })
  @TrackJobExecution()
  @LogExecution('sync-archived-desired-states')
  @WithInstrumentation()
  async syncArchivedDesiredStates(): Promise<void> {
    const lockKey = 'sync-archived-desired-states'
    if (!(await this.redisLockProvider.lock(lockKey, 30))) {
      return
    }

    const boxes = await this.boxRepository.find({
      where: {
        state: In([BoxState.ARCHIVING, BoxState.STOPPED, BoxState.ERROR]),
        desiredState: BoxDesiredState.ARCHIVED,
      },
      take: 100,
      order: {
        updatedAt: 'ASC',
      },
    })

    await Promise.all(
      boxes.map(async (box) => {
        this.syncInstanceState(box.id)
      }),
    )
    await this.redisLockProvider.unlock(lockKey)
  }

  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'sync-archived-completed-states' })
  @TrackJobExecution()
  @LogExecution('sync-archived-completed-states')
  async syncArchivedCompletedStates(): Promise<void> {
    const lockKey = 'sync-archived-completed-states'
    if (!(await this.redisLockProvider.lock(lockKey, 30))) {
      return
    }

    const boxes = await this.boxRepository.find({
      where: {
        state: In([BoxState.ARCHIVING, BoxState.STOPPED, BoxState.ERROR]),
        desiredState: BoxDesiredState.ARCHIVED,
        backupState: BackupState.COMPLETED,
      },
      take: 100,
      order: {
        updatedAt: 'ASC',
      },
    })

    await Promise.allSettled(
      boxes.map(async (box) => {
        await this.syncInstanceState(box.id)
      }),
    )
    await this.redisLockProvider.unlock(lockKey)
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
        if (
          [BoxState.DESTROYED, BoxState.BUILD_FAILED, BoxState.RESIZING].includes(box.state) ||
          (box.state === BoxState.ERROR && box.desiredState !== BoxDesiredState.ARCHIVED)
        ) {
          // Break sync loop if box reaches a terminal state.
          // However, should allow ERROR → ARCHIVED transition (e.g., during runner draining).
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
            case BoxDesiredState.ARCHIVED: {
              syncState = await this.boxArchiveAction.run(box, lockCode)
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
    event: BoxEvents.ARCHIVED,
  })
  @TrackJobExecution()
  @WithSpan()
  private async handleBoxArchivedEvent(event: BoxArchivedEvent) {
    await this.syncInstanceState(event.box.id)
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
