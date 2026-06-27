/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource, EntityManager, IsNull, MoreThan, QueryFailedError } from 'typeorm'
import { CreditGrant } from '../entities/credit-grant.entity'
import { Wallet } from '../entities/wallet.entity'
import { TxSource, WalletTransaction } from '../entities/wallet-transaction.entity'
import { BillingStatus, deriveBillingStatus, InboundLot, Pool } from './wallet-math'
import { planCredit, planDebit, WalletBalances } from './wallet-plan'

const PG_UNIQUE_VIOLATION = '23505'
const n = (cents: string): number => Number(cents)
const s = (cents: number): string => String(cents)

function isUniqueViolation(err: unknown): boolean {
  return err instanceof QueryFailedError && (err.driverError as { code?: string })?.code === PG_UNIQUE_VIOLATION
}

/** Wallet read-view with the derived billing status (low/zero computed live). */
export interface WalletView {
  organizationId: string
  balanceCents: number
  freeBalanceCents: number
  paidBalanceCents: number
  billingStatus: BillingStatus
  creditCardConnected: boolean
}

/**
 * Owns all wallet money movement. Every mutation runs in a transaction that
 * pessimistically locks the wallet row (`SELECT ... FOR UPDATE`), so concurrent
 * debits/top-ups on the same wallet serialize and can't lose an update — and
 * because all work happens inside that transaction, the pure planners
 * (planDebit/planCredit) decide the new balances and ledger rows. `lockVersion`
 * is bumped on every mutation as a monotonic audit/version counter.
 *
 * NOTE: the design doc weighed optimistic-lock-with-retry (Lago) vs a pessimistic
 * row lock; we take the pessimistic lock here because every step is already
 * inside one transaction, which makes it simpler with the same no-lost-update
 * guarantee. The lockVersion column keeps the optimistic path open later.
 */
@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name)

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Debit usage cost; burns free→paid and goes bounded-negative on overage. */
  async debit(
    organizationId: string,
    amountCents: number,
    opts: { source: TxSource; ratedPeriodId: string | null },
    now: Date = new Date(),
  ): Promise<WalletBalances> {
    if (amountCents <= 0) throw new Error(`debit amount must be positive, got ${amountCents}`)

    return this.dataSource.transaction(async (manager) => {
      const wallet = await this.lockWallet(manager, organizationId)
      const lots = await this.openInboundLots(manager, wallet.id)

      const plan = planDebit(toBalances(wallet), lots, amountCents, now, opts)

      await manager.insert(
        WalletTransaction,
        plan.ledgerRows.map((row) => ({
          walletId: wallet.id,
          status: 'settled' as const,
          amountCents: s(row.amountCents),
          remainingCents: row.remainingCents === null ? null : s(row.remainingCents),
          pool: row.pool,
          priority: row.priority,
          direction: row.direction,
          expiresAt: row.expiresAt,
          source: row.source,
          ratedPeriodId: row.ratedPeriodId,
        })),
      )
      for (const burn of plan.lotBurns) {
        await manager.update(WalletTransaction, burn.lotId, { remainingCents: s(burn.newRemainingCents) })
      }
      await this.persistBalances(manager, wallet, plan.balances)
      return plan.balances
    })
  }

  /** Top up the paid pool (settles any carried negative first). */
  async topUp(
    organizationId: string,
    amountCents: number,
    source: Extract<TxSource, 'manual' | 'threshold'> = 'manual',
  ): Promise<WalletBalances> {
    return this.credit(organizationId, amountCents, 'paid', { source, expiresAt: null })
  }

  /** Grant free credit (support adjustment); records an immutable credit_grant trail. */
  async grant(
    organizationId: string,
    amountCents: number,
    opts: { reason: string; operatorId: string; note?: string; expiresAt?: Date | null },
  ): Promise<WalletBalances> {
    return this.dataSource.transaction(async (manager) => {
      const wallet = await this.lockWallet(manager, organizationId)
      const plan = planCredit(toBalances(wallet), amountCents, 'free', {
        source: 'grant',
        expiresAt: opts.expiresAt ?? null,
      })
      const inserted = await manager.insert(WalletTransaction, {
        walletId: wallet.id,
        status: 'settled' as const,
        amountCents: s(plan.ledgerRow.amountCents),
        remainingCents: plan.ledgerRow.remainingCents === null ? null : s(plan.ledgerRow.remainingCents),
        pool: plan.ledgerRow.pool,
        priority: plan.ledgerRow.priority,
        direction: plan.ledgerRow.direction,
        expiresAt: plan.ledgerRow.expiresAt,
        source: plan.ledgerRow.source,
        ratedPeriodId: null,
      })
      await manager.insert(CreditGrant, {
        organizationId,
        amountCents: s(amountCents),
        type: 'grant',
        pool: 'free',
        reason: opts.reason,
        note: opts.note ?? null,
        operatorId: opts.operatorId,
        expiresAt: opts.expiresAt ?? null,
        walletTransactionId: inserted.identifiers[0].id as string,
      })
      await this.persistBalances(manager, wallet, plan.balances)
      return plan.balances
    })
  }

  /** Read the wallet with a freshly-derived billing status. `warnThresholdCents` comes from the active plan. */
  async getView(organizationId: string, warnThresholdCents: number): Promise<WalletView> {
    const wallet = await this.getOrCreateWallet(organizationId)
    const balance = n(wallet.balanceCents)
    return {
      organizationId,
      balanceCents: balance,
      freeBalanceCents: n(wallet.freeBalanceCents),
      paidBalanceCents: n(wallet.paidBalanceCents),
      billingStatus: deriveBillingStatus(wallet.billingStatus, balance, warnThresholdCents),
      creditCardConnected: wallet.creditCardConnected,
    }
  }

  /** Find or lazily create the org's wallet (trial, empty pools). */
  async getOrCreateWallet(organizationId: string): Promise<Wallet> {
    const repo = this.dataSource.getRepository(Wallet)
    const existing = await repo.findOne({ where: { organizationId } })
    if (existing) return existing
    try {
      return await repo.save(repo.create({ organizationId, billingStatus: 'trial' }))
    } catch (err) {
      if (isUniqueViolation(err)) return repo.findOneOrFail({ where: { organizationId } }) // lost the create race
      throw err
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private async credit(
    organizationId: string,
    amountCents: number,
    pool: Pool,
    opts: { source: TxSource; expiresAt: Date | null },
  ): Promise<WalletBalances> {
    if (amountCents <= 0) throw new Error(`credit amount must be positive, got ${amountCents}`)
    return this.dataSource.transaction(async (manager) => {
      const wallet = await this.lockWallet(manager, organizationId)
      const plan = planCredit(toBalances(wallet), amountCents, pool, opts)
      await manager.insert(WalletTransaction, {
        walletId: wallet.id,
        status: 'settled' as const,
        amountCents: s(plan.ledgerRow.amountCents),
        remainingCents: plan.ledgerRow.remainingCents === null ? null : s(plan.ledgerRow.remainingCents),
        pool: plan.ledgerRow.pool,
        priority: plan.ledgerRow.priority,
        direction: plan.ledgerRow.direction,
        expiresAt: plan.ledgerRow.expiresAt,
        source: plan.ledgerRow.source,
        ratedPeriodId: null,
      })
      await this.persistBalances(manager, wallet, plan.balances)
      return plan.balances
    })
  }

  /** Lock the wallet row for update (creates it first if missing). */
  private async lockWallet(manager: EntityManager, organizationId: string): Promise<Wallet> {
    await this.getOrCreateWallet(organizationId) // ensure the row exists before locking it
    return manager.findOneOrFail(Wallet, {
      where: { organizationId },
      lock: { mode: 'pessimistic_write' },
    })
  }

  /** Settled inbound lots with spendable balance left, in no particular order (planner sorts). */
  private async openInboundLots(manager: EntityManager, walletId: string): Promise<InboundLot[]> {
    const rows = await manager.find(WalletTransaction, {
      where: { walletId, direction: 'inbound', status: 'settled', voidedAt: IsNull(), remainingCents: MoreThan('0') },
    })
    return rows.map((r) => ({
      id: r.id,
      pool: r.pool,
      priority: r.priority,
      remainingCents: n(r.remainingCents as string),
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
    }))
  }

  private async persistBalances(manager: EntityManager, wallet: Wallet, balances: WalletBalances): Promise<void> {
    await manager.update(Wallet, wallet.id, {
      balanceCents: s(balances.balanceCents),
      freeBalanceCents: s(balances.freeBalanceCents),
      paidBalanceCents: s(balances.paidBalanceCents),
      lockVersion: wallet.lockVersion + 1,
    })
  }
}

function toBalances(wallet: Wallet): WalletBalances {
  return {
    balanceCents: n(wallet.balanceCents),
    freeBalanceCents: n(wallet.freeBalanceCents),
    paidBalanceCents: n(wallet.paidBalanceCents),
  }
}
