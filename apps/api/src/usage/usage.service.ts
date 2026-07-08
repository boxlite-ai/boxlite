/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectRepository } from '@nestjs/typeorm'
import { EntityManager, FindOptionsWhere, IsNull, LessThan, MoreThan, Not, Repository } from 'typeorm'
import { BoxEvents } from '../box/constants/box-events.constants'
import { RedisLockProvider } from '../box/common/redis-lock.provider'
import { Box } from '../box/entities/box.entity'
import { BoxCreatedEvent } from '../box/events/box-create.event'
import { BoxDesiredStateUpdatedEvent } from '../box/events/box-desired-state-updated.event'
import { BoxStateUpdatedEvent } from '../box/events/box-state-updated.event'
import { BoxDesiredState } from '../box/enums/box-desired-state.enum'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxOrganizationUpdatedEvent } from '../box/events/box-organization-updated.event'
import { BoxRepository } from '../box/repositories/box.repository'
import { OnAsyncEvent } from '../common/decorators/on-async-event.decorator'
import {
  UsagePeriodKind,
  UsageTotals,
  aggregateUsagePeriods,
  planUsageTransition,
  usagePeriodKind,
} from './metering/usage-period-math'
import { UsagePeriodArchive } from './entities/usage-period-archive.entity'
import { UsagePeriod } from './entities/usage-period.entity'

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_METERING_LOOKBACK_MS = 30 * ONE_DAY_MS
const DEFAULT_METERING_LIMIT = 250
const MAX_METERING_LIMIT = 1000

export interface MeteringQueryOptions {
  from?: Date
  to?: Date
  limit?: number
  boxId?: string
}

export interface MeteringPeriodView {
  id: string
  source: 'usage_period' | 'usage_period_archive'
  sourcePeriodId?: string
  boxId: string
  organizationId: string
  region: string | null
  startAt: Date
  endAt: Date | null
  kind: UsagePeriodKind
  cpu: number
  mem: number
  disk: number
  gpu: number
  durationSeconds: number
  active: boolean
  actualCpuSeconds: number | null
  actualRssAvgBytes: string | null
  actualRssPeakBytes: string | null
  sampleCount: number | null
}

export interface OrganizationMeteringView {
  organizationId: string
  from: Date
  to: Date
  activePeriods: MeteringPeriodView[]
  archivedPeriods: MeteringPeriodView[]
  totals: UsageTotals
}

@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name)

  constructor(
    @InjectRepository(UsagePeriod)
    private readonly periods: Repository<UsagePeriod>,
    @InjectRepository(UsagePeriodArchive)
    private readonly archives: Repository<UsagePeriodArchive>,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly boxRepository: BoxRepository,
  ) {}

  @OnAsyncEvent({ event: BoxEvents.CREATED })
  async handleBoxCreated(event: BoxCreatedEvent): Promise<void> {
    await this.recordLifecycleTransition(event.box, event.box.state, event.box.desiredState)
  }

  @OnAsyncEvent({ event: BoxEvents.STATE_UPDATED })
  async handleBoxStateUpdated(event: BoxStateUpdatedEvent): Promise<void> {
    await this.recordLifecycleTransition(event.box, event.newState, event.box.desiredState)
  }

  @OnAsyncEvent({ event: BoxEvents.DESIRED_STATE_UPDATED })
  async handleBoxDesiredStateUpdated(event: BoxDesiredStateUpdatedEvent): Promise<void> {
    if (event.newDesiredState !== BoxDesiredState.DESTROYED) {
      return
    }

    await this.recordLifecycleTransition(event.box, event.box.state, event.newDesiredState)
  }

  @OnAsyncEvent({ event: BoxEvents.ORGANIZATION_UPDATED })
  async handleBoxOrganizationUpdated(event: BoxOrganizationUpdatedEvent): Promise<void> {
    await this.recordLifecycleTransition(event.box, event.box.state, event.box.desiredState)
  }

  async applyTransition(box: Box, state: BoxState, desiredState: BoxDesiredState, now: Date): Promise<void> {
    const open = await this.findOpenPeriod(box.id)
    if (open && now.getTime() < open.startAt.getTime()) {
      this.logger.warn(
        `ignoring stale usage transition for box ${box.id}: ${now.toISOString()} before ${open.startAt.toISOString()}`,
      )
      return
    }
    const openKind = open?.kind ?? null
    const plan = planUsageTransition(openKind, state, desiredState)
    const nextKind = usagePeriodKind(state, desiredState)
    const resourcesChanged =
      Boolean(open) &&
      nextKind !== 'gone' &&
      open?.kind === nextKind &&
      !this.openPeriodMatchesBox(open, box, nextKind)

    if ((plan.closeOpen || resourcesChanged) && open) {
      open.endAt = now
      await this.periods.save(open)
    }

    const openKindToCreate = plan.openKind ?? (resourcesChanged ? (nextKind as UsagePeriodKind) : null)
    if (openKindToCreate) {
      await this.periods.save(this.createPeriod(box, openKindToCreate, now))
    }
  }

  async getOrganizationMeteringView(
    organizationId: string,
    options: MeteringQueryOptions = {},
    now: Date = new Date(),
  ): Promise<OrganizationMeteringView> {
    const to = options.to ?? now
    const from = options.from ?? new Date(to.getTime() - DEFAULT_METERING_LOOKBACK_MS)
    const limit = this.normalizeMeteringLimit(options.limit)
    const activeWhere = this.periodOverlapWhere<UsagePeriod>(organizationId, from, to, options.boxId)
    const archivedWhere = this.periodOverlapWhere<UsagePeriodArchive>(organizationId, from, to, options.boxId)

    const [activeRows, archivedRows] = await Promise.all([
      this.periods.find({
        where: activeWhere,
        order: { startAt: 'DESC' },
        take: limit,
      }),
      this.archives.find({
        where: archivedWhere,
        order: { startAt: 'DESC' },
        take: limit,
      }),
    ])

    const activePeriods = activeRows.map((period) => this.toMeteringPeriodView(period, 'usage_period', to))
    const archivedPeriods = archivedRows.map((period) =>
      this.toMeteringPeriodView(period, 'usage_period_archive', to),
    )

    return {
      organizationId,
      from,
      to,
      activePeriods,
      archivedPeriods,
      totals: aggregateUsagePeriods([...activeRows, ...archivedRows], from, to),
    }
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'close-and-reopen-usage-periods' })
  async closeAndReopenUsagePeriods(now: Date = new Date()): Promise<void> {
    const lockKey = 'usage-periods:rollover'
    if (!(await this.redisLockProvider.lock(lockKey, 60))) {
      return
    }

    try {
      const oldOpenPeriods = await this.periods.find({
        where: {
          endAt: IsNull(),
          startAt: LessThan(new Date(now.getTime() - ONE_DAY_MS)),
        },
        take: 100,
      })

      for (const period of oldOpenPeriods) {
        if (!(await this.redisLockProvider.lock(this.boxLockKey(period.boxId), 60))) {
          continue
        }

        try {
          const box = await this.boxRepository.findOne({ where: { id: period.boxId } })
          period.endAt = now
          await this.periods.save(period)

          if (!box) {
            continue
          }

          const plan = planUsageTransition(null, box.state, box.desiredState)
          if (plan.openKind) {
            await this.periods.save(this.createPeriod(box, plan.openKind, now))
          }
        } finally {
          await this.redisLockProvider.unlock(this.boxLockKey(period.boxId))
        }
      }
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }

  @Cron(CronExpression.EVERY_5_SECONDS, { name: 'archive-usage-periods' })
  async archiveUsagePeriods(): Promise<void> {
    const lockKey = 'usage-periods:archive'
    if (!(await this.redisLockProvider.lock(lockKey, 60))) {
      return
    }

    try {
      const closed = await this.periods.find({
        where: { endAt: Not(IsNull()) },
        take: 5000,
      })

      if (closed.length === 0) {
        return
      }

      await this.archiveClosedPeriods(closed)
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }

  private async findOpenPeriod(boxId: string): Promise<UsagePeriod | null> {
    return this.periods.findOne({
      where: { boxId, endAt: IsNull() },
    })
  }

  private createPeriod(box: Box, kind: UsagePeriodKind, startAt: Date): UsagePeriod {
    const running = kind === 'running'
    return this.periods.create({
      boxId: box.id,
      organizationId: box.organizationId,
      region: box.region,
      startAt,
      endAt: null,
      kind,
      cpu: running ? box.cpu : 0,
      mem: running ? box.mem : 0,
      gpu: running ? box.gpu : 0,
      disk: box.disk,
      actualCpuSeconds: null,
      actualRssAvgBytes: null,
      actualRssPeakBytes: null,
      sampleCount: null,
    })
  }

  private openPeriodMatchesBox(period: UsagePeriod, box: Box, kind: UsagePeriodKind): boolean {
    const running = kind === 'running'
    return (
      period.organizationId === box.organizationId &&
      period.region === box.region &&
      period.cpu === (running ? box.cpu : 0) &&
      period.mem === (running ? box.mem : 0) &&
      period.gpu === (running ? box.gpu : 0) &&
      period.disk === box.disk
    )
  }

  private periodOverlapWhere<T extends UsagePeriod | UsagePeriodArchive>(
    organizationId: string,
    from: Date,
    to: Date,
    boxId?: string,
  ): FindOptionsWhere<T>[] {
    const base = {
      organizationId,
      ...(boxId ? { boxId } : {}),
      startAt: LessThan(to),
    } as FindOptionsWhere<T>

    return [{ ...base, endAt: IsNull() }, { ...base, endAt: MoreThan(from) }]
  }

  private normalizeMeteringLimit(limit: number | undefined): number {
    if (limit === undefined || Number.isNaN(limit)) {
      return DEFAULT_METERING_LIMIT
    }

    return Math.min(Math.max(Math.trunc(limit), 1), MAX_METERING_LIMIT)
  }

  private toMeteringPeriodView(
    period: UsagePeriod | UsagePeriodArchive,
    source: MeteringPeriodView['source'],
    to: Date,
  ): MeteringPeriodView {
    const endAt = period.endAt ?? null
    const effectiveEnd = endAt ?? to
    return {
      id: period.id,
      source,
      sourcePeriodId: source === 'usage_period_archive' ? (period as UsagePeriodArchive).sourcePeriodId : undefined,
      boxId: period.boxId,
      organizationId: period.organizationId,
      region: period.region,
      startAt: period.startAt,
      endAt,
      kind: period.kind,
      cpu: period.cpu,
      mem: period.mem,
      disk: period.disk,
      gpu: period.gpu,
      durationSeconds: Math.max(0, (effectiveEnd.getTime() - period.startAt.getTime()) / 1000),
      active: endAt === null,
      actualCpuSeconds: period.actualCpuSeconds,
      actualRssAvgBytes: period.actualRssAvgBytes,
      actualRssPeakBytes: period.actualRssPeakBytes,
      sampleCount: period.sampleCount,
    }
  }

  private async recordLifecycleTransition(
    box: Box,
    state: BoxState,
    desiredState: BoxDesiredState,
    now: Date = new Date(),
  ): Promise<void> {
    try {
      await this.withBoxLock(box.id, async () => {
        await this.applyTransition(box, state, desiredState, now)
      })
    } catch (err) {
      this.logger.error(
        `usage ledger update failed for box ${box.id}`,
        err instanceof Error ? err.stack : String(err),
      )
    }
  }

  private async archiveClosedPeriods(closed: UsagePeriod[]): Promise<void> {
    await this.periods.manager.transaction(async (manager: EntityManager) => {
      await manager.save(UsagePeriodArchive, closed.map(UsagePeriodArchive.fromUsagePeriod))
      await manager.delete(
        UsagePeriod,
        closed.map((period) => period.id),
      )
    })
  }

  private async withBoxLock<T>(boxId: string, fn: () => Promise<T>): Promise<T> {
    const lockKey = this.boxLockKey(boxId)
    await this.redisLockProvider.waitForLock(lockKey, 60)
    try {
      return await fn()
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }

  private boxLockKey(boxId: string): string {
    return `usage-period:${boxId}`
  }
}
