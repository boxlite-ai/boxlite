/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectRepository } from '@nestjs/typeorm'
import axios from 'axios'
import { In, Repository } from 'typeorm'
import { RedisLockProvider } from '../../box/common/redis-lock.provider'
import { LogExecution } from '../../common/decorators/log-execution.decorator'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'
import { TrackJobExecution } from '../../common/decorators/track-job-execution.decorator'
import { TrackableJobExecutions } from '../../common/interfaces/trackable-job-executions'
import { USAGE_EXPORT_VISIBILITY_TIMEOUT_MS } from '../../config/configuration'
import { TypedConfigService } from '../../config/typed-config.service'
import { BoxUsageExportOutbox, UsageExportStatus } from '../entities/box-usage-export-outbox.entity'
import { UsageExportOutboxService } from './usage-export-outbox.service'

const PUBLISH_LOCK_KEY = 'publish-usage-exports'
const MAX_BACKOFF_MS = 15 * 60 * 1000

/** How long delivered rows are kept for inspection before the idle sweep drops them. */
const RETENTION_DAYS = 30

/**
 * Statuses that mean the receiver will never accept this payload, however often
 * it is resent. Everything else — including the rest of the 4xx class — retries.
 */
const PERMANENT_REJECTION_STATUSES = new Set([400, 422])

/**
 * Delivers outbox rows to Commerce.
 *
 * Delivery is at-least-once by design; correctness lives in the consumer, which
 * deduplicates on the event key. Nothing here tries to make delivery
 * exactly-once — that is not achievable across a network, and pretending
 * otherwise is how usage gets billed twice. Every control below is therefore a
 * matter of efficiency and backpressure, not of correctness.
 */
@Injectable()
export class UsageExportPublisherService implements TrackableJobExecutions, OnApplicationShutdown {
  activeJobs = new Set<string>()
  private readonly logger = new Logger(UsageExportPublisherService.name)

  constructor(
    @InjectRepository(BoxUsageExportOutbox)
    private readonly outboxRepository: Repository<BoxUsageExportOutbox>,
    private readonly outboxService: UsageExportOutboxService,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly configService: TypedConfigService,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    while (this.activeJobs.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  /**
   * Drains the outbox, and sweeps delivered history when there is nothing left
   * to send. Folding retention into the idle branch keeps the exporter to one
   * schedule and one lock, and runs the sweep exactly when the database has
   * spare attention for it.
   */
  @Cron(CronExpression.EVERY_30_SECONDS, { name: PUBLISH_LOCK_KEY })
  @TrackJobExecution()
  @LogExecution(PUBLISH_LOCK_KEY)
  @WithInstrumentation()
  async publishPendingExports(): Promise<void> {
    if (!this.configService.get('usageExport.enabled')) {
      return
    }
    if (!(await this.redisLockProvider.lock(PUBLISH_LOCK_KEY, USAGE_EXPORT_VISIBILITY_TIMEOUT_MS / 1000))) {
      return
    }

    try {
      const claimed = await this.claimBatch()
      if (claimed.length > 0) {
        await this.deliver(claimed)
        return
      }

      const pruned = await this.outboxService.pruneDelivered(RETENTION_DAYS)
      if (pruned > 0) {
        this.logger.log(`Pruned ${pruned} delivered usage export rows`)
      }
    } finally {
      await this.redisLockProvider.unlock(PUBLISH_LOCK_KEY)
    }
  }

  /**
   * Takes ownership of a batch by pushing `availableAt` past a visibility
   * window, leaving the rows `pending`.
   *
   * Nothing marks the rows as in-flight: a crashed worker would strand such a
   * state forever and the usage would never be delivered, whereas an expired
   * visibility window merely produces a duplicate the consumer discards. Two
   * publishers cannot take the same row because the claim moves `availableAt`
   * out of the selection window inside the statement; `SKIP LOCKED` is what
   * keeps the second publisher from waiting on the first instead of moving on
   * to rows it can have.
   *
   * Public so the concurrency test can run claims against each other — the
   * publish cron takes a Redis lock first, which would serialise them.
   */
  async claimBatch(): Promise<BoxUsageExportOutbox[]> {
    // Wrapped in a CTE so the statement is a SELECT: a bare `UPDATE … RETURNING`
    // comes back from the driver as [rows, affectedCount], and mapping over that
    // tuple silently yields undefined payloads instead of events.
    // Claiming does not touch `attempts`. That counter is the retry budget, and
    // a budget spent by taking a row rather than by failing to deliver it would
    // be consumed by every crash, shutdown or lost lock between here and the
    // POST — none of which is evidence that Commerce rejected anything.
    return this.outboxRepository.query(
      `WITH claimed AS (
         UPDATE "box_usage_export_outbox"
         SET "availableAt" = now() + ($1 || ' milliseconds')::interval
         WHERE "eventKey" IN (
           SELECT "eventKey" FROM "box_usage_export_outbox"
           WHERE "status" = $2 AND "availableAt" <= now()
           ORDER BY "availableAt" ASC
           LIMIT $3
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *
       )
       SELECT * FROM claimed`,
      [USAGE_EXPORT_VISIBILITY_TIMEOUT_MS, UsageExportStatus.PENDING, this.configService.get('usageExport.batchSize')],
    )
  }

  private async deliver(rows: BoxUsageExportOutbox[]): Promise<void> {
    const eventKeys = rows.map((row) => row.eventKey)

    try {
      await axios.post(
        `${this.configService.get('usageExport.url')}/internal/usage-events`,
        { events: rows.map((row) => row.payload) },
        {
          timeout: this.configService.get('usageExport.timeoutMs'),
          headers: {
            authorization: `Bearer ${this.configService.get('usageExport.token')}`,
            'content-type': 'application/json',
          },
        },
      )
    } catch (error) {
      await this.recordFailure(rows, error)
      return
    }

    await this.outboxRepository.update(
      { eventKey: In(eventKeys) },
      { status: UsageExportStatus.DELIVERED, deliveredAt: new Date(), lastError: null },
    )
    this.logger.log(`Delivered ${eventKeys.length} usage export events`)
  }

  /**
   * A malformed payload is a defect, not a blip, so it is blocked at once
   * rather than retried until the attempt cap — retrying it only delays every
   * row behind it. Everything else stays pending and backs off.
   *
   * Only a payload the receiver can never accept counts as permanent. The rest
   * of the 4xx class is transient in exactly the situations this exporter meets
   * in practice — 401 during a token rotation, 404 before the receiver ships,
   * 408, 429 — and blocking on those would strand usage no path returns to
   * pending, which is the one failure direction this design exists to avoid.
   */
  private async recordFailure(rows: BoxUsageExportOutbox[], error: unknown): Promise<void> {
    const message = this.describe(error)
    const status = axios.isAxiosError(error) ? error.response?.status : undefined
    const permanent = status !== undefined && PERMANENT_REJECTION_STATUSES.has(status)
    const maxAttempts = this.configService.get('usageExport.maxAttempts')

    // Rows are judged one at a time. A batch is whatever the claim happened to
    // scoop up, so its members can carry different budgets; deciding for all of
    // them from the first row, or only when every row is spent, makes the
    // outcome depend on batch composition rather than on each row's own history.
    const blocked: string[] = []
    const deferredByAttempt = new Map<number, string[]>()
    for (const row of rows) {
      const attempt = row.attempts + 1
      if (permanent || attempt >= maxAttempts) {
        blocked.push(row.eventKey)
        continue
      }
      deferredByAttempt.set(attempt, [...(deferredByAttempt.get(attempt) ?? []), row.eventKey])
    }

    if (blocked.length > 0) {
      await this.outboxRepository.update(
        { eventKey: In(blocked) },
        { status: UsageExportStatus.BLOCKED, attempts: () => '"attempts" + 1', lastError: message },
      )
      this.logger.error(
        `Blocked ${blocked.length} usage export events after ${permanent ? `HTTP ${status}` : `${maxAttempts} attempts`}: ${message}`,
      )
    }

    for (const [attempt, eventKeys] of deferredByAttempt) {
      const backoffMs = Math.min(MAX_BACKOFF_MS, 2 ** Math.max(0, attempt - 1) * 30_000)
      await this.outboxRepository.update(
        { eventKey: In(eventKeys) },
        { attempts: attempt, availableAt: new Date(Date.now() + backoffMs), lastError: message },
      )
      this.logger.warn(`Deferred ${eventKeys.length} usage export events for ${backoffMs}ms: ${message}`)
    }
  }

  private describe(error: unknown): string {
    if (axios.isAxiosError(error)) {
      return `${error.code ?? 'HTTP'} ${error.response?.status ?? ''} ${error.message}`.trim()
    }
    return error instanceof Error ? error.message : String(error)
  }
}
