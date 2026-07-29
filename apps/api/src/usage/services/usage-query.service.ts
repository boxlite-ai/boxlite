/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { DataSource, FindOptionsWhere, IsNull, LessThan, MoreThan } from 'typeorm'
import { AggregatedUsageDto, BoxUsageDto, UsageChartPointDto, UsagePeriodDto } from '../dto/usage-response.dto'
import { BoxUsagePeriodArchive } from '../entities/box-usage-period-archive.entity'
import { BoxUsagePeriod } from '../entities/box-usage-period.entity'

const UTC_DAY_MS = 24 * 60 * 60 * 1000

type StoredUsagePeriod = BoxUsagePeriod | BoxUsagePeriodArchive

interface ClippedUsagePeriod {
  boxId: string
  startAt: Date
  endAt: Date
  cpu: number
  gpu: number
  mem: number
  disk: number
}

interface UsageFilter {
  organizationId: string
  from: Date
  to: Date
  boxId?: string
  region?: string
}

interface UsageChartAccumulator {
  bucketSeconds: number
  cpuSeconds: number
  diskGBSeconds: number
  ramGBSeconds: number
  time: string
}

@Injectable()
export class UsageQueryService {
  constructor(private readonly dataSource: DataSource) {}

  async getBoxUsagePeriods(organizationId: string, boxId: string, from: Date, to: Date): Promise<UsagePeriodDto[]> {
    const periods = await this.loadClippedPeriods({ organizationId, boxId, from, to })
    return periods.map((period) => ({
      cpu: period.cpu,
      diskGB: period.disk,
      endAt: period.endAt.toISOString(),
      gpu: period.gpu,
      // This API exposes the raw self-hosted ledger. Daytona's monetary
      // rating service is proprietary, so fabricating a rate here would be unsafe.
      price: 0,
      ramGB: period.mem,
      startAt: period.startAt.toISOString(),
    }))
  }

  async getAggregatedUsage(organizationId: string, from: Date, to: Date): Promise<AggregatedUsageDto> {
    const periods = await this.loadClippedPeriods({ organizationId, from, to })
    return this.aggregate(periods)
  }

  async getBoxUsage(organizationId: string, from: Date, to: Date): Promise<BoxUsageDto[]> {
    const periods = await this.loadClippedPeriods({ organizationId, from, to })
    const byBox = new Map<string, ClippedUsagePeriod[]>()

    for (const period of periods) {
      const boxPeriods = byBox.get(period.boxId) ?? []
      boxPeriods.push(period)
      byBox.set(period.boxId, boxPeriods)
    }

    return [...byBox.entries()]
      .sort(([leftBoxId], [rightBoxId]) => leftBoxId.localeCompare(rightBoxId))
      .map(([boxId, boxPeriods]) => {
        const totals = this.aggregate(boxPeriods)
        return {
          boxId,
          firstStart: totals.firstStart,
          lastEnd: totals.lastEnd,
          totalCPUSeconds: totals.totalCPUSeconds,
          totalDiskGBSeconds: totals.totalDiskGBSeconds,
          totalGPUSeconds: totals.totalGPUSeconds,
          totalPrice: totals.totalPrice,
          totalRAMGBSeconds: totals.totalRAMGBSeconds,
        }
      })
  }

  async getUsageChart(organizationId: string, from: Date, to: Date, region?: string): Promise<UsageChartPointDto[]> {
    const periods = await this.loadClippedPeriods({ organizationId, from, to, region })
    const buckets = new Map<number, UsageChartAccumulator>()

    for (const period of periods) {
      let cursorMs = period.startAt.getTime()
      const periodEndMs = period.endAt.getTime()

      while (cursorMs < periodEndMs) {
        const bucketDayStartMs = this.utcDayStart(cursorMs)
        const bucketStartMs = Math.max(bucketDayStartMs, from.getTime())
        const segmentEndMs = Math.min(bucketDayStartMs + UTC_DAY_MS, periodEndMs, to.getTime())
        const seconds = (segmentEndMs - cursorMs) / 1000
        const point = buckets.get(bucketStartMs) ?? {
          bucketSeconds: (Math.min(bucketDayStartMs + UTC_DAY_MS, to.getTime()) - bucketStartMs) / 1000,
          cpuSeconds: 0,
          diskGBSeconds: 0,
          ramGBSeconds: 0,
          time: new Date(bucketStartMs).toISOString(),
        }

        point.cpuSeconds += period.cpu * seconds
        point.diskGBSeconds += period.disk * seconds
        point.ramGBSeconds += period.mem * seconds
        buckets.set(bucketStartMs, point)
        cursorMs = segmentEndMs
      }
    }

    // The generated Daytona-compatible chart model has no GPU field. GPU
    // seconds remain available from the aggregate and per-box endpoints.
    return [...buckets.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, point]) => ({
        cpu: point.cpuSeconds / point.bucketSeconds,
        cpuPrice: 0,
        diskGB: point.diskGBSeconds / point.bucketSeconds,
        diskPrice: 0,
        ramGB: point.ramGBSeconds / point.bucketSeconds,
        ramPrice: 0,
        time: point.time,
      }))
  }

  private async loadClippedPeriods(filter: UsageFilter): Promise<ClippedUsagePeriod[]> {
    const activeIdentity = this.activeIdentity(filter)
    const archiveIdentity = this.archiveIdentity(filter)
    const evaluationTime = new Date()
    // Lifecycle archiving deletes from the active table and inserts into the
    // archive table in one transaction. A shared repeatable-read snapshot
    // ensures this reader sees the period on exactly one side of that move.
    const [activePeriods, archivedPeriods] = await this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      const active = await manager.getRepository(BoxUsagePeriod).find({
        where: [
          {
            ...activeIdentity,
            startAt: LessThan(filter.to),
            endAt: MoreThan(filter.from),
          },
          {
            ...activeIdentity,
            startAt: LessThan(filter.to),
            endAt: IsNull(),
          },
        ],
        order: { startAt: 'ASC', boxId: 'ASC' },
      })
      const archived = await manager.getRepository(BoxUsagePeriodArchive).find({
        where: {
          ...archiveIdentity,
          startAt: LessThan(filter.to),
          endAt: MoreThan(filter.from),
        },
        order: { startAt: 'ASC', boxId: 'ASC' },
      })
      return [active, archived] as const
    })

    return [...activePeriods, ...archivedPeriods]
      .map((period) => this.clipPeriod(period, filter.from, filter.to, evaluationTime))
      .filter((period): period is ClippedUsagePeriod => period !== null)
      .sort(
        (left, right) =>
          left.startAt.getTime() - right.startAt.getTime() ||
          left.endAt.getTime() - right.endAt.getTime() ||
          left.boxId.localeCompare(right.boxId),
      )
  }

  private activeIdentity(filter: UsageFilter): FindOptionsWhere<BoxUsagePeriod> {
    return {
      organizationId: filter.organizationId,
      ...(filter.boxId ? { boxId: filter.boxId } : {}),
      ...(filter.region ? { region: filter.region } : {}),
    }
  }

  private archiveIdentity(filter: UsageFilter): FindOptionsWhere<BoxUsagePeriodArchive> {
    return {
      organizationId: filter.organizationId,
      ...(filter.boxId ? { boxId: filter.boxId } : {}),
      ...(filter.region ? { region: filter.region } : {}),
    }
  }

  private clipPeriod(period: StoredUsagePeriod, from: Date, to: Date, evaluationTime: Date): ClippedUsagePeriod | null {
    const startMs = Math.max(period.startAt.getTime(), from.getTime())
    const endMs = period.endAt
      ? Math.min(period.endAt.getTime(), to.getTime())
      : Math.min(evaluationTime.getTime(), to.getTime())

    if (endMs <= startMs) {
      return null
    }

    return {
      boxId: period.boxId,
      startAt: new Date(startMs),
      endAt: new Date(endMs),
      cpu: period.cpu,
      gpu: period.gpu,
      mem: period.mem,
      disk: period.disk,
    }
  }

  private aggregate(periods: ClippedUsagePeriod[]): AggregatedUsageDto {
    let totalCPUSeconds = 0
    let totalGPUSeconds = 0
    let totalRAMGBSeconds = 0
    let totalDiskGBSeconds = 0
    let lastEndMs: number | null = null
    const boxIds = new Set<string>()

    for (const period of periods) {
      const seconds = (period.endAt.getTime() - period.startAt.getTime()) / 1000
      totalCPUSeconds += period.cpu * seconds
      totalGPUSeconds += period.gpu * seconds
      totalRAMGBSeconds += period.mem * seconds
      totalDiskGBSeconds += period.disk * seconds
      lastEndMs = Math.max(lastEndMs ?? period.endAt.getTime(), period.endAt.getTime())
      boxIds.add(period.boxId)
    }

    return {
      boxCount: boxIds.size,
      firstStart: periods[0]?.startAt.toISOString(),
      lastEnd: lastEndMs === null ? undefined : new Date(lastEndMs).toISOString(),
      totalCPUSeconds,
      totalDiskGBSeconds,
      totalGPUSeconds,
      // Keep the existing analytics contract while making the absence of a
      // self-hosted monetary rating policy explicit and deterministic.
      totalPrice: 0,
      totalRAMGBSeconds,
    }
  }

  private utcDayStart(timestampMs: number): number {
    const date = new Date(timestampMs)
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  }
}
