import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import axios from 'axios'
import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { TypedConfigService } from '../config/typed-config.service'
import { BusinessEventOutbox } from './business-event-outbox.entity'
import { parseBusinessEventReceipt, retryDelayMs } from './business-event-receipt'
import { BusinessEventsConfig } from './business-events.config'

@Injectable()
export class BusinessEventPublisherService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(BusinessEventPublisherService.name)
  private readonly settings: BusinessEventsConfig
  private timer?: NodeJS.Timeout
  private active?: Promise<void>
  private stopping = false
  private readonly requests = new Set<AbortController>()

  constructor(
    private readonly dataSource: DataSource,
    config: TypedConfigService,
  ) {
    this.settings = config.getOrThrow('businessEvents')
  }

  onApplicationBootstrap(): void {
    if (this.settings.enabled) this.schedule()
  }

  /** Also used by controlled operations/tests; never overlaps cycles within one worker. */
  async publishOnce(): Promise<void> {
    if (this.stopping || !this.settings.enabled) return
    if (this.active) return this.active
    this.active = this.publishBatch()
    try {
      await this.active
    } finally {
      this.active = undefined
    }
  }

  private schedule(): void {
    if (this.stopping) return
    this.timer = setTimeout(async () => {
      try {
        await this.publishOnce()
      } catch (error) {
        this.logger.error({ message: 'Business event publish cycle failed', code: error.code ?? error.name })
      } finally {
        this.schedule()
      }
    }, this.settings.intervalMs)
    this.timer.unref()
  }

  private async claim(): Promise<BusinessEventOutbox[]> {
    return this.dataSource.transaction(async (em) => {
      await em.query("SET LOCAL statement_timeout = '5s'")
      return em.query(
        `WITH due AS (
        SELECT "eventId" FROM "organization_business_event_outbox"
        WHERE status = 'pending' AND "availableAt" <= CURRENT_TIMESTAMP
        ORDER BY "availableAt", "eventId" LIMIT $1 FOR UPDATE SKIP LOCKED
      ), claimed AS (UPDATE "organization_business_event_outbox" AS queue
      SET "availableAt" = CURRENT_TIMESTAMP + $2 * INTERVAL '1 millisecond', "claimToken" = $3
      FROM due WHERE queue."eventId" = due."eventId" RETURNING queue.*)
      SELECT * FROM claimed`,
        [this.settings.batchSize, this.settings.visibilityMs, randomUUID()],
      )
    })
  }

  private async publishBatch(): Promise<void> {
    const rows = await this.claim()
    let next = 0
    const worker = async () => {
      while (!this.stopping && next < rows.length) {
        const row = rows[next++]
        await this.deliver(row)
      }
    }
    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(rows.length, this.settings.concurrency) }, worker),
    )
    const failures = workers.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Business event batch failed',
      )
    const [backlog] = await this.dataSource.query(`SELECT
      count(*) FILTER (WHERE status = 'blocked')::int AS "blockedCount",
      extract(epoch FROM CURRENT_TIMESTAMP - min("createdAt") FILTER (WHERE status = 'pending')) AS "oldestPendingSeconds"
      FROM "organization_business_event_outbox"`)
    const [registrations] = await this.dataSource.query(`SELECT count(*)::int AS "pendingRegistrationCount",
      extract(epoch FROM CURRENT_TIMESTAMP - min("createdAt")) AS "oldestPendingRegistrationSeconds"
      FROM "user_registration" WHERE status = 'pending_verification'`)
    this.logger.log({ message: 'Business event backlog', ...backlog, ...registrations })
  }

  private async deliver(row: BusinessEventOutbox): Promise<void> {
    const controller = new AbortController()
    this.requests.add(controller)
    let status: number | undefined
    let retryAfter: string | undefined
    try {
      const response = await axios.post(
        this.settings.url + '/internal/organization/' + encodeURIComponent(row.organizationId) + '/billing-events',
        row.payload,
        {
          headers: { Authorization: 'Bearer ' + this.settings.token, 'Content-Type': 'application/json' },
          timeout: this.settings.timeoutMs,
          signal: controller.signal,
          maxRedirects: 0,
          maxContentLength: 64 * 1024,
          validateStatus: () => true,
        },
      )
      status = response.status
      retryAfter = response.headers['retry-after']
      const receipt = status === 200 ? parseBusinessEventReceipt(response.data, row.eventId, row.organizationId) : null
      if (receipt) {
        const result = await this.dataSource.getRepository(BusinessEventOutbox).update(
          { eventId: row.eventId, status: 'pending', claimToken: row.claimToken },
          {
            status: 'delivered',
            deliveredAt: new Date(),
            responseSnapshot: receipt,
            lastError: null,
            claimToken: null,
          },
        )
        if (result.affected)
          this.logResult(row, { status, outcome: receipt.outcome, reason: receipt.reason, replayed: receipt.replayed })
        return
      }
    } catch (error) {
      // A shutdown leaves the original lease recoverable without spending the failure budget.
      if (this.stopping && controller.signal.aborted) return
      this.logResult(row, { transportError: error.code ?? 'network_error' })
    } finally {
      this.requests.delete(controller)
    }

    const attempts = row.attempts + 1
    const blocked = [400, 401, 409, 413].includes(status) || attempts >= this.settings.maxAttempts
    const availableAt = new Date(Date.now() + retryDelayMs(attempts, this.settings.maxBackoffMs, retryAfter))
    const lastError = status ? 'http_' + status + (status === 200 ? '_invalid_receipt' : '') : 'network_or_timeout'
    const result = await this.dataSource
      .getRepository(BusinessEventOutbox)
      .update(
        { eventId: row.eventId, status: 'pending', claimToken: row.claimToken },
        { attempts, status: blocked ? 'blocked' : 'pending', availableAt, lastError, claimToken: null },
      )
    if (result.affected)
      this.logResult(row, { status, attempts, outcome: blocked ? 'blocked' : 'retry', lastError, availableAt })
  }

  private logResult(row: BusinessEventOutbox, result: Record<string, unknown>): void {
    this.logger.log({
      message: 'Business event delivery',
      eventId: row.eventId,
      registrationId: row.payload.data.registrationId,
      organizationId: row.organizationId,
      attempt: row.attempts + 1,
      ...result,
    })
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true
    clearTimeout(this.timer)
    for (const request of this.requests) request.abort()
    let deadline: NodeJS.Timeout
    try {
      await Promise.race([
        this.active,
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, this.settings.timeoutMs + 5_000)
        }),
      ])
    } finally {
      clearTimeout(deadline)
    }
  }
}
