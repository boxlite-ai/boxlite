/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectRepository } from '@nestjs/typeorm'
import { In, IsNull, Repository } from 'typeorm'
import { Box } from '../box/entities/box.entity'
import { Runner } from '../box/entities/runner.entity'
import { RunnerState } from '../box/enums/runner-state.enum'
import { UsagePeriod } from './entities/usage-period.entity'
import { planReconcileClose } from './billing/usage-math'

/**
 * Safety net for open usage periods that never got their close event — the
 * runner-death / host-reboot / API-crash cases (07 · A/B). Box lifecycle events
 * close periods on the happy path; this sweep force-closes the ones that fell
 * through, so a period is never left open forever (unbounded over-count).
 *
 * Pure decision logic + close-time clamping live in {@link planReconcileClose}
 * (unit-tested); this service is the thin DB wiring around it. Closed rows are
 * marked `sealed = false` so billing can treat them as suspect.
 */
@Injectable()
export class UsageReconcileService {
  private readonly logger = new Logger(UsageReconcileService.name)
  private sweeping = false

  constructor(
    @InjectRepository(UsagePeriod)
    private readonly periods: Repository<UsagePeriod>,
    @InjectRepository(Box)
    private readonly boxes: Repository<Box>,
    @InjectRepository(Runner)
    private readonly runners: Repository<Runner>,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweep(): Promise<void> {
    if (this.sweeping) {
      // A previous sweep is still running (slow DB); skip rather than overlap.
      return
    }
    this.sweeping = true
    try {
      await this.reconcileOpenPeriods()
    } catch (err) {
      this.logger.error(`usage reconcile sweep failed: ${err}`)
    } finally {
      this.sweeping = false
    }
  }

  /** One pass: close every stuck open period that can no longer legitimately be open. */
  private async reconcileOpenPeriods(): Promise<void> {
    const open = await this.periods.find({ where: { periodEnd: IsNull() } })
    if (open.length === 0) {
      return
    }

    // Batch-load the boxes and their runners (open periods ≈ running box count).
    const boxes = await this.boxes.find({ where: { id: In(open.map((p) => p.boxId)) } })
    const boxById = new Map(boxes.map((b) => [b.id, b]))

    const runnerIds = [...new Set(boxes.map((b) => b.runnerId).filter((id): id is string => !!id))]
    const runnerById = runnerIds.length
      ? new Map((await this.runners.find({ where: { id: In(runnerIds) } })).map((r) => [r.id, r]))
      : new Map<string, Runner>()

    const now = new Date()
    let closed = 0

    for (const period of open) {
      const box = boxById.get(period.boxId) ?? null
      const runner = box?.runnerId ? runnerById.get(box.runnerId) : undefined
      // Treat as alive unless we positively observe UNRESPONSIVE — never
      // force-close just because a runner row failed to load.
      const runnerAlive = !(runner && runner.state === RunnerState.UNRESPONSIVE)

      const plan = planReconcileClose({
        openKind: period.kind as 'running' | 'stopped',
        periodStart: period.periodStart,
        box: box ? { state: box.state, updatedAt: box.updatedAt } : null,
        runnerAlive,
        lastAliveAt: runner?.lastChecked ?? null,
        now,
      })
      if (!plan) {
        continue
      }

      try {
        // Conditional update — reconcile always *loses* to the live event path.
        // Only writes if the period is STILL open (a concurrent STATE_UPDATED may
        // have closed it first), and only touches periodEnd/sealed — never a
        // full-row save, which would clobber actual_* the runner just ingested
        // with our stale in-memory copy. This also makes the sweep idempotent
        // across API replicas (first writer wins, the rest are affected=0).
        const res = await this.periods.update(
          { id: period.id, periodEnd: IsNull() },
          { periodEnd: plan.closeAt, sealed: false },
        )
        if (res.affected && res.affected > 0) {
          closed++
        }
      } catch (err) {
        // Don't let one bad row abort the whole sweep.
        this.logger.warn(`reconcile failed to close period ${period.id} (box ${period.boxId}): ${err}`)
      }
    }

    if (closed > 0) {
      this.logger.log(`usage reconcile: force-closed ${closed}/${open.length} stuck open period(s)`)
    }
  }
}
