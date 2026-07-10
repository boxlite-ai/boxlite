/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { FindOptionsWhere, IsNull, LessThan, MoreThan, Repository } from 'typeorm'
import { UsagePeriodArchive } from './entities/usage-period-archive.entity'
import { UsagePeriod } from './entities/usage-period.entity'
import { UsagePeriodKind, UsageTotals, aggregateUsagePeriods } from './metering/usage-period-math'

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
  source: 'box_usage_period' | 'box_usage_period_archive'
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
export class UsageMeteringService {
  constructor(
    @InjectRepository(UsagePeriod)
    private readonly periods: Repository<UsagePeriod>,
    @InjectRepository(UsagePeriodArchive)
    private readonly archives: Repository<UsagePeriodArchive>,
  ) {}

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
      this.periods.find({ where: activeWhere, order: { startAt: 'DESC' }, take: limit }),
      this.archives.find({ where: archivedWhere, order: { startAt: 'DESC' }, take: limit }),
    ])

    const activePeriods = activeRows.map((period) => this.toMeteringPeriodView(period, 'box_usage_period', to))
    const archivedPeriods = archivedRows.map((period) =>
      this.toMeteringPeriodView(period, 'box_usage_period_archive', to),
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

    return [
      { ...base, endAt: IsNull() },
      { ...base, endAt: MoreThan(from) },
    ]
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
      sourcePeriodId: source === 'box_usage_period_archive' ? (period as UsagePeriodArchive).sourcePeriodId : undefined,
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
}
