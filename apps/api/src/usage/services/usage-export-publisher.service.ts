/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectRepository } from '@nestjs/typeorm'
import axios from 'axios'
import { In, Repository } from 'typeorm'
import { RedisLockProvider } from '../../box/common/redis-lock.provider'
import { LogExecution } from '../../common/decorators/log-execution.decorator'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'
import { TrackJobExecution } from '../../common/decorators/track-job-execution.decorator'
import { TrackableJobExecutions } from '../../common/interfaces/trackable-job-executions'
import { TypedConfigService } from '../../config/typed-config.service'
import { BoxUsageExportOutbox, UsageExportStatus } from '../entities/box-usage-export-outbox.entity'
import { USAGE_EXPORT_SCHEMA_VERSION } from '../usage-event'
import { UsageExportOutboxService } from './usage-export-outbox.service'

const PUBLISH_LOCK_KEY = 'publish-usage-exports'
const BACKFILL_LOCK_KEY = 'backfill-usage-exports'
const PRUNE_LOCK_KEY = 'prune-usage-exports'
const MAX_BACKOFF_MS = 15 * 60 * 1000

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
export class UsageExportPublisherService
  implements TrackableJobExecutions, OnApplicationBootstrap, OnApplicationShutdown
{
  activeJobs = new Set<string>()
  private readonly logger = new Logger(UsageExportPublisherService.name)

  constructor(
    @InjectRepository(BoxUsageExportOutbox)
    private readonly outboxRepository: Repository<BoxUsageExportOutbox>,
    private readonly outboxService: UsageExportOutboxService,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly configService: TypedConfigService,
  ) {}

  /**
   * Catches up on periods archived before this exporter existed. Detached on
   * purpose: a long archive must not hold up application start, and the work is
   * idempotent, so a restart mid-walk simply resumes from the beginning.
   */
  onApplicationBootstrap(): void {
    if (!this.configService.get('usageExport.enabled')) {
      return
    }

    void this.backfillArchivedPeriods().catch((error) => {
      this.logger.error(`Usage export backfill failed: ${this.describe(error)}`)
    })
  }

  async onApplicationShutdown(): Promise<void> {
    while (this.activeJobs.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  @Cron(CronExpression.EVERY_30_SECONDS, { name: PUBLISH_LOCK_KEY })
  @TrackJobExecution()
  @LogExecution(PUBLISH_LOCK_KEY)
  @WithInstrumentation()
  async publishPendingExports(): Promise<void> {
    if (!this.configService.get('usageExport.enabled')) {
      return
    }
    if (!(await this.redisLockProvider.lock(PUBLISH_LOCK_KEY, 60))) {
      return
    }

    try {
      const claimed = await this.claimBatch()
      if (claimed.length > 0) {
        await this.deliver(claimed)
      }
      await this.warnIfStalled()
    } finally {
      await this.redisLockProvider.unlock(PUBLISH_LOCK_KEY)
    }
  }

  @Cron(CronExpression.EVERY_HOUR, { name: PRUNE_LOCK_KEY })
  @TrackJobExecution()
  @LogExecution(PRUNE_LOCK_KEY)
  async pruneDeliveredExports(): Promise<void> {
    if (!this.configService.get('usageExport.enabled')) {
      return
    }
    if (!(await this.redisLockProvider.lock(PRUNE_LOCK_KEY, 300))) {
      return
    }

    try {
      const pruned = await this.outboxService.pruneDelivered(this.configService.get('usageExport.retentionDays'))
      if (pruned > 0) {
        this.logger.log(`Pruned ${pruned} delivered usage export rows`)
      }
    } finally {
      await this.redisLockProvider.unlock(PRUNE_LOCK_KEY)
    }
  }

  private async backfillArchivedPeriods(): Promise<void> {
    if (!(await this.redisLockProvider.lock(BACKFILL_LOCK_KEY, 3600))) {
      return
    }

    try {
      const result = await this.outboxService.backfill()
      if (result.enqueued > 0 || result.scanned > 0) {
        this.logger.log(`Usage export backfill scanned=${result.scanned} enqueued=${result.enqueued}`)
      }
    } finally {
      await this.redisLockProvider.unlock(BACKFILL_LOCK_KEY)
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
    const visibilityTimeoutMs = this.configService.get('usageExport.visibilityTimeoutMs')
    const batchSize = this.configService.get('usageExport.batchSize')

    // Wrapped in a CTE so the statement is a SELECT: a bare `UPDATE … RETURNING`
    // comes back from the driver as [rows, affectedCount], and mapping over that
    // tuple silently yields undefined payloads instead of events.
    return this.outboxRepository.query(
      `WITH claimed AS (
         UPDATE "box_usage_export_outbox"
         SET "attempts" = "attempts" + 1,
             "availableAt" = now() + ($1 || ' milliseconds')::interval,
             "updatedAt" = now()
         WHERE "id" IN (
           SELECT "id" FROM "box_usage_export_outbox"
           WHERE "status" = $2 AND "availableAt" <= now()
           ORDER BY "availableAt" ASC
           LIMIT $3
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *
       )
       SELECT * FROM claimed`,
      [visibilityTimeoutMs, UsageExportStatus.PENDING, batchSize],
    )
  }

  private async deliver(rows: BoxUsageExportOutbox[]): Promise<void> {
    const ids = rows.map((row) => row.id)

    try {
      await axios.post(
        `${this.configService.get('usageExport.url')}/internal/usage-events`,
        {
          schemaVersion: USAGE_EXPORT_SCHEMA_VERSION,
          events: rows.map((row) => row.payload),
        },
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
      { id: In(ids) },
      { status: UsageExportStatus.DELIVERED, deliveredAt: new Date(), lastError: null },
    )
    this.logger.log(`Delivered ${ids.length} usage export events`)
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
    const ids = rows.map((row) => row.id)
    const message = this.describe(error)
    const status = axios.isAxiosError(error) ? error.response?.status : undefined
    const permanent = status !== undefined && PERMANENT_REJECTION_STATUSES.has(status)
    const maxAttempts = this.configService.get('usageExport.maxAttempts')
    const exhausted = rows.every((row) => row.attempts >= maxAttempts)

    if (permanent || exhausted) {
      await this.outboxRepository.update({ id: In(ids) }, { status: UsageExportStatus.BLOCKED, lastError: message })
      this.logger.error(
        `Blocked ${ids.length} usage export events after ${permanent ? `HTTP ${status}` : `${maxAttempts} attempts`}: ${message}`,
      )
      return
    }

    const backoffMs = Math.min(MAX_BACKOFF_MS, 2 ** Math.max(0, rows[0].attempts - 1) * 30_000)
    await this.outboxRepository.update(
      { id: In(ids) },
      { availableAt: new Date(Date.now() + backoffMs), lastError: message },
    )
    this.logger.warn(`Deferred ${ids.length} usage export events for ${backoffMs}ms: ${message}`)
  }

  private async warnIfStalled(): Promise<void> {
    const oldestPendingAt = await this.outboxService.oldestPendingAt()
    if (!oldestPendingAt) {
      return
    }

    const ageMs = Date.now() - oldestPendingAt.getTime()
    if (ageMs > this.configService.get('usageExport.stallWarningMs')) {
      this.logger.warn(`Oldest undelivered usage export is ${Math.round(ageMs / 1000)}s old`)
    }
  }

  private describe(error: unknown): string {
    if (axios.isAxiosError(error)) {
      return `${error.code ?? 'HTTP'} ${error.response?.status ?? ''} ${error.message}`.trim()
    }
    return error instanceof Error ? error.message : String(error)
  }
}
