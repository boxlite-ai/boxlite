/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { In, IsNull, LessThan, Not, Or } from 'typeorm'
import { Box } from '../entities/box.entity'
import { BoxState } from '../enums/box-state.enum'
import { RunnerService } from '../services/runner.service'
import { RunnerState } from '../enums/runner-state.enum'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { DockerRegistryService } from '../../docker-registry/services/docker-registry.service'
import { BackupState } from '../enums/backup-state.enum'
import { InjectRedis } from '@nestjs-modules/ioredis'
import { Redis } from 'ioredis'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../constants/box.constants'
import { fromAxiosError } from '../../common/utils/from-axios-error'
import { RedisLockProvider } from '../common/redis-lock.provider'
import { OnEvent } from '@nestjs/event-emitter'
import { BoxEvents } from '../constants/box-events.constants'
import { BoxDestroyedEvent } from '../events/box-destroyed.event'
import { BoxBackupCreatedEvent } from '../events/box-backup-created.event'
import { BoxArchivedEvent } from '../events/box-archived.event'
import { RunnerAdapterFactory } from '../runner-adapter/runnerAdapter'
import { TypedConfigService } from '../../config/typed-config.service'

import { TrackJobExecution } from '../../common/decorators/track-job-execution.decorator'
import { TrackableJobExecutions } from '../../common/interfaces/trackable-job-executions'
import { setTimeout } from 'timers/promises'
import { LogExecution } from '../../common/decorators/log-execution.decorator'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'
import { DockerRegistry } from '../../docker-registry/entities/docker-registry.entity'
import { BoxService } from '../services/box.service'
import { BoxRepository } from '../repositories/box.repository'

@Injectable()
export class BackupManager implements TrackableJobExecutions, OnApplicationShutdown {
  activeJobs = new Set<string>()

  private readonly logger = new Logger(BackupManager.name)

  constructor(
    private readonly boxRepository: BoxRepository,
    private readonly boxService: BoxService,
    private readonly runnerService: RunnerService,
    private readonly runnerAdapterFactory: RunnerAdapterFactory,
    private readonly dockerRegistryService: DockerRegistryService,
    @InjectRedis() private readonly redis: Redis,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly configService: TypedConfigService,
  ) {}

  //  on init
  async onApplicationBootstrap() {
    await this.adHocBackupCheck()
  }

  async onApplicationShutdown() {
    //  wait for all active jobs to finish
    while (this.activeJobs.size > 0) {
      this.logger.log(`Waiting for ${this.activeJobs.size} active jobs to finish`)
      await setTimeout(1000)
    }
  }

  //  todo: make frequency configurable or more efficient
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'ad-hoc-backup-check' })
  @TrackJobExecution()
  @LogExecution('ad-hoc-backup-check')
  @WithInstrumentation()
  async adHocBackupCheck(): Promise<void> {
    const lockKey = 'ad-hoc-backup-check'
    const hasLock = await this.redisLockProvider.lock(lockKey, 5 * 60)
    if (!hasLock) {
      return
    }

    // Get all ready runners
    const readyRunners = await this.runnerService.findAllReady()

    try {
      // Process all runners in parallel
      await Promise.all(
        readyRunners.map(async (runner) => {
          const boxes = await this.boxRepository.find({
            where: {
              runnerId: runner.id,
              organizationId: Not(BOX_WARM_POOL_UNASSIGNED_ORGANIZATION),
              state: BoxState.STARTED,
              backupState: In([BackupState.NONE, BackupState.COMPLETED]),
              lastBackupAt: Or(IsNull(), LessThan(new Date(Date.now() - 1 * 60 * 60 * 1000))),
              autoDeleteInterval: Not(0),
            },
            order: {
              lastBackupAt: 'ASC',
            },
            //  todo: increase this number when backup is stable
            take: 10,
          })

          await Promise.all(
            boxes.map(async (box) => {
              const lockKey = `box-backup-${box.id}`
              const hasLock = await this.redisLockProvider.lock(lockKey, 60)
              if (!hasLock) {
                return
              }

              try {
                //  todo: remove the catch handler asap
                await this.setBackupPending(box).catch((error) => {
                  if (error instanceof BadRequestError && error.message === 'A backup is already in progress') {
                    return
                  }
                  this.logger.error(`Failed to create backup for box ${box.id}:`, fromAxiosError(error))
                })
              } catch (error) {
                this.logger.error(`Error processing stop state for box ${box.id}:`, fromAxiosError(error))
              } finally {
                await this.redisLockProvider.unlock(lockKey)
              }
            }),
          )
        }),
      )
    } catch (error) {
      this.logger.error(`Error processing backups: `, error)
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }

  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'check-backup-states' })
  @TrackJobExecution()
  @LogExecution('check-backup-states')
  @WithInstrumentation()
  async checkBackupStates(): Promise<void> {
    //  lock the sync to only run one instance at a time
    const lockKey = 'check-backup-states'
    const hasLock = await this.redisLockProvider.lock(lockKey, 10)
    if (!hasLock) {
      return
    }

    try {
      const boxes = await this.boxRepository
        .createQueryBuilder('box')
        .innerJoin('runner', 'r', 'r.id = box.runnerId')
        .where('box.state IN (:...states)', {
          states: [BoxState.ARCHIVING, BoxState.STARTED, BoxState.STOPPED],
        })
        .andWhere('box.backupState IN (:...backupStates)', {
          backupStates: [BackupState.PENDING, BackupState.IN_PROGRESS],
        })
        .andWhere('r.state = :ready', { ready: RunnerState.READY })
        // Prioritize manual archival action, then auto-archive poller, then ad-hoc backup poller
        .addSelect(
          `
          CASE box.state
            WHEN :archiving THEN 1
            WHEN :stopped   THEN 2
            WHEN :started   THEN 3
            ELSE 999
          END
          `,
          'state_priority',
        )
        .setParameters({
          archiving: BoxState.ARCHIVING,
          stopped: BoxState.STOPPED,
          started: BoxState.STARTED,
        })
        .orderBy('state_priority', 'ASC')
        .addOrderBy('box.lastBackupAt', 'ASC', 'NULLS FIRST') // Process boxes with no backups first
        .addOrderBy('box.createdAt', 'ASC') // For equal lastBackupAt, process older boxes first
        .take(100)
        .getMany()

      await Promise.allSettled(
        boxes.map(async (s) => {
          const lockKey = `box-backup-${s.id}`
          const hasLock = await this.redisLockProvider.lock(lockKey, 60)
          if (!hasLock) {
            return
          }

          try {
            //  get the latest box state
            const box = await this.boxRepository.findOneByOrFail({
              id: s.id,
            })

            try {
              switch (box.backupState) {
                case BackupState.PENDING: {
                  await this.handlePendingBackup(box)
                  break
                }
                case BackupState.IN_PROGRESS: {
                  await this.checkBackupProgress(box)
                  break
                }
              }
            } catch (error) {
              //  if error, retry 10 times
              const errorRetryKey = `${lockKey}-error-retry`
              const errorRetryCount = await this.redis.get(errorRetryKey)
              if (!errorRetryCount) {
                await this.redis.setex(errorRetryKey, 300, '1')
              } else if (parseInt(errorRetryCount) > 10) {
                this.logger.error(`Error processing backup for box ${box.id}:`, fromAxiosError(error))
                await this.boxService.updateBoxBackupState(
                  box.id,
                  BackupState.ERROR,
                  undefined,
                  undefined,
                  fromAxiosError(error).message,
                )
              } else {
                await this.redis.setex(errorRetryKey, 300, errorRetryCount + 1)
              }
            }
          } catch (error) {
            this.logger.error(`Error processing backup for box ${s.id}:`, error)
          } finally {
            await this.redisLockProvider.unlock(lockKey)
          }
        }),
      )
    } catch (error) {
      this.logger.error(`Error processing backups: `, error)
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }

  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'check-backup-states-errored-draining' })
  @TrackJobExecution()
  @LogExecution('check-backup-states-errored-draining')
  @WithInstrumentation()
  async checkBackupStatesForErroredDraining(): Promise<void> {
    const lockKey = 'check-backup-states-errored-draining'
    const hasLock = await this.redisLockProvider.lock(lockKey, 10)
    if (!hasLock) {
      return
    }

    try {
      const boxes = await this.boxRepository
        .createQueryBuilder('box')
        .innerJoin('runner', 'r', 'r.id = box.runnerId')
        .where('box.state = :error', { error: BoxState.ERROR })
        .andWhere('box.backupState IN (:...backupStates)', {
          backupStates: [BackupState.PENDING, BackupState.IN_PROGRESS],
        })
        .andWhere('r.state = :ready', { ready: RunnerState.READY })
        .andWhere('r."draining" = true')
        .addOrderBy('box.lastBackupAt', 'ASC', 'NULLS FIRST')
        .addOrderBy('box.createdAt', 'ASC')
        .take(100)
        .getMany()

      await Promise.allSettled(
        boxes.map(async (s) => {
          const lockKey = `box-backup-${s.id}`
          const hasLock = await this.redisLockProvider.lock(lockKey, 60)
          if (!hasLock) {
            return
          }

          try {
            const box = await this.boxRepository.findOneByOrFail({
              id: s.id,
            })

            try {
              switch (box.backupState) {
                case BackupState.PENDING: {
                  await this.handlePendingBackup(box)
                  break
                }
                case BackupState.IN_PROGRESS: {
                  await this.checkBackupProgress(box)
                  break
                }
              }
            } catch (error) {
              const errorRetryKey = `${lockKey}-error-retry`
              const errorRetryCount = await this.redis.get(errorRetryKey)
              if (!errorRetryCount) {
                await this.redis.setex(errorRetryKey, 300, '1')
              } else if (parseInt(errorRetryCount) > 10) {
                this.logger.error(
                  `Error processing backup for errored box ${box.id} on draining runner:`,
                  fromAxiosError(error),
                )
                await this.boxService.updateBoxBackupState(
                  box.id,
                  BackupState.ERROR,
                  undefined,
                  undefined,
                  fromAxiosError(error).message,
                )
              } else {
                await this.redis.setex(errorRetryKey, 300, errorRetryCount + 1)
              }
            }
          } catch (error) {
            this.logger.error(`Error processing backup for errored box ${s.id} on draining runner:`, error)
          } finally {
            await this.redisLockProvider.unlock(lockKey)
          }
        }),
      )
    } catch (error) {
      this.logger.error(`Error processing backups for errored boxes on draining runners: `, error)
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }

  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'sync-stop-state-create-backups' })
  @TrackJobExecution()
  @LogExecution('sync-stop-state-create-backups')
  @WithInstrumentation()
  async syncStopStateCreateBackups(): Promise<void> {
    const lockKey = 'sync-stop-state-create-backups'
    const hasLock = await this.redisLockProvider.lock(lockKey, 10)
    if (!hasLock) {
      return
    }

    try {
      const boxes = await this.boxRepository
        .createQueryBuilder('box')
        .innerJoin('runner', 'r', 'r.id = box.runnerId')
        .where('box.state IN (:...states)', { states: [BoxState.ARCHIVING, BoxState.STOPPED] })
        .andWhere('box.backupState = :none', { none: BackupState.NONE })
        .andWhere('r.state = :ready', { ready: RunnerState.READY })
        .take(100)
        .getMany()

      await Promise.allSettled(
        boxes
          .filter((box) => box.runnerId !== null)
          .map(async (box) => {
            const lockKey = `box-backup-${box.id}`
            const hasLock = await this.redisLockProvider.lock(lockKey, 30)
            if (!hasLock) {
              return
            }

            try {
              await this.setBackupPending(box)
            } catch (error) {
              this.logger.error(`Error processing backup for box ${box.id}:`, error)
            } finally {
              await this.redisLockProvider.unlock(lockKey)
            }
          }),
      )
    } catch (error) {
      this.logger.error(`Error processing backups: `, error)
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }

  async setBackupPending(box: Box): Promise<void> {
    if (box.backupState === BackupState.COMPLETED) {
      return
    }

    // Allow backups for STARTED boxes, STOPPED/ERROR boxes with runnerId, or ARCHIVING boxes
    if (
      !(
        box.state === BoxState.STARTED ||
        box.state === BoxState.ARCHIVING ||
        (box.state === BoxState.STOPPED && box.runnerId) ||
        (box.state === BoxState.ERROR && box.runnerId)
      )
    ) {
      throw new BadRequestError('Box must be started, stopped, or errored with assigned runner to create a backup')
    }

    if (box.backupState === BackupState.IN_PROGRESS || box.backupState === BackupState.PENDING) {
      return
    }

    let registry: DockerRegistry | null = null

    if (box.backupRegistryId) {
      registry = await this.dockerRegistryService.findOne(box.backupRegistryId)
    } else {
      registry = await this.dockerRegistryService.getAvailableBackupRegistry(box.region)
    }

    if (!registry) {
      throw new BadRequestError('No backup registry configured')
    }
    // Generate backup snapshot name
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupSnapshot = `${registry.url.replace('https://', '').replace('http://', '')}/${registry.project || 'boxlite'}/backup-${box.id}:${timestamp}`

    await this.boxService.updateBoxBackupState(box.id, BackupState.PENDING, backupSnapshot, registry.id)
  }

  private async checkBackupProgress(box: Box): Promise<void> {
    try {
      const runner = await this.runnerService.findOneOrFail(box.runnerId)
      const runnerAdapter = await this.runnerAdapterFactory.create(runner)

      // Get box info from runner
      const boxInfo = await runnerAdapter.boxInfo(box.id)

      switch (boxInfo.backupState) {
        case BackupState.COMPLETED: {
          // Only accept completion if the runner-reported snapshot matches the DB snapshot
          if (boxInfo.backupSnapshot && boxInfo.backupSnapshot !== box.backupSnapshot) {
            this.logger.warn(
              `Ignoring stale backup completion for box ${box.id}: runner snapshot ${boxInfo.backupSnapshot} does not match DB snapshot ${box.backupSnapshot}`,
            )
            break
          }
          await this.boxService.updateBoxBackupState(box.id, BackupState.COMPLETED)
          break
        }
        case BackupState.ERROR: {
          // Only accept failure if the runner-reported snapshot matches the DB snapshot
          if (boxInfo.backupSnapshot && boxInfo.backupSnapshot !== box.backupSnapshot) {
            this.logger.warn(
              `Ignoring stale backup failure for box ${box.id}: runner snapshot ${boxInfo.backupSnapshot} does not match DB snapshot ${box.backupSnapshot}`,
            )
            break
          }
          await this.boxService.updateBoxBackupState(
            box.id,
            BackupState.ERROR,
            undefined,
            undefined,
            boxInfo.backupErrorReason,
          )
          break
        }
        // If backup state is none, retry the backup process by setting the backup state to pending
        // This can happen if the runner is restarted or the operation is cancelled
        case BackupState.NONE: {
          await this.boxService.updateBoxBackupState(box.id, BackupState.PENDING)
          break
        }
        // If still in progress or any other state, do nothing and wait for next sync
      }
    } catch (error) {
      await this.boxService.updateBoxBackupState(
        box.id,
        BackupState.ERROR,
        undefined,
        undefined,
        fromAxiosError(error).message,
      )
      throw error
    }
  }

  private async deleteBoxBackupRepositoryFromRegistry(box: Box): Promise<void> {
    const registry = await this.dockerRegistryService.findOne(box.backupRegistryId)

    try {
      await this.dockerRegistryService.deleteBoxRepository(box.id, registry)
    } catch (error) {
      this.logger.error(
        `Failed to delete backup repository ${box.id} from registry ${registry.id}:`,
        fromAxiosError(error),
      )
    }
  }

  private async handlePendingBackup(box: Box): Promise<void> {
    const lockKey = `runner-${box.runnerId}-backup-lock`
    try {
      await this.redisLockProvider.waitForLock(lockKey, 10)

      const backupsInProgress = await this.boxRepository.count({
        where: {
          runnerId: box.runnerId,
          backupState: BackupState.IN_PROGRESS,
        },
      })
      if (backupsInProgress >= this.configService.getOrThrow('maxConcurrentBackupsPerRunner')) {
        return
      }

      const registry = await this.dockerRegistryService.findOne(box.backupRegistryId)
      if (!registry) {
        throw new Error('Registry not found')
      }

      const runner = await this.runnerService.findOneOrFail(box.runnerId)
      const runnerAdapter = await this.runnerAdapterFactory.create(runner)

      //  check if backup is already in progress on the runner
      const runnerBox = await runnerAdapter.boxInfo(box.id)
      if (runnerBox.backupState === BackupState.IN_PROGRESS) {
        await this.boxService.updateBoxBackupState(box.id, BackupState.IN_PROGRESS)
        return
      }

      // Initiate backup on runner
      await runnerAdapter.createBackup(box, box.backupSnapshot, registry)

      await this.boxService.updateBoxBackupState(box.id, BackupState.IN_PROGRESS)
    } catch (error) {
      if (error.response?.status === 400 && error.response?.data?.message.includes('A backup is already in progress')) {
        await this.boxService.updateBoxBackupState(box.id, BackupState.IN_PROGRESS)
        return
      }
      await this.boxService.updateBoxBackupState(
        box.id,
        BackupState.ERROR,
        undefined,
        undefined,
        fromAxiosError(error).message,
      )
      throw error
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }

  @OnEvent(BoxEvents.ARCHIVED)
  @TrackJobExecution()
  private async handleBoxArchivedEvent(event: BoxArchivedEvent) {
    this.setBackupPending(event.box)
  }

  @OnEvent(BoxEvents.DESTROYED)
  @TrackJobExecution()
  private async handleBoxDestroyedEvent(event: BoxDestroyedEvent) {
    this.deleteBoxBackupRepositoryFromRegistry(event.box)
  }

  @OnEvent(BoxEvents.BACKUP_CREATED)
  @TrackJobExecution()
  private async handleBoxBackupCreatedEvent(event: BoxBackupCreatedEvent) {
    this.setBackupPending(event.box)
  }
}
