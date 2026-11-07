/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import axios from 'axios'
import { Not, QueryFailedError } from 'typeorm'
import { Context } from '../../common/context/context'
import { PlatformReason } from '../../common/context/platform-reason.enum'
import { TypedConfigService } from '../../config/typed-config.service'
import { RedisLockProvider, withRedisLockLease } from '../common/redis-lock.provider'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../constants/box.constants'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { BoxRepository } from '../repositories/box.repository'
import { BoxService } from './box.service'

const POLL_NAME = 'commerce-billing-state'
const REQUEST_TIMEOUT_MS = 2_000
const STOP_LOCK_TIMEOUT_MS = 500
const SNAPSHOT_WINDOW_MS = 30_000
const SWEEP_BUDGET_MS = 120_000
const RUNNING = { state: BoxState.STARTED, desiredState: BoxDesiredState.STARTED, pending: false }

type BillingState = {
  organizationId: string
  billingState: 'POSITIVE' | 'ZERO' | 'NEGATIVE' | 'ERROR'
  evaluatedAt: string
  errorCode?: string
}

type PollCounts = { orgCount: number; failureCount: number; stopAcceptedCount: number }

/** Runs automated stop requests through the normal Box lifecycle. */
@Injectable()
export class BoxBillingStateService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(BoxBillingStateService.name)
  private readonly shutdown = new AbortController()
  private running?: Promise<void>

  constructor(
    private readonly config: TypedConfigService,
    private readonly boxRepository: BoxRepository,
    private readonly boxService: BoxService,
    private readonly locks: RedisLockProvider,
  ) {}

  async beforeApplicationShutdown(): Promise<void> {
    this.shutdown.abort()
    await this.running
  }

  @Cron(CronExpression.EVERY_30_SECONDS, { name: POLL_NAME, waitForCompletion: true })
  async reconcile(): Promise<void> {
    if (!this.config.get('billingApiUrl') || this.shutdown.signal.aborted || this.running) return

    this.running = this.poll().catch((error) => {
      this.logger.error({ event: 'billing_poll_failed', reason: this.failureReason(error) })
    })
    try {
      await this.running
    } finally {
      this.running = undefined
    }
  }

  private async poll(): Promise<void> {
    const baseUrl = this.config.get('usageExport.url')
    const token = this.config.get('usageExport.token')
    // Startup validates this pair even when usage export itself is disabled.
    if (!baseUrl || !token) throw new Error('Internal service URL and authentication are required')
    const lease = await this.locks.acquireLease(POLL_NAME, 30)
    if (!lease) return

    await withRedisLockLease(
      lease,
      async (leaseSignal) => {
        const signal = AbortSignal.any([leaseSignal, this.shutdown.signal])
        signal.throwIfAborted()
        const startedAt = Date.now()
        const { data } = await axios.get<unknown>(`${baseUrl}/internal/billing-states`, {
          headers: { authorization: `Bearer ${token}` },
          timeout: REQUEST_TIMEOUT_MS,
          maxRedirects: 0,
          signal,
        })
        signal.throwIfAborted()
        const observedAt = new Date().toISOString()
        const counts: PollCounts = { orgCount: 0, failureCount: 0, stopAcceptedCount: 0 }
        const states = this.collectNegativeStates(data, counts)
        const boxes = states.size
          ? await this.boxRepository.find({
              where: { ...RUNNING, organizationId: Not(BOX_WARM_POOL_UNASSIGNED_ORGANIZATION) },
              select: { id: true, organizationId: true },
              order: { createdAt: 'ASC', id: 'ASC' },
            })
          : []

        for (const box of boxes) {
          signal.throwIfAborted()
          const ageMs = Date.now() - startedAt
          if (ageMs >= SNAPSHOT_WINDOW_MS) {
            this.logger.warn({ event: 'billing_snapshot_expired', ageMs })
            break
          }
          const state = states.get(box.organizationId)
          if (!state) continue

          const evidence = { ...state, observedAt, boxId: box.id }
          const stopStartedAt = Date.now()
          try {
            await this.boxService.stop(
              box.id,
              box.organizationId,
              Context.platform(PlatformReason.BILLING_NEGATIVE, { lockTimeoutMs: STOP_LOCK_TIMEOUT_MS }),
            )
            counts.stopAcceptedCount++
            this.logger.log({ event: 'billing_stop_accepted', ...evidence, durationMs: Date.now() - stopStartedAt })
          } catch (error) {
            counts.failureCount++
            this.logger.warn({ event: 'billing_stop_failed', ...evidence, reason: this.failureReason(error) })
          }
        }
        signal.throwIfAborted()
        const durationMs = Date.now() - startedAt
        this.logger.log({ event: 'billing_poll_completed', ...counts, durationMs })
        if (durationMs > SWEEP_BUDGET_MS) {
          this.logger.warn({ event: 'billing_poll_slow', ...counts, durationMs, budgetMs: SWEEP_BUDGET_MS })
        }
      },
      (error) => this.logger.error({ event: 'billing_lock_release_failed', reason: this.failureReason(error) }),
    )
  }

  private collectNegativeStates(data: unknown, counts: PollCounts): Map<string, BillingState> {
    const states = new Map<string, BillingState>()
    if (!Array.isArray(data)) {
      counts.failureCount++
      this.logger.error({ event: 'billing_state_failed', reason: 'invalid_response' })
      return states
    }
    counts.orgCount = data.length
    for (const entry of data) {
      if (!this.isBillingState(entry)) {
        counts.failureCount++
        this.logger.error({ event: 'billing_state_failed', reason: 'invalid_response' })
        continue
      }
      const { organizationId, billingState, evaluatedAt } = entry
      const state = { organizationId, billingState, evaluatedAt }
      if (entry.billingState === 'ERROR') {
        counts.failureCount++
        this.logger.error({ event: 'billing_state_unavailable', ...state, errorCode: entry.errorCode })
      } else {
        this.logger.debug({ event: 'billing_state_checked', ...state })
        if (entry.billingState === 'NEGATIVE' && entry.organizationId !== BOX_WARM_POOL_UNASSIGNED_ORGANIZATION) {
          states.set(organizationId, state)
        }
      }
    }
    return states
  }

  private isBillingState(value: unknown): value is BillingState {
    if (!value || typeof value !== 'object') return false
    const state = value as Record<string, unknown>
    return (
      typeof state.organizationId === 'string' &&
      state.organizationId.length > 0 &&
      ['POSITIVE', 'ZERO', 'NEGATIVE', 'ERROR'].includes(state.billingState as string) &&
      typeof state.evaluatedAt === 'string' &&
      Number.isFinite(Date.parse(state.evaluatedAt)) &&
      (state.billingState === 'ERROR' ? typeof state.errorCode === 'string' : state.errorCode === undefined)
    )
  }

  private failureReason(error: unknown): string {
    if (error instanceof QueryFailedError && error.driverError.code === '55P03') return 'lock_timeout'
    // Axios errors carry Authorization headers and response bodies; never log them.
    if (axios.isAxiosError(error)) {
      return error.response ? `HTTP ${error.response.status}` : (error.code ?? 'transport_error')
    }
    return error instanceof Error ? error.name : 'unknown_error'
  }
}
