/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { IsNull, LessThan, Not, Repository } from 'typeorm'
import { BoxUsagePeriod } from '../entities/box-usage-period.entity'
import { Cron, CronExpression } from '@nestjs/schedule'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../../box/constants/box.constants'
import { BoxUsagePeriodArchive } from '../entities/box-usage-period-archive.entity'
import { TrackableJobExecutions } from '../../common/interfaces/trackable-job-executions'
import { TrackJobExecution } from '../../common/decorators/track-job-execution.decorator'
import { setTimeout as sleep } from 'timers/promises'
import { LogExecution } from '../../common/decorators/log-execution.decorator'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'
import { Box } from '../../box/entities/box.entity'
import { UsagePeriodWriter } from '../metering/usage-period-writer'

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
    private readonly usagePeriodWriter: UsagePeriodWriter,
  ) {}

  async onApplicationShutdown() {
    // Wait for all active jobs to finish.
    while (this.activeJobs.size > 0) {
      this.logger.log(`Waiting for ${this.activeJobs.size} active jobs to finish`)
      await sleep(1000)
    }
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'close-and-reopen-usage-periods', waitForCompletion: true })
  @TrackJobExecution()
  @LogExecution('close-and-reopen-usage-periods')
  @WithInstrumentation()
  async closeAndReopenBoxUsagePeriods() {
    const cutoff = new Date(Date.now() - 1000 * 60 * 60 * 24)
    const usagePeriods = await this.usagePeriodRepository.find({
      where: {
        endAt: IsNull(),
        startAt: LessThan(cutoff),
        organizationId: Not(BOX_WARM_POOL_UNASSIGNED_ORGANIZATION),
      },
      order: {
        startAt: 'ASC',
      },
      take: 100,
    })

    for (const candidate of usagePeriods) {
      try {
        await this.usagePeriodRepository.manager.transaction(async (transactionalEntityManager) => {
          const box = await transactionalEntityManager.findOne(Box, {
            where: { id: candidate.boxId },
            lock: { mode: 'pessimistic_write' },
            relations: [],
            loadEagerRelations: false,
          })

          const currentPeriod = await transactionalEntityManager.findOne(BoxUsagePeriod, {
            where: { id: candidate.id, endAt: IsNull() },
            lock: { mode: 'pessimistic_write' },
          })
          if (!currentPeriod || currentPeriod.startAt.getTime() >= cutoff.getTime()) {
            return
          }

          const [{ now: databaseNow }] = await transactionalEntityManager.query(`SELECT clock_timestamp() AS "now"`)
          const transitionAt = new Date(databaseNow)
          if (!box) {
            currentPeriod.endAt = transitionAt
            await transactionalEntityManager.save(BoxUsagePeriod, currentPeriod)
            return
          }

          await this.usagePeriodWriter.transition({
            manager: transactionalEntityManager,
            previousBox: box,
            currentBox: box,
            transitionAt,
            forceBoundary: true,
          })
        })
      } catch (error) {
        this.logger.error(`Error closing and reopening usage period ${candidate.boxId}`, error)
      }
    }
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
          SELECT p.id, p."boxId", p."organizationId", p."startAt", p."endAt",
                 p."computeBillableUntil", p."runtimeGeneration", p."runnerEpoch",
                 p.cpu, p.gpu, p.mem, p.disk, p.region, p."boxClass", p."regionType"
          FROM ${activeTable} p
          WHERE p."endAt" IS NOT NULL
          ORDER BY p."startAt", p.id
          LIMIT $1
          FOR UPDATE OF p SKIP LOCKED
        ), inserted AS (
          INSERT INTO ${archiveTable} (
            id, "boxId", "organizationId", "startAt", "endAt",
            "computeBillableUntil", "runtimeGeneration", "runnerEpoch",
            cpu, gpu, mem, disk, region, "boxClass", "regionType"
          )
          SELECT id, "boxId", "organizationId", "startAt", "endAt",
                 "computeBillableUntil", "runtimeGeneration", "runnerEpoch",
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
}
