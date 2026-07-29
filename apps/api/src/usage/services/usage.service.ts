/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectRepository } from '@nestjs/typeorm'
import { setTimeout as sleep } from 'timers/promises'
import { IsNull, LessThan, Not, Repository } from 'typeorm'
import { RedisLockProvider } from '../../box/common/redis-lock.provider'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../../box/constants/box.constants'
import { BoxEvents } from '../../box/constants/box-events.constants'
import { Box } from '../../box/entities/box.entity'
import { Runner } from '../../box/entities/runner.entity'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BoxState } from '../../box/enums/box-state.enum'
import { BoxDesiredStateUpdatedEvent } from '../../box/events/box-desired-state-updated.event'
import { BoxStateUpdatedEvent } from '../../box/events/box-state-updated.event'
import { BoxRepository } from '../../box/repositories/box.repository'
import { RunnerService } from '../../box/services/runner.service'
import { LogExecution } from '../../common/decorators/log-execution.decorator'
import { OnAsyncEvent } from '../../common/decorators/on-async-event.decorator'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'
import { TrackJobExecution } from '../../common/decorators/track-job-execution.decorator'
import { TrackableJobExecutions } from '../../common/interfaces/trackable-job-executions'
import { Region } from '../../region/entities/region.entity'
import { RegionType } from '../../region/enums/region-type.enum'
import { BoxUsagePeriodArchive } from '../entities/box-usage-period-archive.entity'
import { BoxUsagePeriod } from '../entities/box-usage-period.entity'

const BOX_USAGE_LOCK_TTL_SECONDS = 60
const USAGE_PERIOD_MAX_AGE_MS = 24 * 60 * 60 * 1000
const USAGE_RECONCILE_BATCH_SIZE = 100
const USAGE_CREATION_BOX_STATES: BoxState[] = [BoxState.STARTED, BoxState.STOPPING, BoxState.STOPPED, BoxState.RESIZING]
const USAGE_CLOSING_BOX_STATES: BoxState[] = [
  BoxState.ERROR,
  BoxState.ARCHIVED,
  BoxState.DESTROYING,
  BoxState.DESTROYED,
]

@Injectable()
export class UsageService implements TrackableJobExecutions, OnApplicationShutdown, OnModuleInit {
  activeJobs = new Set<string>()
  private readonly logger = new Logger(UsageService.name)

  constructor(
    @InjectRepository(BoxUsagePeriod)
    private readonly usagePeriodRepository: Repository<BoxUsagePeriod>,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly boxRepository: BoxRepository,
    @InjectRepository(Region)
    private readonly regionRepository: Repository<Region>,
    private readonly runnerService: RunnerService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reconcileUsagePeriods()
  }

  async onApplicationShutdown(): Promise<void> {
    while (this.activeJobs.size > 0) {
      this.logger.log(`Waiting for ${this.activeJobs.size} active jobs to finish`)
      await sleep(1000)
    }
  }

  @OnAsyncEvent({ event: BoxEvents.DESIRED_STATE_UPDATED })
  @TrackJobExecution()
  async handleBoxDesiredStateUpdate(event: BoxDesiredStateUpdatedEvent): Promise<void> {
    if (event.newDesiredState !== BoxDesiredState.DESTROYED) {
      return
    }

    const lockKey = this.getBoxLockKey(event.box.id)
    await this.redisLockProvider.waitForLock(lockKey, BOX_USAGE_LOCK_TTL_SECONDS)

    try {
      await this.closeUsagePeriod(event.box.id)
    } finally {
      await this.releaseLock(lockKey, `box ${event.box.id}`)
    }
  }

  @OnAsyncEvent({ event: BoxEvents.STATE_UPDATED })
  @TrackJobExecution()
  async handleBoxStateUpdate(event: BoxStateUpdatedEvent): Promise<void> {
    const lockKey = this.getBoxLockKey(event.box.id)
    await this.redisLockProvider.waitForLock(lockKey, BOX_USAGE_LOCK_TTL_SECONDS)

    try {
      const box = await this.boxRepository.findOne({ where: { id: event.box.id } })
      if (
        !box ||
        box.desiredState === BoxDesiredState.DESTROYED ||
        box.organizationId === BOX_WARM_POOL_UNASSIGNED_ORGANIZATION
      ) {
        await this.closeUsagePeriod(event.box.id)
        return
      }

      switch (box.state) {
        case BoxState.STARTED:
          await this.replaceUsagePeriod(box)
          break
        case BoxState.STOPPING:
          await this.replaceUsagePeriod(box, true)
          break
        case BoxState.STOPPED: {
          const runningUsagePeriod = await this.usagePeriodRepository.findOne({
            where: [
              {
                boxId: box.id,
                endAt: IsNull(),
                cpu: Not(0),
              },
              {
                boxId: box.id,
                endAt: IsNull(),
                gpu: Not(0),
              },
              {
                boxId: box.id,
                endAt: IsNull(),
                mem: Not(0),
              },
              {
                boxId: box.id,
                endAt: IsNull(),
                disk: Not(box.disk),
              },
            ],
          })
          if (runningUsagePeriod) {
            await this.replaceUsagePeriod(box, true)
          }
          break
        }
        case BoxState.ERROR:
        case BoxState.ARCHIVED:
        case BoxState.DESTROYING:
        case BoxState.DESTROYED:
          await this.closeUsagePeriod(box.id)
          break
      }
    } finally {
      await this.releaseLock(lockKey, `box ${event.box.id}`)
    }
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'reconcile-usage-periods' })
  @TrackJobExecution()
  @LogExecution('reconcile-usage-periods')
  @WithInstrumentation()
  async reconcileUsagePeriods(): Promise<void> {
    const lockKey = 'reconcile-usage-periods'
    if (!(await this.redisLockProvider.lock(lockKey, BOX_USAGE_LOCK_TTL_SECONDS))) {
      return
    }

    try {
      const boxes = await this.boxRepository
        .createQueryBuilder('box')
        .leftJoin(BoxUsagePeriod, 'usage', 'usage."boxId" = box.id AND usage."endAt" IS NULL')
        .where('box.state IN (:...billableStates)', { billableStates: USAGE_CREATION_BOX_STATES })
        .andWhere('box."desiredState" <> :destroyed', { destroyed: BoxDesiredState.DESTROYED })
        .andWhere('box."organizationId" <> :warmPoolOrganization', {
          warmPoolOrganization: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
        })
        .andWhere('usage.id IS NULL')
        .orderBy('box."createdAt"', 'ASC')
        .addOrderBy('box.id', 'ASC')
        .take(USAGE_RECONCILE_BATCH_SIZE)
        .getMany()

      const usagePeriodsToReconcile = await this.findUsagePeriodsToReconcile()
      const boxIds = new Set([...boxes.map((box) => box.id), ...usagePeriodsToReconcile.map((period) => period.boxId)])

      for (const boxId of boxIds) {
        await this.reconcileBoxUsage(boxId)
      }
    } finally {
      await this.releaseLock(lockKey, 'usage reconcile job')
    }
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'close-and-reopen-usage-periods' })
  @TrackJobExecution()
  @LogExecution('close-and-reopen-usage-periods')
  @WithInstrumentation()
  async closeAndReopenUsagePeriods(): Promise<void> {
    const lockKey = 'close-and-reopen-usage-periods'
    if (!(await this.redisLockProvider.lock(lockKey, BOX_USAGE_LOCK_TTL_SECONDS))) {
      return
    }

    try {
      const usagePeriods = await this.usagePeriodRepository.find({
        where: {
          endAt: IsNull(),
          startAt: LessThan(new Date(Date.now() - USAGE_PERIOD_MAX_AGE_MS)),
          organizationId: Not(BOX_WARM_POOL_UNASSIGNED_ORGANIZATION),
        },
        order: {
          startAt: 'ASC',
        },
        take: 100,
      })

      for (const usagePeriod of usagePeriods) {
        await this.rollUsagePeriod(usagePeriod)
      }
    } finally {
      await this.releaseLock(lockKey, 'usage rollover job')
    }
  }

  @Cron(CronExpression.EVERY_5_SECONDS, { name: 'archive-usage-periods' })
  @TrackJobExecution()
  @LogExecution('archive-usage-periods')
  @WithInstrumentation()
  async archiveUsagePeriods(): Promise<void> {
    const lockKey = 'archive-usage-periods'
    if (!(await this.redisLockProvider.lock(lockKey, BOX_USAGE_LOCK_TTL_SECONDS))) {
      return
    }

    try {
      await this.usagePeriodRepository.manager.transaction(async (transactionalEntityManager) => {
        const usagePeriods = await transactionalEntityManager.find(BoxUsagePeriod, {
          where: {
            endAt: Not(IsNull()),
          },
          order: {
            startAt: 'ASC',
          },
          take: 5000,
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
    } finally {
      await this.releaseLock(lockKey, 'usage archive job')
    }
  }

  private async replaceUsagePeriod(box: Box, diskOnly = false, preparedUsagePeriod?: BoxUsagePeriod): Promise<void> {
    const nextUsagePeriod = preparedUsagePeriod ?? (await this.prepareUsagePeriod(box, diskOnly))

    await this.usagePeriodRepository.manager.transaction(async (transactionalEntityManager) => {
      const currentUsagePeriod = await transactionalEntityManager.findOne(BoxUsagePeriod, {
        where: {
          boxId: box.id,
          endAt: IsNull(),
        },
        lock: {
          mode: 'pessimistic_write',
        },
      })

      if (currentUsagePeriod) {
        currentUsagePeriod.endAt = nextUsagePeriod.startAt
        await transactionalEntityManager.save(currentUsagePeriod)
      }

      await transactionalEntityManager.save(nextUsagePeriod)
    })
  }

  // Box updates commit before their in-process events run. Scan persisted
  // dimensions so a lost event cannot leave an obsolete billing snapshot open.
  private async findUsagePeriodsToReconcile(): Promise<BoxUsagePeriod[]> {
    return this.usagePeriodRepository
      .createQueryBuilder('usage')
      .leftJoin(Box, 'box', 'box.id = usage."boxId"')
      .leftJoin(Region, 'region', 'region.id = box.region')
      .leftJoin(Runner, 'runner', 'runner.id = box."runnerId"')
      .where('usage."endAt" IS NULL')
      .andWhere(
        `(
          box.id IS NULL
          OR box.state IN (:...closingStates)
          OR box."desiredState" = :destroyed
          OR box."organizationId" = :warmPoolOrganization
          OR (
            box.state IN (:...creationStates)
            AND box."desiredState" <> :destroyed
            AND box."organizationId" <> :warmPoolOrganization
            AND (
              usage."organizationId" IS DISTINCT FROM box."organizationId"::text
              OR usage.region IS DISTINCT FROM box.region
              OR usage.disk IS DISTINCT FROM box.disk
              OR usage."boxClass" IS DISTINCT FROM box.class::text
              OR usage."regionType" IS DISTINCT FROM COALESCE(region."regionType"::text, :defaultRegionType)
              OR (
                (
                  box.state IN (:...diskOnlyStates)
                  OR (box.state = :resizing AND box."desiredState" = :desiredStopped)
                )
                AND (
                  usage.cpu <> 0
                  OR usage.gpu <> 0
                  OR usage.mem <> 0
                  OR usage.gpu_type IS NOT NULL
                )
              )
              OR (
                (
                  box.state = :started
                  OR (box.state = :resizing AND box."desiredState" = :desiredStarted)
                )
                AND (
                  usage.cpu IS DISTINCT FROM box.cpu
                  OR usage.gpu IS DISTINCT FROM box.gpu
                  OR usage.mem IS DISTINCT FROM box.mem
                  OR usage.gpu_type IS DISTINCT FROM
                    CASE WHEN box.gpu > 0 THEN runner."gpuType" ELSE NULL END
                )
              )
            )
          )
        )`,
        {
          closingStates: USAGE_CLOSING_BOX_STATES,
          creationStates: USAGE_CREATION_BOX_STATES,
          defaultRegionType: RegionType.SHARED,
          desiredStarted: BoxDesiredState.STARTED,
          desiredStopped: BoxDesiredState.STOPPED,
          destroyed: BoxDesiredState.DESTROYED,
          diskOnlyStates: [BoxState.STOPPING, BoxState.STOPPED],
          resizing: BoxState.RESIZING,
          started: BoxState.STARTED,
          warmPoolOrganization: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
        },
      )
      .orderBy('usage."startAt"', 'ASC')
      .take(USAGE_RECONCILE_BATCH_SIZE)
      .getMany()
  }

  private async reconcileBoxUsage(boxId: string): Promise<void> {
    const lockKey = this.getBoxLockKey(boxId)
    if (!(await this.redisLockProvider.lock(lockKey, BOX_USAGE_LOCK_TTL_SECONDS))) {
      return
    }

    try {
      const box = await this.boxRepository.findOne({
        where: {
          id: boxId,
        },
      })
      if (!box || this.shouldCloseUsagePeriod(box) || box.organizationId === BOX_WARM_POOL_UNASSIGNED_ORGANIZATION) {
        await this.closeUsagePeriod(boxId)
        return
      }
      if (!this.shouldCreateUsagePeriod(box)) {
        return
      }

      const currentUsagePeriod = await this.usagePeriodRepository.findOne({
        where: {
          boxId,
          endAt: IsNull(),
        },
      })
      const diskOnly = this.isDiskOnlyUsage(box)
      const usagePeriod = await this.prepareUsagePeriod(box, diskOnly)
      if (currentUsagePeriod) {
        if (this.hasMatchingUsageDimensions(currentUsagePeriod, usagePeriod)) {
          return
        }
        await this.replaceUsagePeriod(box, diskOnly, usagePeriod)
        return
      }

      await this.usagePeriodRepository.save(usagePeriod)
    } catch (error) {
      this.logger.error(`Error reconciling usage period for box ${boxId}`, error)
    } finally {
      await this.releaseLock(lockKey, `box ${boxId}`)
    }
  }

  private async prepareUsagePeriod(box: Box, diskOnly: boolean): Promise<BoxUsagePeriod> {
    const usagePeriod = new BoxUsagePeriod()
    usagePeriod.boxId = box.id
    usagePeriod.organizationId = box.organizationId
    usagePeriod.startAt = new Date()
    usagePeriod.endAt = null
    usagePeriod.cpu = diskOnly ? 0 : box.cpu
    usagePeriod.gpu = diskOnly ? 0 : box.gpu
    usagePeriod.gpuType = diskOnly ? null : await this.getGpuType(box)
    usagePeriod.mem = diskOnly ? 0 : box.mem
    usagePeriod.disk = box.disk
    usagePeriod.region = box.region
    usagePeriod.boxClass = box.class
    usagePeriod.regionType = await this.getRegionType(box.region)
    return usagePeriod
  }

  private hasMatchingUsageDimensions(current: BoxUsagePeriod, expected: BoxUsagePeriod): boolean {
    return (
      current.organizationId === expected.organizationId &&
      current.cpu === expected.cpu &&
      current.gpu === expected.gpu &&
      current.gpuType === expected.gpuType &&
      current.mem === expected.mem &&
      current.disk === expected.disk &&
      current.region === expected.region &&
      current.boxClass === expected.boxClass &&
      current.regionType === expected.regionType
    )
  }

  private shouldCreateUsagePeriod(box: Box): boolean {
    return box.desiredState !== BoxDesiredState.DESTROYED && USAGE_CREATION_BOX_STATES.includes(box.state)
  }

  private shouldCloseUsagePeriod(box: Box): boolean {
    return box.desiredState === BoxDesiredState.DESTROYED || USAGE_CLOSING_BOX_STATES.includes(box.state)
  }

  private isDiskOnlyUsage(box: Box): boolean {
    return (
      box.state === BoxState.STOPPING ||
      box.state === BoxState.STOPPED ||
      (box.state === BoxState.RESIZING && box.desiredState === BoxDesiredState.STOPPED)
    )
  }

  private async closeUsagePeriod(boxId: string): Promise<void> {
    const lastUsagePeriod = await this.usagePeriodRepository.findOne({
      where: {
        boxId,
        endAt: IsNull(),
      },
    })

    if (!lastUsagePeriod) {
      return
    }

    lastUsagePeriod.endAt = new Date()
    await this.usagePeriodRepository.save(lastUsagePeriod)
  }

  private async rollUsagePeriod(candidateUsagePeriod: BoxUsagePeriod): Promise<void> {
    const lockKey = this.getBoxLockKey(candidateUsagePeriod.boxId)
    if (!(await this.redisLockProvider.lock(lockKey, BOX_USAGE_LOCK_TTL_SECONDS))) {
      return
    }

    try {
      await this.usagePeriodRepository.manager.transaction(async (transactionalEntityManager) => {
        const currentUsagePeriod = await transactionalEntityManager.findOne(BoxUsagePeriod, {
          where: {
            id: candidateUsagePeriod.id,
            boxId: candidateUsagePeriod.boxId,
            endAt: IsNull(),
          },
          lock: {
            mode: 'pessimistic_write',
          },
        })
        if (!currentUsagePeriod) {
          return
        }

        const box = await transactionalEntityManager.findOne(Box, {
          where: {
            id: candidateUsagePeriod.boxId,
          },
        })
        const closeTime = new Date()
        currentUsagePeriod.endAt = closeTime
        await transactionalEntityManager.save(currentUsagePeriod)

        if (!box || this.shouldCloseUsagePeriod(box) || box.organizationId === BOX_WARM_POOL_UNASSIGNED_ORGANIZATION) {
          return
        }

        const newUsagePeriod = BoxUsagePeriod.fromUsagePeriod(currentUsagePeriod)
        newUsagePeriod.startAt = closeTime
        newUsagePeriod.endAt = null
        if (this.isDiskOnlyUsage(box)) {
          newUsagePeriod.cpu = 0
          newUsagePeriod.gpu = 0
          newUsagePeriod.gpuType = null
          newUsagePeriod.mem = 0
        }
        await transactionalEntityManager.save(newUsagePeriod)
      })
    } catch (error) {
      this.logger.error(`Error closing and reopening usage period ${candidateUsagePeriod.boxId}`, error)
    } finally {
      await this.releaseLock(lockKey, `box ${candidateUsagePeriod.boxId}`)
    }
  }

  private async getGpuType(box: Box): Promise<string | null> {
    if (box.gpu <= 0 || !box.runnerId) {
      return null
    }

    try {
      const runner = await this.runnerService.findOne(box.runnerId)
      return runner?.gpuType ?? null
    } catch (error) {
      this.logger.error(`Error fetching GPU type for runner ${box.runnerId}`, error)
      return null
    }
  }

  private async getRegionType(regionId: string): Promise<RegionType> {
    try {
      const region = await this.regionRepository.findOne({
        select: ['regionType'],
        where: {
          id: regionId,
        },
        cache: {
          id: `region-type-${regionId}`,
          milliseconds: 60 * 60 * 1000,
        },
      })
      return region?.regionType ?? RegionType.SHARED
    } catch (error) {
      this.logger.error(`Error fetching region type for region ${regionId}`, error)
      return RegionType.SHARED
    }
  }

  private getBoxLockKey(boxId: string): string {
    return `usage-period-${boxId}`
  }

  private async releaseLock(lockKey: string, resource: string): Promise<void> {
    try {
      await this.redisLockProvider.unlock(lockKey)
    } catch (error) {
      this.logger.error(`Error releasing usage lock for ${resource}`, error)
    }
  }
}
