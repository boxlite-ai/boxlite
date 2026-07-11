/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectRepository } from '@nestjs/typeorm'
import { randomUUID } from 'node:crypto'
import { EntityManager, QueryFailedError, Repository } from 'typeorm'
import { TypedConfigService } from '../../config/typed-config.service'
import { PaymentProviderEvent } from '../entities/payment-provider-event.entity'
import { TopUpRecord } from '../entities/top-up-record.entity'
import { WalletTransaction } from '../entities/wallet-transaction.entity'
import { BillingStatus, Wallet } from '../entities/wallet.entity'
import { WalletService } from '../wallet.service'
import {
  PAYMENT_PROVIDER,
  PaymentProvider,
  ProviderWebhookEvent,
  TopUpPaymentInput,
  TopUpPaymentResult,
} from './payment-provider'

const MIN_TOP_UP_CENTS = 500n
const MIN_AUTO_RELOAD_SPREAD_CENTS = 1000n
const AUTO_RELOAD_RETRY_MILLISECONDS = 15 * 60 * 1000
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
    const wallet = await this.walletService.getOrCreateWallet(organizationId)
    const result = await this.provider.createSetup({
      organizationId,
      walletId: wallet.id,
      setupAttemptId: randomUUID(),
      providerCustomerId: wallet.paymentProviderCustomerId,
      ...this.returnUrls(),
    })

    await this.wallets.manager.transaction(async (manager) => {
      const lockedWallet = await manager.getRepository(Wallet).findOne({
        where: { organizationId },
        lock: { mode: 'pessimistic_write' },
      })
      if (!lockedWallet) throw new BadRequestException('wallet not found')
      lockedWallet.paymentProviderCustomerId = result.providerCustomerId
      await manager.getRepository(Wallet).save(lockedWallet)
    })

    if (result.status === 'ready' && result.paymentMethod) {
      await this.applyProviderEvent({
        kind: 'setup_succeeded',
        providerEventId: `direct:${result.providerReference}`,
        providerReference: result.providerReference,
        organizationId,
        providerCustomerId: result.providerCustomerId,
        paymentMethod: result.paymentMethod,
      })
    }

    return { status: result.status, checkoutUrl: result.checkoutUrl }
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
    if (event) await this.applyProviderEvent(event)
  }

  async runAutoReloadForOrganization(organizationId: string, now = new Date()): Promise<boolean> {
    const topUp = await this.claimAutoReload(organizationId, now)
    if (!topUp) return false
    await this.dispatchTopUp(topUp, true)
    return true
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'billing-auto-reload' })
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
      throw new ServiceUnavailableException('payment provider request failed', { cause: error })
    }

    await this.applyPaymentResult(topUp, result)
  }

  private async applyPaymentResult(topUp: TopUpRecord, result: TopUpPaymentResult): Promise<void> {
    topUp.providerReference = result.providerReference
    topUp.checkoutUrl = result.checkoutUrl
    await this.topUps.save(topUp)

    if (result.status === 'paid') {
      await this.applyProviderEvent({
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
      await this.applyProviderEvent({
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

  private async applyProviderEvent(event: ProviderWebhookEvent): Promise<void> {
    try {
      await this.wallets.manager.transaction(async (manager) => {
        const eventRepository = manager.getRepository(PaymentProviderEvent)
        if (await eventRepository.findOne({ where: { providerEventId: event.providerEventId } })) return

        if (event.kind === 'setup_succeeded') {
          const wallet = await manager.getRepository(Wallet).findOne({
            where: { organizationId: event.organizationId },
            lock: { mode: 'pessimistic_write' },
          })
          if (!wallet) throw new BadRequestException('wallet not found')
          wallet.paymentProviderCustomerId = event.providerCustomerId
          wallet.paymentProviderMethodId = event.paymentMethod.id
          wallet.paymentMethodBrand = event.paymentMethod.brand
          wallet.paymentMethodLast4 = event.paymentMethod.last4
          await manager.getRepository(Wallet).save(wallet)
        } else {
          await this.applyTopUpEvent(manager, event)
        }

        await eventRepository.save(
          eventRepository.create({ providerEventId: event.providerEventId, eventType: event.kind }),
        )
      })
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error
    }
  }

  private async applyTopUpEvent(
    manager: EntityManager,
    event: Exclude<ProviderWebhookEvent, { kind: 'setup_succeeded' }>,
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
        metadata: { topUpId: topUp.id, providerReference: event.providerReference },
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
