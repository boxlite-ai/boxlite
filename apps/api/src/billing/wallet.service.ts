/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import Decimal from 'decimal.js'
import { EntityManager, QueryFailedError, Repository } from 'typeorm'
import { TypedConfigService } from '../config/typed-config.service'
import { Organization } from '../organization/entities/organization.entity'
import { RatedPeriod } from './entities/rated-period.entity'
import { WalletTransaction } from './entities/wallet-transaction.entity'
import { BillingStatus, Wallet } from './entities/wallet.entity'

const PG_UNIQUE_VIOLATION = '23505'
const WALLET_DEBIT_BATCH_SIZE = 100
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error.driverError as { code?: string } | undefined)?.code === PG_UNIQUE_VIOLATION
  )
}

function nonNegativeBigInt(value: string): bigint {
  const parsed = BigInt(value)
  return parsed > 0n ? parsed : 0n
}

@Injectable()
export class WalletService {
  constructor(
    @InjectRepository(Wallet)
    private readonly wallets: Repository<Wallet>,
    @InjectRepository(RatedPeriod)
    private readonly ratedPeriods: Repository<RatedPeriod>,
    private readonly configService: TypedConfigService,
  ) {}

  getOrCreateWallet(organizationId: string): Promise<Wallet> {
    return this.wallets.manager.transaction((manager) => this.findWalletForUpdate(manager, organizationId))
  }

  async debitRatedPeriods(limit = WALLET_DEBIT_BATCH_SIZE): Promise<{ debited: number; skipped: number }> {
    const periods = await this.findUndebitedRatedPeriods(limit)
    let debited = 0
    let skipped = 0

    for (const period of periods) {
      if (await this.debitRatedPeriod(period)) {
        debited++
      } else {
        skipped++
      }
    }

    return { debited, skipped }
  }

  async debitRatedPeriod(period: RatedPeriod): Promise<WalletTransaction | null> {
    try {
      return await this.wallets.manager.transaction(async (manager) => {
        const wallet = await this.findWalletForUpdate(manager, period.organizationId)
        const transactionRepository = manager.getRepository(WalletTransaction)
        const existing = await transactionRepository.findOne({ where: { ratedPeriodId: period.id } })
        if (existing) {
          return null
        }

        const preciseCents = new Decimal(period.preciseCents)
        if (preciseCents.isNegative()) {
          throw new Error(`rated period ${period.id} has a negative charge`)
        }
        const remainderBefore = new Decimal(wallet.settlementRemainderCents)
        const unsettledCents = remainderBefore.plus(preciseCents)
        const debitCents = BigInt(unsettledCents.toDecimalPlaces(0, Decimal.ROUND_FLOOR).toFixed(0))
        const freeBefore = BigInt(wallet.freeBalanceCents)
        const paidBefore = BigInt(wallet.paidBalanceCents)
        const freeDebitCents = debitCents < nonNegativeBigInt(wallet.freeBalanceCents)
          ? debitCents
          : nonNegativeBigInt(wallet.freeBalanceCents)
        const paidDebitCents = debitCents - freeDebitCents

        wallet.freeBalanceCents = (freeBefore - freeDebitCents).toString()
        wallet.paidBalanceCents = (paidBefore - paidDebitCents).toString()
        wallet.settlementRemainderCents = unsettledCents.minus(debitCents.toString()).toString()
        wallet.billingStatus = this.statusForWallet(wallet)
        await manager.getRepository(Wallet).save(wallet)

        return transactionRepository.save(
          transactionRepository.create({
            walletId: wallet.id,
            organizationId: wallet.organizationId,
            kind: 'usage_debit',
            amountCents: (-debitCents).toString(),
            source: 'rated_period',
            ratedPeriodId: period.id,
            metadata: {
              preciseCents: period.preciseCents,
              remainderBeforeCents: remainderBefore.toString(),
              remainderAfterCents: wallet.settlementRemainderCents,
              freeDebitCents: freeDebitCents.toString(),
              paidDebitCents: paidDebitCents.toString(),
            },
          }),
        )
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        return null
      }
      throw error
    }
  }

  private findUndebitedRatedPeriods(limit: number): Promise<RatedPeriod[]> {
    return this.ratedPeriods
      .createQueryBuilder('rp')
      .leftJoin(WalletTransaction, 'wt', 'wt."ratedPeriodId" = rp.id')
      .where('wt.id IS NULL')
      .orderBy('rp.ratedAt', 'ASC')
      .take(Math.max(1, Math.min(1000, Math.trunc(limit))))
      .getMany()
  }

  private async findWalletForUpdate(manager: EntityManager, organizationId: string): Promise<Wallet> {
    const walletRepository = manager.getRepository(Wallet)
    let wallet = await walletRepository.findOne({
      where: { organizationId },
      lock: { mode: 'pessimistic_write' },
    })

    if (!wallet) {
      const organization = await manager.getRepository(Organization).findOne({
        where: { id: organizationId },
        lock: { mode: 'pessimistic_write' },
      })
      if (!organization) {
        throw new NotFoundException(`organization ${organizationId} not found`)
      }

      wallet = await walletRepository.findOne({
        where: { organizationId },
        lock: { mode: 'pessimistic_write' },
      })
      if (!wallet) {
        wallet = await this.createWallet(manager, organizationId)
      }
    }

    await this.expireFreeBalance(manager, wallet)
    return wallet
  }

  private async createWallet(manager: EntityManager, organizationId: string): Promise<Wallet> {
    const walletRepository = manager.getRepository(Wallet)
    const grantCents = this.configService.get('billing.trialGrantCents')
    const durationDays = this.configService.get('billing.trialDurationDays')
    if (!Number.isSafeInteger(grantCents) || grantCents < 0) {
      throw new Error('billing trial grant cents must be a non-negative safe integer')
    }
    if (!Number.isSafeInteger(durationDays) || durationDays <= 0) {
      throw new Error('billing trial duration days must be a positive safe integer')
    }

    const wallet = await walletRepository.save(
      walletRepository.create({
        organizationId,
        freeBalanceCents: String(grantCents),
        paidBalanceCents: '0',
        settlementRemainderCents: '0',
        freeExpiresAt: grantCents > 0 ? new Date(Date.now() + durationDays * DAY_MILLISECONDS) : null,
        billingStatus: grantCents > 0 ? 'trial' : 'zero_balance',
      }),
    )

    if (grantCents > 0) {
      const transactionRepository = manager.getRepository(WalletTransaction)
      await transactionRepository.save(
        transactionRepository.create({
          walletId: wallet.id,
          organizationId,
          kind: 'free_grant',
          amountCents: String(grantCents),
          source: 'default_trial_grant',
          ratedPeriodId: null,
          metadata: { expiresAt: wallet.freeExpiresAt?.toISOString() },
        }),
      )
    }

    return wallet
  }

  private async expireFreeBalance(manager: EntityManager, wallet: Wallet): Promise<void> {
    if (!wallet.freeExpiresAt || wallet.freeExpiresAt.getTime() > Date.now()) {
      return
    }

    const expiredCents = nonNegativeBigInt(wallet.freeBalanceCents)
    if (expiredCents === 0n) {
      return
    }

    wallet.freeBalanceCents = '0'
    wallet.billingStatus = this.statusForWallet(wallet)
    await manager.getRepository(Wallet).save(wallet)
    const transactionRepository = manager.getRepository(WalletTransaction)
    await transactionRepository.save(
      transactionRepository.create({
        walletId: wallet.id,
        organizationId: wallet.organizationId,
        kind: 'adjustment',
        amountCents: (-expiredCents).toString(),
        source: 'trial_expired',
        ratedPeriodId: null,
        metadata: { expiredAt: wallet.freeExpiresAt.toISOString() },
      }),
    )
  }

  private statusForWallet(wallet: Wallet): BillingStatus {
    if (BigInt(wallet.freeBalanceCents) + BigInt(wallet.paidBalanceCents) <= 0n) {
      return 'zero_balance'
    }
    return BigInt(wallet.freeBalanceCents) > 0n ? 'trial' : 'active'
  }
}
