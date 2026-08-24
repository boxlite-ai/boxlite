import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectRepository } from '@nestjs/typeorm'
import { metrics, type BatchObservableCallback } from '@opentelemetry/api'
import axios from 'axios'
import { EntityManager, Repository } from 'typeorm'
import { RedisLockProvider } from '../../box/common/redis-lock.provider'
import { LogExecution } from '../../common/decorators/log-execution.decorator'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'
import { TrackJobExecution } from '../../common/decorators/track-job-execution.decorator'
import { TrackableJobExecutions } from '../../common/interfaces/trackable-job-executions'
import { SIGNUP_CREDIT_LOCK_TIMEOUT_MS, SIGNUP_CREDIT_VISIBILITY_TIMEOUT_MS } from '../../config/configuration'
import { TypedConfigService } from '../../config/typed-config.service'
import { SignupCreditOutbox, SignupCreditOutboxStatus } from '../entities/signup-credit-outbox.entity'
import { SignupCreditOutboxService } from './signup-credit-outbox.service'

const PUBLISH_LOCK_KEY = 'publish-signup-credits'
const RETENTION_DAYS = 30
const MAX_BACKOFF_MS = 15 * 60 * 1000
const PERMANENT_REJECTION_STATUSES = new Set([400, 409, 422])
const meter = metrics.getMeter('')
const deliveryLatency = meter.createHistogram('signup_credit_delivery_latency_ms', {
  description: 'Time from Cloud eligibility observation to Commerce acknowledgement',
  unit: 'ms',
})
const deliveryOutcomes = meter.createCounter('signup_credit_delivery_total', {
  description: 'Signup-credit delivery outcomes observed by the Cloud publisher',
})
const outboxRows = meter.createObservableGauge('signup_credit_outbox_rows', {
  description: 'Current signup-credit outbox rows by lifecycle status',
  unit: '{row}',
})
const oldestPendingAge = meter.createObservableGauge('signup_credit_oldest_pending_age_ms', {
  description: 'Age of the oldest eligible pending signup-credit row',
  unit: 'ms',
})

type DeliveryResult =
  | { outcome: 'stale'; eventKey: string; reason: 'organization_deleted' | 'claim_stale' }
  | { outcome: 'delivered'; row: SignupCreditOutbox; deliveredAt: Date }
  | { outcome: 'blocked'; row: SignupCreditOutbox; status: number; message: string }
  | { outcome: 'deferred'; row: SignupCreditOutbox; status?: number; message: string; backoffMs: number }

@Injectable()
export class SignupCreditPublisherService implements TrackableJobExecutions, OnApplicationShutdown {
  activeJobs = new Set<string>()
  private readonly logger = new Logger(SignupCreditPublisherService.name)
  private readonly observeOutbox: BatchObservableCallback = async (result) => {
    try {
      const rows = (await this.repository.query(
        `SELECT "status", COUNT(*)::integer AS "count",
                CASE WHEN "status" = $1
                  THEN EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MIN("eligibleAt"))) * 1000
                  ELSE NULL
                END AS "oldestAgeMs"
         FROM "signup_credit_outbox"
         GROUP BY "status"`,
        [SignupCreditOutboxStatus.PENDING],
      )) as Array<{ status: SignupCreditOutboxStatus; count: number; oldestAgeMs: string | null }>
      const byStatus = new Map(rows.map((row) => [row.status, row]))
      for (const status of Object.values(SignupCreditOutboxStatus)) {
        result.observe(outboxRows, Number(byStatus.get(status)?.count ?? 0), { status })
      }
      const rawAgeMs = Number(byStatus.get(SignupCreditOutboxStatus.PENDING)?.oldestAgeMs ?? 0)
      result.observe(oldestPendingAge, Number.isFinite(rawAgeMs) ? Math.max(0, rawAgeMs) : 0)
    } catch (error) {
      this.logger.warn(`Could not observe signup-credit outbox metrics: ${this.describe(error)}`)
    }
  }

  constructor(
    @InjectRepository(SignupCreditOutbox)
    private readonly repository: Repository<SignupCreditOutbox>,
    private readonly outboxService: SignupCreditOutboxService,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly configService: TypedConfigService,
  ) {
    meter.addBatchObservableCallback(this.observeOutbox, [outboxRows, oldestPendingAge])
  }

  async onApplicationShutdown(): Promise<void> {
    meter.removeBatchObservableCallback(this.observeOutbox, [outboxRows, oldestPendingAge])
    while (this.activeJobs.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  @Cron(CronExpression.EVERY_5_SECONDS, { name: PUBLISH_LOCK_KEY, waitForCompletion: true })
  @TrackJobExecution()
  @LogExecution(PUBLISH_LOCK_KEY)
  @WithInstrumentation()
  async publishPendingCredits(): Promise<void> {
    if (!(await this.redisLockProvider.lock(PUBLISH_LOCK_KEY, SIGNUP_CREDIT_VISIBILITY_TIMEOUT_MS / 1000))) return

    try {
      if (this.configService.get('signupCredit.deliveryEnabled')) {
        const rows = await this.claimBatch()
        if (rows.length > 0) await this.deliverWithBoundedConcurrency(rows)
      }
    } finally {
      try {
        const pruned = await this.outboxService.pruneTerminal(RETENTION_DAYS)
        if (pruned > 0) this.logger.log(`Pruned ${pruned} terminal signup credit rows`)
      } finally {
        await this.redisLockProvider.unlock(PUBLISH_LOCK_KEY)
      }
    }
  }

  async claimBatch(): Promise<SignupCreditOutbox[]> {
    return this.repository.query(
      `WITH claimed AS (
         UPDATE "signup_credit_outbox"
         SET "availableAt" = now() + ($1 || ' milliseconds')::interval
         WHERE "eventKey" IN (
           SELECT "eventKey" FROM "signup_credit_outbox"
           WHERE "status" = $2 AND "availableAt" <= now()
           ORDER BY "availableAt" ASC
           LIMIT $3
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *
       )
       SELECT * FROM claimed`,
      [
        SIGNUP_CREDIT_VISIBILITY_TIMEOUT_MS,
        SignupCreditOutboxStatus.PENDING,
        this.configService.get('signupCredit.batchSize'),
      ],
    )
  }

  private async deliverWithBoundedConcurrency(rows: SignupCreditOutbox[]): Promise<void> {
    let nextIndex = 0
    const failures: unknown[] = []
    const worker = async (): Promise<void> => {
      while (nextIndex < rows.length) {
        const row = rows[nextIndex++]
        try {
          await this.deliverOne(row)
        } catch (error) {
          failures.push(error)
        }
      }
    }
    const workers = Array.from(
      { length: Math.min(rows.length, this.configService.get('signupCredit.concurrency')) },
      worker,
    )
    await Promise.all(workers)
    if (failures.length > 0) throw failures[0]
  }

  private async deliverOne(claimedRow: SignupCreditOutbox): Promise<void> {
    try {
      const result = await this.repository.manager.transaction(async (entityManager): Promise<DeliveryResult> => {
        await entityManager.query(`SET LOCAL lock_timeout = '${SIGNUP_CREDIT_LOCK_TIMEOUT_MS}ms'`)
        // Organization deletion locks the parent before its FK cascade reaches
        // the outbox. Take locks in that same order to avoid a parent/child
        // deadlock and to make the winner unambiguous.
        const organizations = await entityManager.query(`SELECT "id" FROM "organization" WHERE "id" = $1 FOR UPDATE`, [
          claimedRow.organizationId,
        ])
        if (organizations.length === 0) {
          return { outcome: 'stale', eventKey: claimedRow.eventKey, reason: 'organization_deleted' }
        }
        const rows = await entityManager.query(
          `SELECT outbox.*
           FROM "signup_credit_outbox" outbox
           WHERE outbox."eventKey" = $1
             AND outbox."status" = $2
             AND outbox."organizationId" = $3
           FOR UPDATE OF outbox`,
          [claimedRow.eventKey, SignupCreditOutboxStatus.PENDING, claimedRow.organizationId],
        )
        const row = rows[0] as SignupCreditOutbox | undefined
        if (!row) {
          return { outcome: 'stale', eventKey: claimedRow.eventKey, reason: 'claim_stale' }
        }
        return this.deliverLocked(entityManager, row)
      })
      this.reportCommittedResult(result)
    } catch (error) {
      if (!this.isLockTimeout(error)) throw error
      // claimBatch already moved availableAt by the visibility window. Avoid
      // touching the child row without its parent lock; the safe retry is the
      // existing visibility timeout after the contending transaction wins.
      deliveryOutcomes.add(1, { outcome: 'deferred', cause: 'lock_timeout' })
      this.logger.warn(`Deferred signup credit eventKey=${claimedRow.eventKey} after organization lock timeout`)
    }
  }

  /**
   * The caller holds write locks on both its organization and the outbox row,
   * acquired in the same parent-first order as organization deletion.
   * This makes delivery and organization deletion linearizable: whichever
   * transaction acquires those locks first is the winner.
   */
  private async deliverLocked(entityManager: EntityManager, row: SignupCreditOutbox): Promise<DeliveryResult> {
    let responseStatus: number
    try {
      const response = await axios.put(
        `${this.configService.get('signupCredit.url')}/internal/organizations/${row.organizationId}/signup-credit`,
        row.payload,
        {
          timeout: this.configService.get('signupCredit.timeoutMs'),
          headers: {
            authorization: `Bearer ${this.configService.get('signupCredit.token')}`,
            'content-type': 'application/json',
          },
        },
      )
      responseStatus = response.status
    } catch (error) {
      return this.recordFailure(entityManager, row, error)
    }
    if (responseStatus !== 204) {
      return this.recordFailure(
        entityManager,
        row,
        new Error(`Unexpected signup credit response status ${responseStatus}`),
      )
    }

    const deliveredAt = new Date()
    await entityManager.update(
      SignupCreditOutbox,
      { eventKey: row.eventKey, status: SignupCreditOutboxStatus.PENDING },
      { status: SignupCreditOutboxStatus.DELIVERED, deliveredAt, lastError: null },
    )
    return { outcome: 'delivered', row, deliveredAt }
  }

  private async recordFailure(
    entityManager: EntityManager,
    row: SignupCreditOutbox,
    error: unknown,
  ): Promise<DeliveryResult> {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined
    const message = this.describe(error)
    const attempt = row.attempts + 1

    if (status !== undefined && PERMANENT_REJECTION_STATUSES.has(status)) {
      await entityManager.update(
        SignupCreditOutbox,
        { eventKey: row.eventKey, status: SignupCreditOutboxStatus.PENDING },
        { status: SignupCreditOutboxStatus.BLOCKED, attempts: attempt, lastError: message },
      )
      return { outcome: 'blocked', row, status, message }
    }

    const exponent = Math.min(20, Math.max(0, attempt - 1))
    const backoffMs = Math.min(MAX_BACKOFF_MS, 2 ** exponent * 5_000)
    await entityManager.update(
      SignupCreditOutbox,
      { eventKey: row.eventKey, status: SignupCreditOutboxStatus.PENDING },
      { attempts: attempt, availableAt: new Date(Date.now() + backoffMs), lastError: message },
    )
    return { outcome: 'deferred', row, status, message, backoffMs }
  }

  /** Emit delivery telemetry only after the surrounding database COMMIT. */
  private reportCommittedResult(result: DeliveryResult): void {
    if (result.outcome === 'stale') {
      deliveryOutcomes.add(1, { outcome: 'stale', reason: result.reason })
      this.logger.debug(`Skipped ${result.reason} for signup credit eventKey=${result.eventKey}`)
      return
    }
    if (result.outcome === 'delivered') {
      if (result.row.eligibleAt && result.row.eligibilityKind) {
        deliveryLatency.record(Math.max(0, result.deliveredAt.getTime() - result.row.eligibleAt.getTime()), {
          eligibility_kind: result.row.eligibilityKind,
        })
      }
      deliveryOutcomes.add(1, { outcome: 'delivered' })
      this.logger.log(`Delivered signup credit eventKey=${result.row.eventKey}`)
      return
    }
    if (result.outcome === 'blocked') {
      deliveryOutcomes.add(1, { outcome: 'blocked', http_status: result.status })
      this.logger.error(
        `Blocked signup credit eventKey=${result.row.eventKey} after HTTP ${result.status}: ${result.message}`,
      )
      return
    }
    deliveryOutcomes.add(1, { outcome: 'deferred', http_status: result.status ?? 0 })
    this.logger.warn(
      `Deferred signup credit eventKey=${result.row.eventKey} for ${result.backoffMs}ms: ${result.message}`,
    )
  }

  private describe(error: unknown): string {
    if (axios.isAxiosError(error)) {
      return `${error.code ?? 'HTTP'} ${error.response?.status ?? ''} ${error.message}`.trim()
    }
    return error instanceof Error ? error.message : String(error)
  }

  private isLockTimeout(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03'
  }
}
