/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { IsNull, LessThan, Not, Repository } from 'typeorm'
import { BoxUsagePeriod } from '../entities/box-usage-period.entity'
import { OnEvent } from '@nestjs/event-emitter'
import { BoxStateUpdatedEvent } from '../../box/events/box-state-updated.event'
import { BoxState } from '../../box/enums/box-state.enum'
import { BoxEvents } from '../../box/constants/box-events.constants'
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
import { BoxDesiredStateUpdatedEvent } from '../../box/events/box-desired-state-updated.event'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { Region } from '../../region/entities/region.entity'
import { RegionType } from '../../region/enums/region-type.enum'

const ARCHIVE_BATCH_SIZE = 1000

interface ArchiveBatchResult {
  claimed: number | string
  archived: number | string
  deleted: number | string
}

function quoteTablePath(tablePath: string): string {
  return tablePath
    .split('.')
    .map((part) => `"${part.replaceAll('"', '""')}"`)
    .join('.')
}

@Injectable()
export class UsageService implements TrackableJobExecutions, OnApplicationShutdown {
  activeJobs = new Set<string>()
  private readonly logger = new Logger(UsageService.name)

  constructor(
    @InjectRepository(BoxUsagePeriod)
    private usagePeriodRepository: Repository<BoxUsagePeriod>,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly boxRepository: BoxRepository,
    @InjectRepository(Region)
    private readonly regionRepository: Repository<Region>,
  ) {}

  async onApplicationShutdown() {
    // Wait for all active jobs to finish.
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
          await this.closeBoxUsagePeriod(event.box.id)
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
          await this.closeBoxUsagePeriod(event.box.id)
          await this.createBoxUsagePeriod(event)
          break
        }
        case BoxState.STOPPING:
          await this.closeBoxUsagePeriod(event.box.id)
          await this.createBoxUsagePeriod(event, true)
          break
        // Safeguard if STOPPING state is skipped.
        case BoxState.STOPPED: {
          const cpuUsagePeriod = await this.usagePeriodRepository.findOne({
            where: {
              boxId: event.box.id,
              endAt: IsNull(),
              cpu: Not(0),
            },
          })
          if (cpuUsagePeriod) {
            await this.closeBoxUsagePeriod(event.box.id)
            await this.createBoxUsagePeriod(event, true)
          }
          break
        }
        case BoxState.ERROR:
        case BoxState.ARCHIVED:
        case BoxState.DESTROYING:
        case BoxState.DESTROYED: {
          await this.closeBoxUsagePeriod(event.box.id)
          break
        }
      }
    } finally {
      this.releaseLock(event.box.id).catch((error) => {
        this.logger.error(`Error releasing lock for box ${event.box.id}`, error)
      })
    }
  }

  private async createBoxUsagePeriod(event: BoxStateUpdatedEvent, diskOnly = false) {
    if (event.box.organizationId === BOX_WARM_POOL_UNASSIGNED_ORGANIZATION) {
      return
    }

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
    usagePeriod.billingUserId = event.box.billingUserId
    usagePeriod.region = event.box.region
    usagePeriod.boxClass = event.box.class
    usagePeriod.regionType = await this.getRegionType(event.box.region)

    await this.usagePeriodRepository.save(usagePeriod)
  }

  private async closeBoxUsagePeriod(boxId: string) {
    const lastUsagePeriod = await this.usagePeriodRepository.findOne({
      where: {
        boxId,
        endAt: IsNull(),
      },
    })

    if (lastUsagePeriod) {
      lastUsagePeriod.endAt = new Date()
      await this.usagePeriodRepository.save(lastUsagePeriod)
    }
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'close-and-reopen-usage-periods' })
  @TrackJobExecution()
  @LogExecution('close-and-reopen-usage-periods')
  @WithInstrumentation()
  async closeAndReopenBoxUsagePeriods() {
    if (!(await this.redisLockProvider.lock('close-and-reopen-usage-periods', 60))) {
      return
    }

    const usagePeriods = await this.usagePeriodRepository.find({
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

      try {
        const box = await this.boxRepository.findOne({
          where: {
            id: usagePeriod.boxId,
          },
        })

        await this.usagePeriodRepository.manager.transaction(async (transactionalEntityManager) => {
          const closeTime = new Date()
          usagePeriod.endAt = closeTime
          await transactionalEntityManager.save(usagePeriod)

          if (
            box &&
            (box.state === BoxState.STARTED || box.state === BoxState.STOPPED || box.state === BoxState.STOPPING)
          ) {
            const newUsagePeriod = BoxUsagePeriod.fromBoxUsagePeriod(usagePeriod)
            newUsagePeriod.startAt = closeTime
            newUsagePeriod.endAt = null
            if (box.state === BoxState.STOPPED) {
              newUsagePeriod.cpu = 0
              newUsagePeriod.gpu = 0
              newUsagePeriod.mem = 0
            }
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

  @Cron(CronExpression.EVERY_5_SECONDS, { name: 'archive-usage-periods', waitForCompletion: true })
  @TrackJobExecution()
  @LogExecution('archive-usage-periods')
  @WithInstrumentation()
  async archiveBoxUsagePeriods() {
    const result = await this.usagePeriodRepository.manager.transaction(async (transactionalEntityManager) => {
      const activeTable = quoteTablePath(transactionalEntityManager.getRepository(BoxUsagePeriod).metadata.tablePath)
      const archiveTable = quoteTablePath(
        transactionalEntityManager.getRepository(BoxUsagePeriodArchive).metadata.tablePath,
      )
      const rows = await transactionalEntityManager.query<ArchiveBatchResult[]>(
        `WITH claimed AS (
          SELECT p.id, p."boxId", p."organizationId", p."billingUserId", p."startAt", p."endAt",
                 p.cpu, p.gpu, p.mem, p.disk, p.region, p."boxClass", p."regionType"
          FROM ${activeTable} p
          WHERE p."endAt" IS NOT NULL
          ORDER BY p."startAt", p.id
          LIMIT $1
          FOR UPDATE OF p SKIP LOCKED
        ), inserted AS (
          INSERT INTO ${archiveTable} (
            id, "boxId", "organizationId", "billingUserId", "startAt", "endAt",
            cpu, gpu, mem, disk, region, "boxClass", "regionType"
          )
          SELECT id, "boxId", "organizationId", "billingUserId", "startAt", "endAt",
                 cpu, gpu, mem, disk, region, "boxClass", "regionType"
          FROM claimed
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        ), deleted AS (
          DELETE FROM ${activeTable} p
          USING inserted i
          WHERE p.id = i.id
          RETURNING p.id
        )
        SELECT
          (SELECT COUNT(*)::int FROM claimed) AS claimed,
          (SELECT COUNT(*)::int FROM inserted) AS archived,
          (SELECT COUNT(*)::int FROM deleted) AS deleted`,
        [ARCHIVE_BATCH_SIZE],
      )
      const row = rows[0] ?? { claimed: 0, archived: 0, deleted: 0 }
      return {
        claimed: Number(row.claimed),
        archived: Number(row.archived),
        deleted: Number(row.deleted),
      }
    })

    if (result.claimed > 0) {
      this.logger.debug(`Archived ${result.archived} of ${result.claimed} closed usage periods`)
    }
    if (result.claimed !== result.archived || result.archived !== result.deleted) {
      this.logger.error(
        `Usage archive invariant conflict: claimed=${result.claimed} archived=${result.archived} deleted=${result.deleted}`,
      )
    }
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

  private async getRegionType(regionId: string): Promise<string> {
    try {
      const region = await this.regionRepository.findOne({
        select: ['regionType'],
        where: {
          id: regionId,
        },
        cache: {
          id: `region-type-${regionId}`,
          milliseconds: 1000 * 60 * 60,
        },
      })

      return region?.regionType ?? RegionType.SHARED
    } catch (error) {
      this.logger.error(`Error fetching region type for region ${regionId}`, error)
      return RegionType.SHARED
    }
  }
}
