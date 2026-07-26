/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { IsNull, Repository } from 'typeorm'
import { Box } from '../box/entities/box.entity'
import { BoxEvents } from '../box/constants/box-events.constants'
import { BoxCreatedEvent } from '../box/events/box-create.event'
import { BoxStateUpdatedEvent } from '../box/events/box-state-updated.event'
import { BoxState } from '../box/enums/box-state.enum'
import { OnAsyncEvent } from '../common/decorators/on-async-event.decorator'
import { UsagePeriod } from './entities/usage-period.entity'
import { aggregatePeriods, BillablePeriod, planTransition, UsageTotals } from './billing/usage-math'

/** The analytics contract's per-box usage shape (`models.BoxUsage`). */
export interface BoxUsageResult extends UsageTotalsContract {
  boxId: string
}

interface UsageTotalsContract {
  totalCPUSeconds: number
  totalRAMGBSeconds: number
  totalDiskGBSeconds: number
  totalGPUSeconds: number
}

/**
 * Builds the alloc-side usage ledger from box lifecycle events and answers
 * usage queries. Pure billing math lives in `./billing/usage-math`; this
 * service is the thin event/DB wiring around it.
 */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name)

  constructor(
    @InjectRepository(UsagePeriod)
    private readonly periods: Repository<UsagePeriod>,
  ) {}

  @OnAsyncEvent({ event: BoxEvents.CREATED })
  async handleBoxCreated(event: BoxCreatedEvent): Promise<void> {
    // A box can be inserted directly at STARTED (box.service.ts), which emits
    // only CREATED — not STATE_UPDATED (an insert has no previous state). Open
    // the initial period here, or the running time before the first transition
    // is lost.
    try {
      await this.applyTransition(event.box, event.box.state, new Date())
    } catch (err) {
      // Metering must never break the box state machine — the CREATED emitter
      // is `emitAsync` (box.service.ts:248), so an uncaught throw here would
      // fail box creation outright. Log with stack and swallow; the
      // UsageReconcileService 5-min cron will pick up any orphaned periods.
      this.logger.error(
        `usage ledger open failed for box ${event.box?.id}`,
        err instanceof Error ? err.stack : String(err),
      )
    }
  }

  @OnAsyncEvent({ event: BoxEvents.STATE_UPDATED })
  async handleBoxStateUpdated(event: BoxStateUpdatedEvent): Promise<void> {
    try {
      await this.applyTransition(event.box, event.newState, new Date())
    } catch (err) {
      // Same guarantee: metering never breaks the state machine. STATE_UPDATED
      // is `emit` (box.repository.ts), so a throw here would become an
      // unhandled rejection — still log with stack and swallow; reconcile
      // cron is the safety net.
      this.logger.error(
        `usage ledger update failed for box ${event.box?.id}`,
        err instanceof Error ? err.stack : String(err),
      )
    }
  }

  /**
   * Apply one state transition to the box's period ledger (server clock = the
   * single authority). Closes the open period and/or opens a new one per
   * {@link planTransition}.
   */
  async applyTransition(box: Box, newState: BoxState, now: Date): Promise<void> {
    const open = await this.periods.findOne({
      where: { boxId: box.id, periodEnd: IsNull() },
      order: { periodStart: 'DESC' },
    })
    const openKind = open ? (open.kind as 'running' | 'stopped') : null
    const plan = planTransition(openKind, newState)

    if (plan.closeOpen && open) {
      open.periodEnd = now
      await this.periods.save(open)
    }
    if (plan.openKind) {
      await this.periods.save(
        this.periods.create({
          boxId: box.id,
          organizationId: box.organizationId,
          region: box.region,
          periodStart: now,
          periodEnd: null,
          kind: plan.openKind,
          allocCpu: box.cpu,
          allocMemGib: box.mem,
          allocDiskGib: box.disk,
          sealed: true,
        }),
      )
    }
  }

  /** Aggregate a box's usage over `[from, to]` into the analytics contract shape. */
  async getBoxUsage(boxId: string, from: Date, to: Date): Promise<BoxUsageResult> {
    const rows = await this.periods
      .createQueryBuilder('p')
      .where('p.boxId = :boxId', { boxId })
      .andWhere('p.periodStart <= :to', { to })
      .andWhere('(p.periodEnd IS NULL OR p.periodEnd >= :from)', { from })
      .getMany()

    const billable: BillablePeriod[] = rows.map((r) => ({
      startAt: r.periodStart,
      endAt: r.periodEnd,
      kind: r.kind as 'running' | 'stopped',
      allocCpu: r.allocCpu,
      allocMemGib: r.allocMemGib,
      allocDiskGib: r.allocDiskGib,
    }))

    const totals: UsageTotals = aggregatePeriods(billable, from, to)
    return {
      boxId,
      totalCPUSeconds: totals.totalCpuSeconds,
      totalRAMGBSeconds: totals.totalRamGbSeconds,
      totalDiskGBSeconds: totals.totalDiskGbSeconds,
      totalGPUSeconds: 0, // Phase 1: no GPU metering
    }
  }

  /**
   * Back-fill the actual (cgroup-measured) consumption the runner reports onto
   * the box's most-recent running period. Actual data feeds over-commit / COGS
   * only — never billing — so a miss is non-fatal. Last-write-wins: the Rust
   * accumulator is monotonic within a period, so the latest report is truth.
   */
  async recordActualUsage(boxId: string, actual: ActualUsageReport): Promise<void> {
    const period = await this.periods.findOne({
      where: { boxId, kind: 'running' },
      order: { periodStart: 'DESC' },
    })
    if (!period) {
      this.logger.warn(`actual usage for box ${boxId} dropped: no running period to attach to`)
      return
    }
    period.actualCpuSeconds = actual.actualCpuSeconds
    period.actualRssAvgBytes = actual.actualRssAvgBytes
    period.actualRssPeakBytes = actual.actualRssPeakBytes
    period.sampleCount = actual.sampleCount
    await this.periods.save(period)
  }
}

/** The runner's reported actual-usage snapshot for a box's current period. */
export interface ActualUsageReport {
  actualCpuSeconds: number
  actualRssAvgBytes: string // bigint serialized as string
  actualRssPeakBytes: string
  sampleCount: number
}
