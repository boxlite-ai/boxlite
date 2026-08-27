/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, Injectable } from '@nestjs/common'
import { DataSource } from 'typeorm'
import {
  UsageConcurrencyGranularity,
  UsageConcurrencyPointDto,
  UsageConcurrencySeriesDto,
} from '../dto/usage-concurrency.dto'

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_RANGE_MS: Record<UsageConcurrencyGranularity, number> = {
  [UsageConcurrencyGranularity.HOUR]: 7 * DAY_MS,
  [UsageConcurrencyGranularity.DAY]: 90 * DAY_MS,
}
const SQL_INTERVAL: Record<UsageConcurrencyGranularity, string> = {
  [UsageConcurrencyGranularity.HOUR]: '1 hour',
  [UsageConcurrencyGranularity.DAY]: '1 day',
}

interface ConcurrencyRow {
  observedAt: Date | string
  runningBoxes: number | string
}

/**
 * Reads the metering ledger as one timeline. The hot/archive split is a storage
 * concern: closed rows move between the tables in one transaction, so their
 * union is the complete committed history without a second sampling table.
 */
@Injectable()
export class UsageConcurrencyService {
  constructor(private readonly dataSource: DataSource) {}

  async getSeries(
    organizationId: string,
    from: Date,
    to: Date,
    granularity: UsageConcurrencyGranularity,
    now = new Date(),
  ): Promise<UsageConcurrencySeriesDto> {
    this.validateRange(from, to, granularity, now)

    const rows: ConcurrencyRow[] = await this.dataSource.query(
      `WITH periods AS MATERIALIZED (
         SELECT "boxId", "startAt", "endAt"
           FROM "box_usage_periods"
          WHERE "organizationId" = $1
            AND "cpu" > 0
            AND "startAt" <= $3
            AND ("endAt" IS NULL OR "endAt" > $2)
         UNION ALL
         SELECT "boxId", "startAt", "endAt"
           FROM "box_usage_periods_archive"
          WHERE "organizationId" = $1
            AND "cpu" > 0
            AND "startAt" <= $3
            AND "endAt" > $2
       ), moments AS (
         SELECT generate_series($2::timestamptz, $3::timestamptz, $4::interval) AS "observedAt"
         UNION
         SELECT $3::timestamptz AS "observedAt"
       )
       SELECT moments."observedAt", COUNT(DISTINCT periods."boxId")::integer AS "runningBoxes"
         FROM moments
         LEFT JOIN periods
           ON periods."startAt" <= moments."observedAt"
          AND (periods."endAt" IS NULL OR periods."endAt" > moments."observedAt")
        GROUP BY moments."observedAt"
        ORDER BY moments."observedAt" ASC`,
      [organizationId, from, to, SQL_INTERVAL[granularity]],
    )

    const points: UsageConcurrencyPointDto[] = rows.map((row) => ({
      observedAt: new Date(row.observedAt),
      runningBoxes: Number(row.runningBoxes),
    }))

    return {
      from,
      to,
      granularity,
      current: points.at(-1)?.runningBoxes ?? 0,
      points,
    }
  }

  private validateRange(from: Date, to: Date, granularity: UsageConcurrencyGranularity, now: Date): void {
    const rangeMs = to.getTime() - from.getTime()
    if (rangeMs <= 0) {
      throw new BadRequestException('Concurrency timeline `from` must be earlier than `to`')
    }
    if (rangeMs > MAX_RANGE_MS[granularity]) {
      const maximumDays = MAX_RANGE_MS[granularity] / DAY_MS
      throw new BadRequestException(`Concurrency timeline ${granularity} range cannot exceed ${maximumDays} days`)
    }
    if (to.getTime() > now.getTime()) {
      throw new BadRequestException('Concurrency timeline `to` cannot be in the future')
    }
  }
}
