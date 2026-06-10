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
import { BoxState } from '../../box/enums/box-state.enum'
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

@Injectable()
export class UsageService implements TrackableJobExecutions, OnApplicationShutdown {
  activeJobs = new Set<string>()
  private readonly logger = new Logger(UsageService.name)

  constructor(
    @InjectRepository(BoxUsagePeriod)
    private boxUsagePeriodRepository: Repository<BoxUsagePeriod>,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly boxRepository: BoxRepository,
  ) {}

  async onApplicationShutdown() {
    //  wait for all active jobs to finish
    while (this.activeJobs.size > 0) {
      this.logger.log(`Waiting for ${this.activeJobs.size} active jobs to finish`)
      await sleep(1000)
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
          await this.createUsagePeriod(event)
          break
        }
        case BoxState.STOPPING:
          await this.closeUsagePeriod(event.box.id)
          await this.createUsagePeriod(event, true)
          break
        case BoxState.ERROR:
        case BoxState.BUILD_FAILED:
        case BoxState.ARCHIVED:
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
    if (!(await this.redisLockProvider.lock('close-and-reopen-usage-periods', 60))) {
      return
    }

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
      if (!(await this.aquireLock(usagePeriod.boxId))) {
        continue
      }

      // validate that the usage period should remain active just in case
      try {
        const box = await this.boxRepository.findOne({
          where: {
            id: usagePeriod.boxId,
          },
        })

        await this.boxUsagePeriodRepository.manager.transaction(async (transactionalEntityManager) => {
          // Close usage period
          const closeTime = new Date()
          usagePeriod.endAt = closeTime
          await transactionalEntityManager.save(usagePeriod)

          if (
            box &&
            (box.state === BoxState.STARTED || box.state === BoxState.STOPPED || box.state === BoxState.STOPPING)
          ) {
            // Create new usage period
            const newUsagePeriod = BoxUsagePeriod.fromUsagePeriod(usagePeriod)
            newUsagePeriod.startAt = closeTime
            newUsagePeriod.endAt = null
            await transactionalEntityManager.save(newUsagePeriod)
          }
        })
      } catch (error) {
        this.logger.error(`Error closing and reopening usage period ${usagePeriod.boxId}`, error)
      } finally {
        await this.releaseLock(usagePeriod.boxId)
      }
    }

    await this.redisLockProvider.unlock('close-and-reopen-usage-periods')
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

    await this.boxUsagePeriodRepository.manager.transaction(async (transactionalEntityManager) => {
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
    })

    await this.redisLockProvider.unlock(lockKey)
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
