/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectRepository } from '@nestjs/typeorm'
import { randomUUID } from 'node:crypto'
import { EntityManager, LessThanOrEqual, QueryFailedError, Repository } from 'typeorm'
import { TypedConfigService } from '../../config/typed-config.service'
import { PaymentProviderEvent } from '../entities/payment-provider-event.entity'
import { TopUpRecord } from '../entities/top-up-record.entity'
import { WalletTransaction } from '../entities/wallet-transaction.entity'
import { BillingStatus, Wallet } from '../entities/wallet.entity'
import { WalletService } from '../wallet.service'
import { SubscriptionService } from '../subscription/subscription.service'
import {
  PAYMENT_PROVIDER,
  PaymentProvider,
  PaymentSetupResult,
  ProviderWebhookEvent,
  TopUpPaymentInput,
  TopUpPaymentResult,
} from './payment-provider'

const MIN_TOP_UP_CENTS = 500n
const MIN_AUTO_RELOAD_SPREAD_CENTS = 1000n
const AUTO_RELOAD_RETRY_MILLISECONDS = 15 * 60 * 1000
const INITIAL_RECONCILE_DELAY_MILLISECONDS = 60 * 1000
const MAX_RECONCILE_DELAY_MILLISECONDS = 60 * 60 * 1000
const RECOVERY_BATCH_SIZE = 100
const PG_UNIQUE_VIOLATION = '23505'

export interface AutoReloadInput {
  enabled: boolean
  thresholdCents: string | null
  targetCents: string | null
}

export interface BillingReceipt {
  id: string
  createdAt: string
  amountCents: string
  type: 'top_up' | 'usage'
  status: 'paid' | 'failed'
  receiptUrl: string | null
}

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name)

  constructor(
    @InjectRepository(Wallet)
    private readonly wallets: Repository<Wallet>,
    @InjectRepository(TopUpRecord)
    private readonly topUps: Repository<TopUpRecord>,
    private readonly walletService: WalletService,
    @Inject(PAYMENT_PROVIDER)
    private readonly provider: PaymentProvider,
    private readonly configService: TypedConfigService,
    @Optional()
    private readonly subscriptionService?: SubscriptionService,
  ) {}

  async getPaymentState(organizationId: string) {
    const wallet = await this.walletService.getOrCreateWallet(organizationId)
    return {
      providerMode: this.provider.mode,
      paymentMethod:
        wallet.paymentProviderMethodId && wallet.paymentMethodBrand && wallet.paymentMethodLast4
          ? { brand: wallet.paymentMethodBrand, last4: wallet.paymentMethodLast4 }
          : null,
      autoReload: {
        enabled: wallet.autoReloadEnabled,
        thresholdCents: wallet.autoReloadThresholdCents,
        targetCents: wallet.autoReloadTargetCents,
      },
    }
  }

  async setupPaymentMethod(
    organizationId: string,
  ): Promise<{ status: 'ready' | 'pending'; checkoutUrl: string | null }> {
    await this.walletService.getOrCreateWallet(organizationId)
    const setup = await this.claimPaymentSetup(organizationId)
    return this.dispatchPaymentSetup(setup)
  }

  async setAutoReload(organizationId: string, input: AutoReloadInput): Promise<void> {
    if (!input || typeof input.enabled !== 'boolean') {
      throw new BadRequestException('auto-reload enabled must be a boolean')
    }
    await this.walletService.getOrCreateWallet(organizationId)
    await this.wallets.manager.transaction(async (manager) => {
      const wallet = await manager.getRepository(Wallet).findOne({
        where: { organizationId },
        lock: { mode: 'pessimistic_write' },
      })
      if (!wallet) throw new BadRequestException('wallet not found')

      if (!input.enabled) {
        wallet.autoReloadEnabled = false
        wallet.autoReloadThresholdCents = null
        wallet.autoReloadTargetCents = null
        wallet.autoReloadNextAttemptAt = null
        await manager.getRepository(Wallet).save(wallet)
        return
      }

      if (!wallet.paymentProviderMethodId) {
        throw new BadRequestException('attach a payment method before enabling auto-reload')
      }
      const thresholdCents = this.positiveCents(input.thresholdCents, 'auto-reload threshold', true)
      const targetCents = this.positiveCents(input.targetCents, 'auto-reload target')
      if (targetCents < thresholdCents + MIN_AUTO_RELOAD_SPREAD_CENTS) {
        throw new BadRequestException('auto-reload target must be at least $10 above the threshold')
      }

      wallet.autoReloadEnabled = true
      wallet.autoReloadThresholdCents = thresholdCents.toString()
      wallet.autoReloadTargetCents = targetCents.toString()
      wallet.autoReloadNextAttemptAt = null
      await manager.getRepository(Wallet).save(wallet)
    })
  }

  async createManualTopUp(
    organizationId: string,
    amountCentsInput: string,
    idempotencyKey: string,
  ): Promise<{ id: string; status: 'pending' | 'paid' | 'failed'; checkoutUrl: string | null }> {
    const amountCents = this.positiveCents(amountCentsInput, 'top-up amount')
    if (amountCents < MIN_TOP_UP_CENTS) {
      throw new BadRequestException('top-up amount must be at least $5')
    }
    if (!idempotencyKey || idempotencyKey.length > 128) {
      throw new BadRequestException('a valid idempotency key is required')
    }

    await this.walletService.getOrCreateWallet(organizationId)
    const { topUp, created } = await this.claimManualTopUp(organizationId, amountCents, idempotencyKey)
    if (created || (topUp.status === 'pending' && !topUp.checkoutUrl)) {
      await this.dispatchTopUp(topUp, false)
    }
    const current = await this.topUps.findOne({ where: { id: topUp.id } })
    return this.topUpView(current ?? topUp)
  }

  async handleWebhook(payload: Buffer, signature: string): Promise<void> {
    const event = await this.provider.parseWebhook(payload, signature)
    if (event) await this.processProviderEvent(event)
  }

  async runAutoReloadForOrganization(organizationId: string, now = new Date()): Promise<boolean> {
    const topUp = await this.claimAutoReload(organizationId, now)
    if (!topUp) return false
    await this.dispatchTopUp(topUp, true)
    return true
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'billing-auto-reload', waitForCompletion: true })
  async scheduledAutoReload(): Promise<void> {
    const candidates = await this.wallets
      .createQueryBuilder('wallet')
      .select('wallet.organizationId', 'organizationId')
      .where('wallet.autoReloadEnabled = true')
      .andWhere('wallet.autoReloadThresholdCents IS NOT NULL')
      .andWhere('(wallet.freeBalanceCents + wallet.paidBalanceCents) < wallet.autoReloadThresholdCents')
      .andWhere('(wallet.autoReloadNextAttemptAt IS NULL OR wallet.autoReloadNextAttemptAt <= :now)', {
        now: new Date(),
      })
      .limit(100)
      .getRawMany<{ organizationId: string }>()

    for (const candidate of candidates) {
      try {
        await this.runAutoReloadForOrganization(candidate.organizationId)
      } catch (error) {
        this.logger.error(`auto-reload failed for organization ${candidate.organizationId}`, error)
      }
    }
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'billing-payment-recovery', waitForCompletion: true })
  async scheduledPaymentRecovery(now = new Date()): Promise<void> {
    const [topUps, setupWallets, providerEvents] = await Promise.all([
      this.topUps.find({
        select: { id: true },
        where: { status: 'pending', nextReconcileAt: LessThanOrEqual(now) },
        order: { nextReconcileAt: 'ASC', id: 'ASC' },
        take: RECOVERY_BATCH_SIZE,
      }),
      this.wallets.find({
        select: { organizationId: true },
        where: { paymentSetupNextReconcileAt: LessThanOrEqual(now) },
        order: { paymentSetupNextReconcileAt: 'ASC', id: 'ASC' },
        take: RECOVERY_BATCH_SIZE,
      }),
      this.wallets.manager.getRepository(PaymentProviderEvent).find({
        select: { id: true },
        where: { status: 'failed', nextAttemptAt: LessThanOrEqual(now) },
        order: { nextAttemptAt: 'ASC', id: 'ASC' },
        take: RECOVERY_BATCH_SIZE,
      }),
    ])

    for (const topUp of topUps) await this.recover('top_up', topUp.id, () => this.reconcileTopUp(topUp.id, now))
    for (const wallet of setupWallets) {
      await this.recover('setup', wallet.organizationId, () => this.reconcilePaymentSetup(wallet.organizationId, now))
    }
    for (const event of providerEvents) {
      await this.recover('webhook', event.id, () => this.retryProviderEvent(event.id, now))
    }
  }

  async listReceipts(organizationId: string, pageInput = 1, pageSizeInput = 8, queryInput = '') {
    const page = Math.max(1, Math.trunc(Number.isFinite(pageInput) ? pageInput : 1))
    const pageSize = Math.max(1, Math.min(100, Math.trunc(Number.isFinite(pageSizeInput) ? pageSizeInput : 8)))
    const query = queryInput.trim().slice(0, 100)
    const search = `%${query}%`
    const receiptCte = `WITH receipts AS (
      SELECT tur.id, tur."createdAt", tur."amountCents", 'top_up'::text AS type,
             tur.status, tur."receiptUrl"
      FROM top_up_record tur
      WHERE tur."organizationId" = $1 AND tur.status IN ('paid', 'failed')
      UNION ALL
      SELECT wt.id, wt."createdAt", ABS(wt."amountCents"), 'usage'::text AS type,
             'paid'::text AS status, NULL::text AS "receiptUrl"
      FROM wallet_transaction wt
      WHERE wt."organizationId" = $1 AND wt.kind = 'usage_debit'
    )`
    const searchClause = `WHERE $2 = '%%' OR type ILIKE $2 OR status ILIKE $2 OR "amountCents"::text ILIKE $2`
    const [rows, countRows] = await Promise.all([
      this.wallets.manager.query(
        `${receiptCte}
         SELECT id, "createdAt", "amountCents"::text AS "amountCents", type, status, "receiptUrl"
         FROM receipts ${searchClause}
         ORDER BY "createdAt" DESC, id DESC LIMIT $3 OFFSET $4`,
        [organizationId, search, pageSize, (page - 1) * pageSize],
      ) as Promise<Array<Omit<BillingReceipt, 'createdAt'> & { createdAt: Date | string }>>,
      this.wallets.manager.query(`${receiptCte} SELECT COUNT(*)::int AS total FROM receipts ${searchClause}`, [
        organizationId,
        search,
      ]) as Promise<Array<{ total: number | string }>>,
    ])
    return {
      items: rows.map((row) => ({ ...row, createdAt: new Date(row.createdAt).toISOString() })),
      page,
      pageSize,
      total: Number(countRows[0]?.total ?? 0),
    }
  }

  async reconcileTopUp(topUpId: string, now = new Date(), force = false): Promise<boolean> {
    const topUp = await this.claimTopUpReconciliation(topUpId, now, force)
    if (!topUp) return false

    try {
      if (!topUp.providerReference) {
        await this.dispatchTopUp(topUp, topUp.source === 'auto_reload')
        return true
      }

      const result = await this.provider.reconcile({
        operation: 'top_up',
        providerReference: topUp.providerReference,
      })
      if (result.status === 'resolved') {
        await this.processProviderEvent(result.event)
      } else {
        await this.markTopUpPending(topUp.id, topUp.reconcileAttempts, now)
      }
      return true
    } catch (error) {
      await this.markTopUpReconcileFailure(topUp.id, topUp.reconcileAttempts, error, now)
      throw error
    }
  }

  async reconcilePaymentSetup(organizationId: string, now = new Date(), force = false): Promise<boolean> {
    const setup = await this.claimPaymentSetupReconciliation(organizationId, now, force)
    if (!setup) return false

    try {
      if (!setup.paymentSetupProviderReference) {
        await this.dispatchPaymentSetup(setup)
        return true
      }

      const result = await this.provider.reconcile({
        operation: 'setup',
        providerReference: setup.paymentSetupProviderReference,
      })
      if (result.status === 'resolved') {
        await this.processProviderEvent(result.event)
      } else {
        await this.markPaymentSetupPending(organizationId, setup.paymentSetupReconcileAttempts, now)
      }
      return true
    } catch (error) {
      await this.markPaymentSetupFailure(
        organizationId,
        setup.paymentSetupAttemptId,
        setup.paymentSetupReconcileAttempts,
        error,
        now,
      )
      throw error
    }
  }

  private async claimPaymentSetup(organizationId: string): Promise<Wallet> {
    return this.wallets.manager.transaction(async (manager) => {
      const repository = manager.getRepository(Wallet)
      const wallet = await repository.findOne({
        where: { organizationId },
        lock: { mode: 'pessimistic_write' },
      })
      if (!wallet) throw new BadRequestException('wallet not found')
      if (!wallet.paymentSetupAttemptId) {
        wallet.paymentSetupAttemptId = randomUUID()
        wallet.paymentSetupProviderReference = null
        wallet.paymentSetupNextReconcileAt = new Date()
        wallet.paymentSetupReconcileAttempts = 0
        wallet.paymentSetupLastError = null
        await repository.save(wallet)
      }
      return { ...wallet }
    })
  }

  private async dispatchPaymentSetup(
    setup: Wallet,
  ): Promise<{ status: 'ready' | 'pending'; checkoutUrl: string | null }> {
    if (!setup.paymentSetupAttemptId) throw new Error('payment setup attempt is missing')

    let result: PaymentSetupResult
    try {
      result = await this.provider.createSetup({
        organizationId: setup.organizationId,
        walletId: setup.id,
        setupAttemptId: setup.paymentSetupAttemptId,
        providerCustomerId: setup.paymentProviderCustomerId,
        ...this.returnUrls(),
      })
    } catch (error) {
      await this.markPaymentSetupFailure(
        setup.organizationId,
        setup.paymentSetupAttemptId,
        setup.paymentSetupReconcileAttempts,
        error,
        new Date(),
      )
      throw new ServiceUnavailableException('payment provider request failed', { cause: error })
    }

    await this.persistPaymentSetupResult(setup.organizationId, setup.paymentSetupAttemptId, result)
    if (result.status === 'ready' && result.paymentMethod) {
      await this.processProviderEvent({
        kind: 'setup_succeeded',
        providerEventId: `direct:${result.providerReference}`,
        providerReference: result.providerReference,
        organizationId: setup.organizationId,
        setupAttemptId: setup.paymentSetupAttemptId,
        providerCustomerId: result.providerCustomerId,
        paymentMethod: result.paymentMethod,
      })
    }
    return { status: result.status, checkoutUrl: result.checkoutUrl }
  }

  private async persistPaymentSetupResult(
    organizationId: string,
    setupAttemptId: string,
    result: PaymentSetupResult,
  ): Promise<void> {
    await this.wallets.manager.transaction(async (manager) => {
      const repository = manager.getRepository(Wallet)
      const wallet = await repository.findOne({
        where: { organizationId },
        lock: { mode: 'pessimistic_write' },
      })
      if (!wallet) throw new BadRequestException('wallet not found')
      if (wallet.paymentSetupAttemptId !== setupAttemptId) return
      wallet.paymentProviderCustomerId = result.providerCustomerId
      wallet.paymentSetupProviderReference = result.providerReference
      wallet.paymentSetupNextReconcileAt = new Date(Date.now() + INITIAL_RECONCILE_DELAY_MILLISECONDS)
      wallet.paymentSetupLastError = null
      await repository.save(wallet)
    })
  }

  private claimPaymentSetupReconciliation(organizationId: string, now: Date, force: boolean): Promise<Wallet | null> {
    return this.wallets.manager.transaction(async (manager) => {
      const repository = manager.getRepository(Wallet)
      const wallet = await repository.findOne({
        where: { organizationId },
        lock: { mode: 'pessimistic_write' },
      })
      if (
        !wallet?.paymentSetupAttemptId ||
        !wallet.paymentSetupNextReconcileAt ||
        (!force && wallet.paymentSetupNextReconcileAt > now)
      ) {
        return null
      }
      wallet.paymentSetupReconcileAttempts += 1
      wallet.paymentSetupNextReconcileAt = new Date(
        now.getTime() + this.reconcileDelayMilliseconds(wallet.paymentSetupReconcileAttempts),
      )
      await repository.save(wallet)
      return { ...wallet }
    })
  }

  private async markPaymentSetupPending(organizationId: string, attempts: number, now: Date): Promise<void> {
    await this.wallets.manager.transaction(async (manager) => {
      const repository = manager.getRepository(Wallet)
      const wallet = await repository.findOne({
        where: { organizationId },
        lock: { mode: 'pessimistic_write' },
      })
      if (!wallet?.paymentSetupAttemptId) return
      wallet.paymentSetupNextReconcileAt = new Date(now.getTime() + this.reconcileDelayMilliseconds(attempts))
      wallet.paymentSetupLastError = null
      await repository.save(wallet)
    })
  }

  private async markPaymentSetupFailure(
    organizationId: string,
    setupAttemptId: string | null,
    attempts: number,
    error: unknown,
    now: Date,
  ): Promise<void> {
    await this.wallets.manager.transaction(async (manager) => {
      const repository = manager.getRepository(Wallet)
      const wallet = await repository.findOne({
        where: { organizationId },
        lock: { mode: 'pessimistic_write' },
      })
      if (!wallet || wallet.paymentSetupAttemptId !== setupAttemptId) return
      wallet.paymentSetupLastError = this.errorMessage(error)
      wallet.paymentSetupNextReconcileAt = new Date(now.getTime() + this.reconcileDelayMilliseconds(attempts + 1))
      await repository.save(wallet)
    })
  }

  private claimTopUpReconciliation(topUpId: string, now: Date, force: boolean): Promise<TopUpRecord | null> {
    return this.wallets.manager.transaction(async (manager) => {
      const repository = manager.getRepository(TopUpRecord)
      const topUp = await repository.findOne({
        where: { id: topUpId },
        lock: { mode: 'pessimistic_write' },
      })
      if (!topUp || topUp.status !== 'pending' || (!force && topUp.nextReconcileAt && topUp.nextReconcileAt > now)) {
        return null
      }
      topUp.reconcileAttempts += 1
      topUp.lastReconciledAt = now
      topUp.nextReconcileAt = new Date(now.getTime() + this.reconcileDelayMilliseconds(topUp.reconcileAttempts))
      await repository.save(topUp)
      return { ...topUp }
    })
  }

  private async markTopUpPending(topUpId: string, attempts: number, now: Date): Promise<void> {
    await this.wallets.manager.transaction(async (manager) => {
      const repository = manager.getRepository(TopUpRecord)
      const topUp = await repository.findOne({
        where: { id: topUpId },
        lock: { mode: 'pessimistic_write' },
      })
      if (!topUp || topUp.status !== 'pending') return
      topUp.nextReconcileAt = new Date(now.getTime() + this.reconcileDelayMilliseconds(attempts))
      topUp.reconcileLastError = null
      await repository.save(topUp)
    })
  }

  private async markTopUpReconcileFailure(topUpId: string, attempts: number, error: unknown, now: Date): Promise<void> {
    await this.wallets.manager.transaction(async (manager) => {
      const repository = manager.getRepository(TopUpRecord)
      const topUp = await repository.findOne({
        where: { id: topUpId },
        lock: { mode: 'pessimistic_write' },
      })
      if (!topUp || topUp.status !== 'pending') return
      topUp.reconcileLastError = this.errorMessage(error)
      topUp.nextReconcileAt = new Date(now.getTime() + this.reconcileDelayMilliseconds(attempts + 1))
      await repository.save(topUp)
    })
  }

  private async claimManualTopUp(organizationId: string, amountCents: bigint, idempotencyKey: string) {
    try {
      return await this.wallets.manager.transaction(async (manager) => {
        const topUpRepository = manager.getRepository(TopUpRecord)
        const existing = await topUpRepository.findOne({ where: { organizationId, idempotencyKey } })
        if (existing) {
          this.assertIdempotentAmount(existing, amountCents)
          return { topUp: existing, created: false }
        }
        const wallet = await manager.getRepository(Wallet).findOne({
          where: { organizationId },
          lock: { mode: 'pessimistic_write' },
        })
        if (!wallet?.paymentProviderCustomerId || !wallet.paymentProviderMethodId) {
          throw new BadRequestException('attach a payment method before topping up')
        }
        const topUp = await topUpRepository.save(
          topUpRepository.create({
            walletId: wallet.id,
            organizationId,
            amountCents: amountCents.toString(),
            source: 'manual',
            status: 'pending',
            idempotencyKey,
            providerReference: null,
            checkoutUrl: null,
            receiptUrl: null,
            failureCode: null,
            failureMessage: null,
            reconcileAttempts: 0,
            nextReconcileAt: new Date(Date.now() + INITIAL_RECONCILE_DELAY_MILLISECONDS),
            lastReconciledAt: null,
            reconcileLastError: null,
            refundedCents: '0',
            disputedCents: '0',
            completedAt: null,
          }),
        )
        return { topUp, created: true }
      })
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error
      const existing = await this.topUps.findOne({ where: { organizationId, idempotencyKey } })
      if (!existing) throw error
      this.assertIdempotentAmount(existing, amountCents)
      return { topUp: existing, created: false }
    }
  }

  private claimAutoReload(organizationId: string, now: Date): Promise<TopUpRecord | null> {
    return this.wallets.manager.transaction(async (manager) => {
      const wallet = await manager.getRepository(Wallet).findOne({
        where: { organizationId },
        lock: { mode: 'pessimistic_write' },
      })
      if (
        !wallet?.autoReloadEnabled ||
        !wallet.autoReloadThresholdCents ||
        !wallet.autoReloadTargetCents ||
        !wallet.paymentProviderCustomerId ||
        !wallet.paymentProviderMethodId ||
        (wallet.autoReloadNextAttemptAt && wallet.autoReloadNextAttemptAt > now)
      ) {
        return null
      }
      const currentBalance = BigInt(wallet.freeBalanceCents) + BigInt(wallet.paidBalanceCents)
      const threshold = BigInt(wallet.autoReloadThresholdCents)
      const target = BigInt(wallet.autoReloadTargetCents)
      if (currentBalance >= threshold || currentBalance >= target) return null

      const topUpRepository = manager.getRepository(TopUpRecord)
      const pending = await topUpRepository.findOne({
        where: { walletId: wallet.id, source: 'auto_reload', status: 'pending' },
      })
      if (pending) {
        const createdAt = pending.createdAt?.getTime()
        return createdAt && now.getTime() - createdAt >= AUTO_RELOAD_RETRY_MILLISECONDS ? pending : null
      }

      return topUpRepository.save(
        topUpRepository.create({
          walletId: wallet.id,
          organizationId,
          amountCents: (target - currentBalance).toString(),
          source: 'auto_reload',
          status: 'pending',
          idempotencyKey: `auto:${wallet.id}:${Math.floor(now.getTime() / AUTO_RELOAD_RETRY_MILLISECONDS)}`,
          providerReference: null,
          checkoutUrl: null,
          receiptUrl: null,
          failureCode: null,
          failureMessage: null,
          reconcileAttempts: 0,
          nextReconcileAt: new Date(Date.now() + INITIAL_RECONCILE_DELAY_MILLISECONDS),
          lastReconciledAt: null,
          reconcileLastError: null,
          refundedCents: '0',
          disputedCents: '0',
          completedAt: null,
        }),
      )
    })
  }

  private async dispatchTopUp(topUp: TopUpRecord, savedMethod: boolean): Promise<void> {
    const wallet = await this.wallets.findOne({ where: { id: topUp.walletId } })
    if (!wallet?.paymentProviderCustomerId || !wallet.paymentProviderMethodId) {
      throw new BadRequestException('payment method not found')
    }
    const input: TopUpPaymentInput = {
      organizationId: topUp.organizationId,
      topUpId: topUp.id,
      amountCents: topUp.amountCents,
      providerCustomerId: wallet.paymentProviderCustomerId,
      providerMethodId: wallet.paymentProviderMethodId,
      ...this.returnUrls(),
    }

    let result: TopUpPaymentResult
    try {
      result = savedMethod ? await this.provider.chargeSavedMethod(input) : await this.provider.createManualTopUp(input)
    } catch (error) {
      await this.markTopUpReconcileFailure(topUp.id, topUp.reconcileAttempts, error, new Date())
      throw new ServiceUnavailableException('payment provider request failed', { cause: error })
    }

    await this.applyPaymentResult(topUp, result)
  }

  private async applyPaymentResult(topUp: TopUpRecord, result: TopUpPaymentResult): Promise<void> {
    await this.wallets.manager.transaction(async (manager) => {
      const repository = manager.getRepository(TopUpRecord)
      const current = await repository.findOne({
        where: { id: topUp.id },
        lock: { mode: 'pessimistic_write' },
      })
      if (!current || current.status !== 'pending') return
      current.providerReference = result.providerReference
      current.checkoutUrl = result.checkoutUrl
      current.nextReconcileAt =
        result.status === 'pending' ? new Date(Date.now() + INITIAL_RECONCILE_DELAY_MILLISECONDS) : null
      current.reconcileLastError = null
      await repository.save(current)
    })

    if (result.status === 'paid') {
      await this.processProviderEvent({
        kind: 'top_up_paid',
        providerEventId: `direct:${result.providerReference}`,
        providerReference: result.providerReference,
        topUpId: topUp.id,
        organizationId: topUp.organizationId,
        amountCents: topUp.amountCents,
        currency: 'usd',
        receiptUrl: result.receiptUrl,
      })
    } else if (result.status === 'failed') {
      await this.processProviderEvent({
        kind: 'top_up_failed',
        providerEventId: `direct:${result.providerReference}`,
        providerReference: result.providerReference,
        topUpId: topUp.id,
        organizationId: topUp.organizationId,
        failureCode: result.failureCode ?? null,
        failureMessage: result.failureMessage ?? null,
      })
    }
  }

  private async processProviderEvent(event: ProviderWebhookEvent): Promise<void> {
    try {
      await this.applyProviderEvent(event)
    } catch (error) {
      await this.recordProviderEventFailure(event, error)
      this.logger.error(
        `[billing_payment] stage=webhook_apply event=${event.providerEventId} reference=${event.providerReference} error=${this.errorMessage(error)}`,
      )
      throw error
    }
  }

  private async applyProviderEvent(event: ProviderWebhookEvent): Promise<void> {
    try {
      await this.wallets.manager.transaction(async (manager) => {
        const eventRepository = manager.getRepository(PaymentProviderEvent)
        const existing = await eventRepository.findOne({
          where: { providerEventId: event.providerEventId },
          lock: { mode: 'pessimistic_write' },
        })
        if (existing?.status === 'processed') return

        if (
          event.kind === 'subscription_synced' ||
          event.kind === 'subscription_period_paid' ||
          event.kind === 'subscription_checkout_expired'
        ) {
          if (!this.subscriptionService) throw new Error('subscription service is unavailable')
          await this.subscriptionService.applyProviderEvent(manager, event)
        } else if (event.kind === 'setup_succeeded' || event.kind === 'setup_failed') {
          await this.applySetupEvent(manager, event)
        } else if (event.kind === 'top_up_adjusted') {
          await this.applyTopUpAdjustment(manager, event)
        } else {
          await this.applyTopUpEvent(manager, event)
        }

        const record =
          existing ??
          eventRepository.create({
            providerEventId: event.providerEventId,
            createdAt: new Date(),
            attempts: 1,
          })
        record.eventType = this.providerEventType(event)
        record.providerReference = event.providerReference
        record.status = 'processed'
        record.payload = event as unknown as Record<string, unknown>
        record.nextAttemptAt = null
        record.lastError = null
        await eventRepository.save(record)
      })
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error
    }
  }

  private async recordProviderEventFailure(event: ProviderWebhookEvent, error: unknown): Promise<void> {
    try {
      await this.wallets.manager.transaction(async (manager) => {
        const repository = manager.getRepository(PaymentProviderEvent)
        const existing = await repository.findOne({
          where: { providerEventId: event.providerEventId },
          lock: { mode: 'pessimistic_write' },
        })
        if (existing?.status === 'processed') return
        const record =
          existing ??
          repository.create({
            providerEventId: event.providerEventId,
            createdAt: new Date(),
            attempts: 0,
          })
        record.eventType = this.providerEventType(event)
        record.providerReference = event.providerReference
        record.status = 'failed'
        record.payload = event as unknown as Record<string, unknown>
        record.attempts += 1
        record.nextAttemptAt = new Date(Date.now() + this.reconcileDelayMilliseconds(record.attempts))
        record.lastError = this.errorMessage(error)
        await repository.save(record)
      })
    } catch (failure) {
      if (!this.isUniqueViolation(failure)) throw failure
    }
  }

  private async retryProviderEvent(providerEventId: string, now: Date): Promise<boolean> {
    const event = await this.wallets.manager.transaction(async (manager) => {
      const repository = manager.getRepository(PaymentProviderEvent)
      const record = await repository.findOne({
        where: { id: providerEventId },
        lock: { mode: 'pessimistic_write' },
      })
      if (record?.status !== 'failed' || !record.payload || (record.nextAttemptAt && record.nextAttemptAt > now)) {
        return null
      }
      record.nextAttemptAt = new Date(now.getTime() + this.reconcileDelayMilliseconds(record.attempts + 1))
      await repository.save(record)
      return record.payload as unknown as ProviderWebhookEvent
    })
    if (!event) return false
    await this.processProviderEvent(event)
    return true
  }

  private async applySetupEvent(
    manager: EntityManager,
    event: Extract<ProviderWebhookEvent, { kind: 'setup_succeeded' | 'setup_failed' }>,
  ): Promise<void> {
    const repository = manager.getRepository(Wallet)
    const wallet = await repository.findOne({
      where: { organizationId: event.organizationId },
      lock: { mode: 'pessimistic_write' },
    })
    if (!wallet) throw new BadRequestException('wallet not found')
    if (wallet.paymentSetupAttemptId !== event.setupAttemptId) return

    if (event.kind === 'setup_succeeded') {
      wallet.paymentProviderCustomerId = event.providerCustomerId
      wallet.paymentProviderMethodId = event.paymentMethod.id
      wallet.paymentMethodBrand = event.paymentMethod.brand
      wallet.paymentMethodLast4 = event.paymentMethod.last4
      wallet.paymentSetupLastError = null
    } else {
      wallet.paymentSetupLastError = `${event.failureCode}: ${event.failureMessage}`
    }
    wallet.paymentSetupAttemptId = null
    wallet.paymentSetupProviderReference = null
    wallet.paymentSetupNextReconcileAt = null
    await repository.save(wallet)
  }

  private async applyTopUpEvent(
    manager: EntityManager,
    event: Extract<ProviderWebhookEvent, { kind: 'top_up_paid' | 'top_up_failed' }>,
  ): Promise<void> {
    const topUpRepository = manager.getRepository(TopUpRecord)
    const topUp = await topUpRepository.findOne({
      where: { id: event.topUpId },
      lock: { mode: 'pessimistic_write' },
    })
    if (!topUp || topUp.organizationId !== event.organizationId) {
      throw new BadRequestException('top-up does not match provider event')
    }

    if (event.kind === 'top_up_failed') {
      if (topUp.status === 'paid') return
      topUp.status = 'failed'
      topUp.failureCode = event.failureCode
      topUp.failureMessage = event.failureMessage
      topUp.nextReconcileAt = null
      topUp.reconcileLastError = null
      topUp.completedAt = new Date()
      await topUpRepository.save(topUp)
      if (topUp.source === 'auto_reload') {
        const wallet = await manager.getRepository(Wallet).findOne({
          where: { id: topUp.walletId },
          lock: { mode: 'pessimistic_write' },
        })
        if (wallet) {
          wallet.autoReloadNextAttemptAt = new Date(Date.now() + AUTO_RELOAD_RETRY_MILLISECONDS)
          await manager.getRepository(Wallet).save(wallet)
        }
      }
      return
    }

    if (event.currency.toLowerCase() !== 'usd' || event.amountCents !== topUp.amountCents) {
      throw new BadRequestException('provider payment amount or currency does not match top-up')
    }
    if (topUp.status === 'paid') return

    const wallet = await manager.getRepository(Wallet).findOne({
      where: { id: topUp.walletId },
      lock: { mode: 'pessimistic_write' },
    })
    if (!wallet) throw new BadRequestException('wallet not found')
    wallet.paidBalanceCents = (BigInt(wallet.paidBalanceCents) + BigInt(topUp.amountCents)).toString()
    wallet.billingStatus = this.statusForWallet(wallet)
    wallet.autoReloadNextAttemptAt = null
    await manager.getRepository(Wallet).save(wallet)

    topUp.status = 'paid'
    topUp.receiptUrl = event.receiptUrl
    topUp.failureCode = null
    topUp.failureMessage = null
    topUp.nextReconcileAt = null
    topUp.reconcileLastError = null
    topUp.completedAt = new Date()
    await topUpRepository.save(topUp)
    const transactionRepository = manager.getRepository(WalletTransaction)
    await transactionRepository.save(
      transactionRepository.create({
        walletId: wallet.id,
        organizationId: wallet.organizationId,
        kind: 'top_up',
        amountCents: topUp.amountCents,
        source: topUp.source === 'auto_reload' ? 'auto_reload' : 'manual_top_up',
        ratedPeriodId: null,
        providerActionId: null,
        metadata: { topUpId: topUp.id, providerReference: event.providerReference },
      }),
    )
  }

  private async applyTopUpAdjustment(
    manager: EntityManager,
    event: Extract<ProviderWebhookEvent, { kind: 'top_up_adjusted' }>,
  ): Promise<void> {
    const amount = this.positiveCents(event.amountCents, 'provider adjustment amount')
    if (event.currency.toLowerCase() !== 'usd') throw new BadRequestException('provider adjustment must use USD')

    const topUpRepository = manager.getRepository(TopUpRecord)
    const topUp = await topUpRepository.findOne({
      where: { id: event.topUpId },
      lock: { mode: 'pessimistic_write' },
    })
    if (!topUp || topUp.organizationId !== event.organizationId || topUp.status !== 'paid') {
      throw new BadRequestException('provider adjustment does not match a paid top-up')
    }
    if (amount > BigInt(topUp.amountCents)) throw new BadRequestException('provider adjustment exceeds top-up')

    const walletRepository = manager.getRepository(Wallet)
    const wallet = await walletRepository.findOne({
      where: { id: topUp.walletId },
      lock: { mode: 'pessimistic_write' },
    })
    if (!wallet) throw new BadRequestException('wallet not found')

    const transactionRepository = manager.getRepository(WalletTransaction)
    const actionPrefix = `${event.adjustment}:${event.providerReference}`
    const debitActionId = `${actionPrefix}:debit`
    const restoreActionId = `${actionPrefix}:restore`
    const debit = await transactionRepository.findOne({ where: { providerActionId: debitActionId } })
    const restore = await transactionRepository.findOne({ where: { providerActionId: restoreActionId } })
    if (event.direction === 'debit' && (debit || restore)) return
    if (event.direction === 'restore' && restore) return

    const counter = event.adjustment === 'refund' ? 'refundedCents' : 'disputedCents'
    let ledgerAmount = 0n
    if (event.direction === 'debit') {
      ledgerAmount = -amount
      wallet.paidBalanceCents = (BigInt(wallet.paidBalanceCents) - amount).toString()
      topUp[counter] = (BigInt(topUp[counter]) + amount).toString()
    } else if (debit) {
      if (BigInt(debit.amountCents) !== -amount) {
        throw new BadRequestException('provider adjustment restoration amount does not match debit')
      }
      const currentAdjusted = BigInt(topUp[counter])
      if (currentAdjusted < amount) throw new BadRequestException('provider adjustment restoration exceeds debit')
      ledgerAmount = amount
      wallet.paidBalanceCents = (BigInt(wallet.paidBalanceCents) + amount).toString()
      topUp[counter] = (currentAdjusted - amount).toString()
    }

    wallet.billingStatus = this.statusForWallet(wallet)
    if (ledgerAmount !== 0n) {
      await walletRepository.save(wallet)
      await topUpRepository.save(topUp)
    }
    await transactionRepository.save(
      transactionRepository.create({
        walletId: wallet.id,
        organizationId: wallet.organizationId,
        kind: 'adjustment',
        amountCents: ledgerAmount.toString(),
        source: `stripe_${event.adjustment}_${event.direction}`,
        ratedPeriodId: null,
        providerActionId: event.direction === 'debit' ? debitActionId : restoreActionId,
        metadata: {
          topUpId: topUp.id,
          providerReference: event.providerReference,
          adjustment: event.adjustment,
          direction: event.direction,
        },
      }),
    )
  }

  private positiveCents(value: string | null, name: string, allowZero = false): bigint {
    if (value === null || !/^\d+$/.test(value)) throw new BadRequestException(`${name} must be a whole cent value`)
    const amount = BigInt(value)
    if (allowZero ? amount < 0n : amount <= 0n) throw new BadRequestException(`${name} must be positive`)
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new BadRequestException(`${name} is too large`)
    return amount
  }

  private topUpView(topUp: TopUpRecord) {
    return { id: topUp.id, status: topUp.status, checkoutUrl: topUp.checkoutUrl }
  }

  private assertIdempotentAmount(topUp: TopUpRecord, amountCents: bigint): void {
    if (topUp.amountCents !== amountCents.toString()) {
      throw new BadRequestException('idempotency key was already used with a different amount')
    }
  }

  private providerEventType(event: ProviderWebhookEvent): string {
    return event.kind === 'top_up_adjusted' ? `${event.kind}:${event.adjustment}:${event.direction}` : event.kind
  }

  private reconcileDelayMilliseconds(attempts: number): number {
    const exponent = Math.max(0, Math.min(6, attempts - 1))
    return Math.min(INITIAL_RECONCILE_DELAY_MILLISECONDS * 2 ** exponent, MAX_RECONCILE_DELAY_MILLISECONDS)
  }

  private errorMessage(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 500)
  }

  private async recover(stage: 'setup' | 'top_up' | 'webhook', id: string, work: () => Promise<unknown>) {
    try {
      await work()
    } catch (error) {
      this.logger.warn(`[billing_payment] stage=${stage}_reconcile id=${id} error=${this.errorMessage(error)}`)
    }
  }

  private returnUrls() {
    const dashboardUrl = this.configService.getOrThrow('dashboardUrl').replace(/\/$/, '')
    return {
      successUrl: `${dashboardUrl}/dashboard/billing?payment=success`,
      cancelUrl: `${dashboardUrl}/dashboard/billing?payment=cancelled`,
    }
  }

  private statusForWallet(wallet: Wallet): BillingStatus {
    const total = BigInt(wallet.freeBalanceCents) + BigInt(wallet.paidBalanceCents)
    if (total <= 0n) return 'zero_balance'
    return BigInt(wallet.freeBalanceCents) > 0n ? 'trial' : 'active'
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error.driverError as { code?: string } | undefined)?.code === PG_UNIQUE_VIOLATION
    )
  }
}
