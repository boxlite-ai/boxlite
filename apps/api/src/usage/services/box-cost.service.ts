/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectRepository } from '@nestjs/typeorm'
import { metrics, type Counter } from '@opentelemetry/api'
import { Repository } from 'typeorm'
import { RedisLockProvider } from '../../box/common/redis-lock.provider'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../../box/constants/box.constants'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { isBoxId } from '../../box/utils/box-id.util'
import { LogExecution } from '../../common/decorators/log-execution.decorator'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'
import { BoxCostDto } from '../dto/box-cost.dto'
import { BoxUsagePeriod } from '../entities/box-usage-period.entity'
import { BoxPricingClient } from './box-pricing.client'

/** How long after its last update an ended box may hold undelivered usage before it is reported. */
const OVERDUE_MINUTES = 15
const OVERDUE_LOCK_KEY = 'report-overdue-box-costs'
const OVERDUE_LOGGED_BOXES = 20

// Billing ends with the deletion request, and UsageService opens no period after it.
const ENDED_SQL = `b."desiredState" = '${BoxDesiredState.DESTROYED}'`

let overdueCounter: Counter | undefined

const getOverdueCounter = (): Counter => {
  if (!overdueCounter) {
    overdueCounter = metrics.getMeter('').createCounter('box_cost_overdue', {
      description: 'Ended boxes observed with usage still undelivered, counted once per check',
    })
  }
  return overdueCounter
}

interface UsageSnapshot {
  checkedAt: Date
  createdAt: Date | null
  ended: boolean | null
  unarchived: unknown[]
  undelivered: unknown[]
}

@Injectable()
export class BoxCostService {
  private readonly logger = new Logger(BoxCostService.name)

  constructor(
    @InjectRepository(BoxUsagePeriod)
    private readonly periodRepository: Repository<BoxUsagePeriod>,
    private readonly pricingClient: BoxPricingClient,
    private readonly redisLockProvider: RedisLockProvider,
  ) {}

  /**
   * Completeness is read before the price: a period delivered in between is then
   * reported by a later read, while the reverse order could call a partial cost final.
   */
  async getCost(boxId: string, organizationId: string): Promise<BoxCostDto> {
    if (!isBoxId(boxId) || organizationId === BOX_WARM_POOL_UNASSIGNED_ORGANIZATION) throw this.notFound(boxId)

    const snapshot = await this.readSnapshot(boxId, organizationId)
    const starts = [...snapshot.unarchived, ...snapshot.undelivered].map((start) => this.startTime(start))
    const through = new Date(Math.min(snapshot.checkedAt.getTime(), ...starts))
    const isFinal = starts.length === 0 && (snapshot.createdAt === null || snapshot.ended === true)

    const { lines, totalUsd } = await this.pricingClient.price(organizationId, boxId, through)
    const cost = {
      box_id: boxId,
      status: isFinal ? ('final' as const) : ('accruing' as const),
      source: 'calculated' as const,
      total_usd: totalUsd,
      lines,
      as_of: through.toISOString(),
    }
    if (!isFinal || lines.length > 0) return cost

    // With the box row gone, only usage proves that the organization owned the box.
    if (snapshot.createdAt === null) throw this.notFound(boxId)
    return {
      ...cost,
      total_usd: '0',
      lines: [
        {
          item: 'cpu',
          quantity: '0',
          unit: 'vcpu_second',
          amount_usd: '0',
          start: snapshot.createdAt.toISOString(),
          end: snapshot.createdAt.toISOString(),
        },
      ],
    }
  }

  /**
   * One statement, so one database snapshot: archiving moves a period to the
   * outbox in a transaction, and two reads could miss it in both tables.
   */
  private async readSnapshot(boxId: string, organizationId: string): Promise<UsageSnapshot> {
    const [snapshot] = await this.periodRepository.query(
      `SELECT now() AS "checkedAt", b."createdAt", ${ENDED_SQL} AS "ended",
         ARRAY(SELECT p."startAt" FROM "box_usage_periods" p
           WHERE p."boxId" = $1 AND p."organizationId" = $2) AS "unarchived",
         ARRAY(SELECT o."payload"->>'startAt' FROM "box_usage_export_outbox" o
           WHERE o."payload"->>'boxId' = $1 AND o."payload"->>'organizationId' = $2
             AND o."status" <> 'delivered') AS "undelivered"
       FROM (SELECT 1) AS request
       LEFT JOIN "box" b ON b."id" = $1 AND b."organizationId"::text = $2`,
      [boxId, organizationId],
    )
    return snapshot
  }

  /** A blocked row can hold an unreadable start; counting from the epoch then includes no later usage. */
  private startTime(value: unknown): number {
    const time = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN
    return Number.isFinite(time) ? time : 0
  }

  private notFound(boxId: string): NotFoundException {
    return new NotFoundException(`Box with ID ${boxId} not found`)
  }

  /** Blocked usage never recovers by itself, so its box would stay accruing without anyone noticing. */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: OVERDUE_LOCK_KEY })
  @LogExecution(OVERDUE_LOCK_KEY)
  @WithInstrumentation()
  async reportOverdue(): Promise<void> {
    // Left to expire: releasing it would let another instance count the same boxes again.
    if (!(await this.redisLockProvider.lock(OVERDUE_LOCK_KEY, 240))) return

    const overdue: { boxId: string }[] = await this.periodRepository.query(
      `WITH outstanding AS (
         SELECT "boxId" FROM "box_usage_periods" WHERE "organizationId" <> $1
         UNION
         SELECT "payload"->>'boxId' FROM "box_usage_export_outbox" WHERE "status" <> 'delivered'
       )
       SELECT o."boxId" FROM outstanding o
       LEFT JOIN "box" b ON b."id" = o."boxId"
       WHERE b."id" IS NULL OR (${ENDED_SQL} AND b."updatedAt" < now() - make_interval(mins => $2))
       ORDER BY o."boxId"`,
      [BOX_WARM_POOL_UNASSIGNED_ORGANIZATION, OVERDUE_MINUTES],
    )
    if (overdue.length === 0) return

    getOverdueCounter().add(overdue.length)
    const sample = overdue.slice(0, OVERDUE_LOGGED_BOXES).map(({ boxId }) => boxId)
    this.logger.error(`${overdue.length} ended boxes still have undelivered usage: ${sample.join(', ')}`)
  }
}
