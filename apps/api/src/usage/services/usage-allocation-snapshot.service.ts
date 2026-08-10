/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectRepository } from '@nestjs/typeorm'
import axios from 'axios'
import { IsNull, Not, Repository } from 'typeorm'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../../box/constants/box.constants'
import { RedisLockProvider } from '../../box/common/redis-lock.provider'
import { LogExecution } from '../../common/decorators/log-execution.decorator'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'
import { TrackJobExecution } from '../../common/decorators/track-job-execution.decorator'
import { TrackableJobExecutions } from '../../common/interfaces/trackable-job-executions'
import { TypedConfigService } from '../../config/typed-config.service'
import { BoxUsagePeriod } from '../entities/box-usage-period.entity'
import { InvalidUsagePeriodError } from '../usage-event'
import { OpenAllocationDto, toOpenAllocationDto } from '../open-allocation'

const SNAPSHOT_LOCK_KEY = 'snapshot-open-allocations'

/**
 * Pushes every currently open (not yet closed) box usage allocation to
 * Commerce as one full replace-all snapshot, on a fixed interval.
 *
 * Unlike UsageExportPublisherService, this is not an outbox: an open period
 * has no stable identity across a roll-over (closing and reopening it keeps
 * only boxId+startAt), and the whole set is stale again five minutes after it
 * is sent regardless of whether this push succeeded. There is therefore
 * nothing to retry — a failed push just waits for the next tick, which sends
 * fresher data anyway. Sending an empty snapshot is deliberate: it is what
 * lets the consumer's asOf watermark advance when every box has stopped.
 */
@Injectable()
export class UsageAllocationSnapshotService implements TrackableJobExecutions, OnApplicationShutdown {
  activeJobs = new Set<string>()
  private readonly logger = new Logger(UsageAllocationSnapshotService.name)

  constructor(
    @InjectRepository(BoxUsagePeriod)
    private readonly boxUsagePeriodRepository: Repository<BoxUsagePeriod>,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly configService: TypedConfigService,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    while (this.activeJobs.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES, { name: SNAPSHOT_LOCK_KEY })
  @TrackJobExecution()
  @LogExecution(SNAPSHOT_LOCK_KEY)
  @WithInstrumentation()
  async snapshotOpenAllocations(): Promise<void> {
    if (!this.configService.get('usageExport.allocationSnapshotEnabled')) {
      return
    }
    if (!(await this.redisLockProvider.lock(SNAPSHOT_LOCK_KEY, 60))) {
      return
    }

    try {
      const openPeriods = await this.boxUsagePeriodRepository.find({
        where: {
          endAt: IsNull(),
          organizationId: Not(BOX_WARM_POOL_UNASSIGNED_ORGANIZATION),
        },
      })

      await this.push(this.encode(openPeriods))
    } finally {
      await this.redisLockProvider.unlock(SNAPSHOT_LOCK_KEY)
    }
  }

  /**
   * A row that fails encoding is a defect in that one box's usage row, not in
   * the snapshot as a whole — skipping it costs one allocation out of
   * thousands, while failing the batch over it would starve every other box
   * of a snapshot until someone fixes data this cron cannot fix itself.
   */
  private encode(openPeriods: BoxUsagePeriod[]): OpenAllocationDto[] {
    const allocations: OpenAllocationDto[] = []
    for (const period of openPeriods) {
      try {
        allocations.push(toOpenAllocationDto(period))
      } catch (error) {
        if (!(error instanceof InvalidUsagePeriodError)) {
          throw error
        }
        this.logger.error(`Skipping open allocation for box ${period.boxId}: ${error.message}`)
      }
    }
    return allocations
  }

  private async push(allocations: OpenAllocationDto[]): Promise<void> {
    const asOf = new Date().toISOString()
    try {
      await axios.post(
        `${this.configService.get('usageExport.url')}/internal/allocation-snapshot`,
        { asOf, allocations },
        {
          timeout: this.configService.get('usageExport.timeoutMs'),
          headers: {
            authorization: `Bearer ${this.configService.get('usageExport.token')}`,
            'content-type': 'application/json',
          },
        },
      )
      this.logger.log(`Pushed an allocation snapshot of ${allocations.length} open box(es), as of ${asOf}`)
    } catch (error) {
      this.logger.error(`Failed to push allocation snapshot: ${this.describe(error)}`)
    }
  }

  private describe(error: unknown): string {
    if (axios.isAxiosError(error)) {
      return `${error.code ?? 'HTTP'} ${error.response?.status ?? ''} ${error.message}`.trim()
    }
    return error instanceof Error ? error.message : String(error)
  }
}
