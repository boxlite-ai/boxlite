/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { IsNull, LessThan, Not, Repository } from 'typeorm'
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

@Injectable()
export class UsageService implements TrackableJobExecutions, OnApplicationShutdown {
  activeJobs = new Set<symbol>()
  private readonly logger = new Logger(UsageService.name)
  private readonly shutdownController = new AbortController()

  constructor(
    @InjectRepository(BoxUsagePeriod)
    private boxUsagePeriodRepository: Repository<BoxUsagePeriod>,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly boxRepository: BoxRepository,
    private readonly usageExportOutboxService: UsageExportOutboxService,
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
          await this.createUsagePeriod(event)
          break
        }
        // Billing stops charging compute the moment a stop is requested, while
        // quota keeps counting it (BOX_STATES_CONSUMING_COMPUTE includes
        // STOPPING) because the runner has not released cpu/memory yet. The two
        // answer different questions; do not "reconcile" them without a pricing
        // decision.
        case BoxState.STOPPING:
          await this.closeUsagePeriod(event.box.id)
          await this.createUsagePeriod(event, true)
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
            await this.createUsagePeriod(event, true)
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

  private async createUsagePeriod(event: BoxStateUpdatedEvent, diskOnly = false) {
    const usagePeriod = new BoxUsagePeriod()
    usagePeriod.boxId = event.box.id
    usagePeriod.startAt = new Date()
    usagePeriod.endAt = null
    if (!diskOnly) {
      usagePeriod.cpu = event.box.cpu
      usagePeriod.gpu = event.box.gpu
      usagePeriod.mem = event.box.mem
    } else {
      usagePeriod.cpu = 0
      usagePeriod.gpu = 0
      usagePeriod.mem = 0
    }
    usagePeriod.disk = event.box.disk
    usagePeriod.organizationId = event.box.organizationId
    usagePeriod.region = event.box.region

    await this.boxUsagePeriodRepository.save(usagePeriod)
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

            if (
              box &&
              (box.state === BoxState.STARTED || box.state === BoxState.STOPPED || box.state === BoxState.STOPPING)
            ) {
              const newUsagePeriod = BoxUsagePeriod.fromUsagePeriod(usagePeriod)
              newUsagePeriod.startAt = closeTime
              newUsagePeriod.endAt = null
              if (box.state === BoxState.STOPPED) {
                newUsagePeriod.cpu = 0
                newUsagePeriod.gpu = 0
                newUsagePeriod.mem = 0
              }
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
        // Keep the archive and export intent atomic so neither can survive without the other.
        await this.usageExportOutboxService.enqueue(transactionalEntityManager, usagePeriods)
        signal.throwIfAborted()
      })
    }, lockKey)
  }

  private async waitForLock(boxId: string): Promise<RedisLockLease> {
    return this.redisLockProvider.waitForLock(`usage-period-${boxId}`, 60, {
      signal: this.shutdownController.signal,
      retryDelayMs: 500,
    })
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
